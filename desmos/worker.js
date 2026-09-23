// This file is run as a Cloudflare Worker and handles the proxy (https://cootshk.dev/_/desmos/... => https://www.desmos.com/...)
//
// Everything the proxy owns lives under /_/ :
//   /_/<key>/<path>         - the site's main host, e.g. /_/desmos/calculator
//   /_/_<key>/<sub>/<path>  - a subdomain of it, e.g. /_/_desmos/blog -> blog.desmos.com
// SITES below is the whole routing table; add a key there to proxy another site.
//
// Deploy with a route of `cootshk.dev/_/*` (plus `cootshk.dev/*` if you want the
// referer-based fallback for stray root-relative subresource requests).
//
// How it works:
//   1. Server side, every text response (html/js/css/json/svg) has absolute URLs pointing at
//      a known site rewritten to /_/<key>/... , and HTML root-relative attributes get the
//      prefix of the site the response came from prepended.
//   2. Client side, a bootstrap script is injected at the very top of <head>. It patches
//      fetch / Request / XMLHttpRequest / Worker / SharedWorker / WebSocket / EventSource /
//      sendBeacon / importScripts / history / element src+href setters so that URLs built at
//      runtime (Desmos eval()s and blob-Workers a lot of its code) keep the prefix.
//      Blob Workers get the bootstrap source prepended to their body so the patches apply
//      inside the worker scope too. The bootstrap is served per prefix, at
//      <prefix>/_proxy/bootstrap.js, so a page under /_/_desmos/blog stays on that prefix.

const ROOT = "/_"; // no trailing slash
const SUB_MARK = "_"; // /_/_<key>/<sub> selects a subdomain of <key>
const BOOTSTRAP_SUFFIX = "/_proxy/bootstrap.js";

// Identifies this proxy to upstreams that want a name - GitHub's API rejects requests that
// send no User-Agent at all. Sites override it per entry with `ua`.
const PROXY_UA = "Cootshk.dev-Proxy";

// Hosts we are willing to proxy. Everything else is left untouched - this is an allow-list,
// and the point of it is that the route must not become an open proxy.
//
// Per site:
//   host       what a bare /_/<key> maps to.
//   domain     the apex every proxyable subdomain must sit under. Defaults to `host`
//              without its leading `www.`; set it when the main host is not itself under
//              the apex you want to allow.
//   ua         User-Agent sent upstream for this site. Omit to forward the client's own.
//   allowPath  regexes (or regex sources) matched against the upstream path - a request
//              matching none of them is not proxied at all. Omit to allow the whole site.
const SITES = defineSites({
  desmos: { host: "www.desmos.com" },
  // Release zips (DesModder, see desmos/extensions/) and the API that names the newest tag,
  // at /_/github/<owner>/<repo>/releases/download/... and /_/_github/api/repos/... .
  github: {
    host: "github.com",
    ua: PROXY_UA, // the API rejects requests that send no User-Agent
    // Releases and nothing else, for now - the rest of GitHub has no reason to be reachable
    // through here yet. This will likely come off once something else needs it; the entry
    // matters, the restriction does not. The two patterns are github.com and api.github.com
    // respectively: allowPath belongs to the site, so it is matched on every host under it.
    allowPath: [/^\/[\w.-]+\/[\w.-]+\/releases\//, /^\/repos\/[\w.-]+\/[\w.-]+\/releases(?:\/|$)/],
  },
  // Where a release download redirects to, and where raw files live. The zips serve no CORS
  // headers of their own, which is the whole reason any of this goes through the proxy.
  // objects. and release-assets. arrive as /_/_githubusercontent/<label>/... .
  githubusercontent: { host: "raw.githubusercontent.com", domain: "githubusercontent.com" },
});

// A subdomain segment: `blog`, or `cdn.assets`, or the full host when it already ends in the
// site's domain (which is how the apex itself is addressed: /_/_desmos/desmos.com).
const SUB_SEGMENT = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/** Fill in the derived fields of the SITES table, and reject a table that cannot route. */
function defineSites(sites) {
  for (const [key, site] of Object.entries(sites)) {
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`proxy site key ${JSON.stringify(key)} is malformed`);
    site.key = key;
    site.host = site.host.toLowerCase();
    site.domain = (site.domain || site.host.replace(/^www\./, "")).toLowerCase();
    site.prefix = ROOT + "/" + key; // /_/desmos
    site.subPrefix = ROOT + "/" + SUB_MARK + key; // /_/_desmos
    site.ua = site.ua || null;
    site.allowPath = site.allowPath
      ? site.allowPath.map((pattern) => (pattern instanceof RegExp ? pattern : new RegExp(pattern)))
      : null;
  }
  return sites;
}

/** Whether a site is willing to serve this upstream path (the query is not considered). */
function pathAllowed(site, pathname) {
  return !site.allowPath || site.allowPath.some((pattern) => pattern.test(pathname));
}

// Desmos ships hashed assets with Cache-Control: max-age=315360000 (ten years). Passing that
// through means a browser pins whatever this Worker rewrote at the time and never asks again,
// so any later fix to the rewriting silently fails to reach it. Bodies we rewrite therefore
// get a capped lifetime and a version-tagged ETag; bump REWRITE_VERSION whenever the rewriting
// logic changes and every cached copy revalidates into the new output. Untouched responses
// (fonts, images) keep their original headers.
const REWRITE_VERSION = "1";
const REWRITTEN_MAX_AGE = 3600;
const ETAG_TAG = "-dp" + REWRITE_VERSION;

const REWRITABLE = /^(?:text\/html|text\/css|text\/javascript|application\/javascript|application\/x-javascript|application\/ecmascript|text\/ecmascript|application\/json|application\/manifest\+json|image\/svg\+xml|text\/plain)/i;
const IS_JS = /^(?:text\/javascript|application\/javascript|application\/x-javascript|application\/ecmascript|text\/ecmascript)/i;

// Headers that must not be copied through, either because they describe the upstream
// transfer (CF already decoded it) or because they would block framing/rewritten assets.
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "report-to",
  "nel",
  "expect-ct",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "alt-svc",
]);

const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-proto",
  "x-real-ip",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.endsWith(BOOTSTRAP_SUFFIX)) {
      const owner = parsePath(url.pathname.slice(0, -BOOTSTRAP_SUFFIX.length));
      if (owner && owner.rest === "/") {
        return new Response(buildBootstrap(url.origin, owner.prefix), {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        });
      }
    }

    const route = resolveTarget(url);
    if (!route) return fallback(request, url, env);

    return proxy(request, url, route);
  },
};

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * Split a proxy pathname into the site it names, the upstream host, the prefix everything
 * on that page has to keep, and the remaining upstream path. Null if it is not ours.
 */
function parsePath(pathname) {
  if (pathname !== ROOT && !pathname.startsWith(ROOT + "/")) return null;

  const segments = pathname.slice(ROOT.length + 1).split("/");
  let key = segments[0] || "";
  let sub = null;
  let used = 1;

  if (key.startsWith(SUB_MARK)) {
    key = key.slice(SUB_MARK.length);
    sub = (segments[1] || "").toLowerCase();
    used = 2;
    if (!SUB_SEGMENT.test(sub)) return null;
  }

  const site = SITES[key];
  if (!site) return null;

  // A segment that already ends in the site's domain is the host itself (so the apex is
  // reachable as /_/_desmos/desmos.com); anything else is a label below that domain, which
  // is what keeps this from proxying an arbitrary host.
  const host =
    sub === null
      ? site.host
      : sub === site.domain || sub.endsWith("." + site.domain)
        ? sub
        : sub + "." + site.domain;

  return {
    site,
    host,
    prefix: sub === null ? site.prefix : site.subPrefix + "/" + sub,
    rest: "/" + segments.slice(used).join("/"),
  };
}

/** Map an incoming proxy URL onto the upstream URL it stands for, or null. */
function resolveTarget(url) {
  const route = parsePath(url.pathname);
  if (!route || !pathAllowed(route.site, route.rest)) return null;
  route.url = new URL("https://" + route.host + route.rest + url.search);
  return route;
}

/** The proxy path prefix an upstream host is served under, or null if we do not proxy it. */
function hostPrefix(host) {
  host = host.toLowerCase();
  for (const site of Object.values(SITES)) {
    if (host === site.host) return site.prefix;
    if (host === site.domain) return site.subPrefix + "/" + host;
    if (host.endsWith("." + site.domain)) {
      return site.subPrefix + "/" + host.slice(0, -(site.domain.length + 1));
    }
  }
  return null;
}

/**
 * Requests that escaped the prefix (a root-relative URL the parser fetched before our
 * patches ran) still carry a Referer pointing inside the proxy - bounce those back in,
 * onto the prefix the referring page is on.
 */
function fallback(request, url, env) {
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const ref = new URL(referer);
      const from = ref.origin === url.origin ? parsePath(ref.pathname) : null;
      if (from) {
        return Response.redirect(url.origin + from.prefix + url.pathname + url.search, 307);
      }
    } catch (_) {}
  }
  // Not ours: hand back to the zone's normal origin / static assets.
  if (env && env.ASSETS) return env.ASSETS.fetch(request);
  return fetch(request);
}

// ---------------------------------------------------------------------------
// proxying
// ---------------------------------------------------------------------------

async function proxy(request, url, route) {
  const target = route.url;
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(key)) continue;
    if (key === "origin") { headers.set("origin", target.origin); continue; }
    if (key === "referer") { headers.set("referer", unproxyUrl(value, url.origin) || target.origin + "/"); continue; }
    if (key === "if-none-match") { headers.set("if-none-match", value.replace(/-dp\d+"/g, '"')); continue; }
    if (key === "accept-encoding") continue; // let the runtime negotiate
    headers.set(name, value);
  }
  headers.set("accept-encoding", "gzip");
  if (route.site.ua) headers.set("user-agent", route.site.ua);

  const upstream = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });

  const out = new Headers();
  for (const [name, value] of upstream.headers) {
    if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === "set-cookie") continue; // handled below
    out.set(name, value);
  }

  for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
    out.append("set-cookie", rewriteCookie(cookie, route.prefix));
  }

  // Keeps the full path on same-origin subrequests (so the referer fallback can fire)
  // without leaking anything to third parties.
  out.set("referrer-policy", "same-origin");

  const location = upstream.headers.get("location");
  if (location) {
    out.set("location", rewriteText(new URL(location, target).toString(), url.origin));
  }

  const type = upstream.headers.get("content-type") || "";
  if (!REWRITABLE.test(type) || upstream.status === 204 || upstream.status === 304) {
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  }

  out.set("cache-control", capCacheControl(out.get("cache-control"), REWRITTEN_MAX_AGE));
  const etag = out.get("etag");
  if (etag) out.set("etag", etag.replace(/"\s*$/, ETAG_TAG + '"'));

  let body = await upstream.text();
  body = rewriteText(body, url.origin);
  if (/^text\/html/i.test(type)) body = rewriteHtml(body, url.origin, route.prefix);
  else if (/^text\/css/i.test(type)) body = rewriteCss(body, route.prefix);
  else if (IS_JS.test(type)) body = rewriteCssInJs(body, route.prefix);

  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

/** Lower an upstream max-age to `seconds`, and drop `immutable` so reloads can revalidate. */
function capCacheControl(value, seconds) {
  if (!value) return "public, max-age=" + seconds;
  const cleaned = value.replace(/\s*,?\s*\bimmutable\b/gi, "");
  if (/\b(?:no-store|no-cache)\b/i.test(cleaned)) return cleaned;
  if (/\bmax-age\s*=/i.test(cleaned)) {
    return cleaned.replace(/\bmax-age\s*=\s*(\d+)/gi, (m, n) => "max-age=" + Math.min(Number(n), seconds));
  }
  return cleaned + ", max-age=" + seconds;
}

/** Re-home a cookie onto our own origin and scope it to the prefix it came from. */
function rewriteCookie(cookie, prefix) {
  return cookie
    .split(/;\s*/)
    .filter((part) => !/^domain=/i.test(part))
    .map((part) => (/^path=/i.test(part) ? "Path=" + prefix + part.slice(5).replace(/^\/?/, "/") : part))
    .join("; ");
}

/** Turn a proxied URL back into the upstream one (used for the outgoing Referer). */
function unproxyUrl(value, origin) {
  try {
    const u = new URL(value, origin);
    if (u.origin !== origin) return null;
    const route = resolveTarget(u);
    return route ? route.url.toString() : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// content rewriting
// ---------------------------------------------------------------------------

// Matches `https://www.example.com`, `//www.example.com`, `wss://www.example.com` and the
// backslash-escaped `https:\/\/www.example.com` form that shows up inside JSON and JS strings.
// Any host shaped like a domain is matched; hostPrefix() decides which ones we actually own.
const URL_RE = /(?<![\w:])(?:(https?|wss?):)?(\\?\/\\?\/)((?:[a-z0-9-]+\.)+[a-z]{2,63})/gi;

// A root-relative path that is not `//host` and not already inside the proxy.
const ROOT_RELATIVE = "/(?!/|_/)";

function rewriteText(text, origin) {
  const secure = origin.startsWith("https:");
  const authority = origin.replace(/^https?:/, "").replace(/^\/\//, ""); // e.g. cootshk.dev

  return text.replace(URL_RE, (match, scheme, slashes, host) => {
    const prefix = hostPrefix(host);
    if (!prefix) return match;

    const escaped = slashes.includes("\\");
    const sl = escaped ? "\\/" : "/";
    const path = prefix.split("/").join(sl);

    let proto = "";
    if (scheme === "ws" || scheme === "wss") proto = secure ? "wss:" : "ws:";
    else if (scheme) proto = secure ? "https:" : "http:";

    return proto + sl + sl + authority + path;
  });
}

/**
 * Root-relative `url(/assets/...)` and `@import "/..."` in stylesheets. The browser resolves
 * these against the stylesheet's own URL, so nothing client side ever sees them - they have
 * to be fixed here or the request lands on the bare origin (e.g. the dcg-icons woff2).
 */
function rewriteCss(css, prefix) {
  return css
    .replace(new RegExp("url\\(\\s*([\"']?)" + ROOT_RELATIVE, "gi"), "url($1" + prefix + "/")
    .replace(new RegExp("@import\\s+([\"'])" + ROOT_RELATIVE, "gi"), "@import $1" + prefix + "/");
}

// Same idea for CSS that webpack's style-loader carries inside JS bundles. Deliberately
// stricter than rewriteCss: requiring a file extension keeps it off regex literals like
// `url(/foo/.test(x))`, which a bare `url(/` would happily corrupt.
function rewriteCssInJs(js, prefix) {
  return js.replace(
    /url\(\s*(\\?["']?)(\/(?!\/|_\/)[A-Za-z0-9_\-.\/~%+]*\.[A-Za-z0-9]{2,8}(?:\?[^)"'\s]*)?)\1\s*\)/g,
    (m, quote, path) => "url(" + quote + prefix + path + quote + ")"
  );
}

function rewriteHtml(html, origin, prefix) {
  return (
    html
      // Root-relative URLs in markup are fetched by the parser before our patches can run,
      // so they have to be fixed up here.
      .replace(
        new RegExp("(\\s(?:src|href|action|poster|data-src|formaction)\\s*=\\s*)([\"'])" + ROOT_RELATIVE, "gi"),
        "$1$2" + prefix + "/"
      )
      .replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (m, lead, q, list) =>
        lead + q + list.replace(/(^|,\s*)\/(?!\/|_\/)/g, "$1" + prefix + "/") + q
      )
      // Inline stylesheets need the same url() treatment as external ones.
      .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => open + rewriteCss(css, prefix) + close)
      .replace(/(\sstyle\s*=\s*)(["'])([^"']*)\2/gi, (m, lead, q, css) => lead + q + rewriteCss(css, prefix) + q)
      // Our rewrites invalidate any subresource-integrity hashes.
      .replace(/\sintegrity\s*=\s*(["'])[^"']*\1/gi, "")
      .replace(/\snonce\s*=\s*(["'])[^"']*\1/gi, "")
      // Inject the bootstrap as the first thing in the document.
      .replace(
        /<head([^>]*)>/i,
        (m) => m + '<script src="' + origin + prefix + BOOTSTRAP_SUFFIX + '"></script>'
      )
  );
}

// ---------------------------------------------------------------------------
// client-side bootstrap
// ---------------------------------------------------------------------------

const bootstrapCache = new Map();

function buildBootstrap(origin, prefix) {
  const cacheKey = origin + prefix;
  let src = bootstrapCache.get(cacheKey);
  if (!src) {
    const cfg = {
      root: ROOT,
      prefix,
      origin,
      bootstrap: origin + prefix + BOOTSTRAP_SUFFIX,
      // The whole routing table, so a URL to any proxied host - not just this page's -
      // lands on the right prefix.
      sites: Object.values(SITES).map((site) => ({
        host: site.host,
        domain: site.domain,
        prefix: site.prefix,
        subPrefix: site.subPrefix,
      })),
    };
    // clientBootstrap is serialized with toString() and executed in the BROWSER, so it must
    // survive any bundler that processed this file. esbuild (which wrangler runs with
    // keepNames) rewrites nested declarations to `function f() {} __name(f, "f");`, and that
    // helper only exists inside the Worker bundle - shipping it unshimmed throws
    // "__name is not defined" on load. no_bundle = true in wrangler.toml avoids the rewrite
    // at the source; this shim keeps the output correct if it is ever deployed through a
    // bundling path anyway. The `var` hoists, so the self-reference is undefined, not a throw.
    src =
      "var __name = __name || function (t) { return t; };\n" +
      "(" + clientBootstrap.toString() + ")(" + JSON.stringify(cfg) + ");\n";
    bootstrapCache.set(cacheKey, src);
  }
  return src;
}

/**
 * Serialized with Function.prototype.toString and served at <prefix>/_proxy/bootstrap.js, so
 * it must be completely self-contained - no references to anything in this module's scope.
 *
 * Runs in both window and (Dedicated/Shared)WorkerGlobalScope.
 */
function clientBootstrap(cfg) {
  var g = typeof self !== "undefined" ? self : this;
  if (g.__desmosProxyInstalled) return;
  g.__desmosProxyInstalled = true;

  var ROOT = cfg.root;
  var PREFIX = cfg.prefix;
  var ORIGIN = cfg.origin;
  var SITES = cfg.sites;
  var BOOT_URL = cfg.bootstrap;
  var BASE = ORIGIN + PREFIX + "/";
  var SECURE = ORIGIN.slice(0, 6) === "https:";
  var AUTHORITY = ORIGIN.replace(/^https?:\/\//, "");

  var isWorker =
    typeof WorkerGlobalScope !== "undefined" && typeof g.importScripts === "function";

  var _XHR = g.XMLHttpRequest;

  function base() {
    if (!isWorker && typeof document !== "undefined" && document.baseURI) return document.baseURI;
    return BASE;
  }

  /** The prefix an upstream host is proxied under, or null if it is not one of ours. */
  function hostPrefix(host) {
    host = String(host).toLowerCase();
    for (var i = 0; i < SITES.length; i++) {
      var site = SITES[i];
      if (host === site.host) return site.prefix;
      if (host === site.domain) return site.subPrefix + "/" + host;
      if (host.slice(-(site.domain.length + 1)) === "." + site.domain) {
        return site.subPrefix + "/" + host.slice(0, -(site.domain.length + 1));
      }
    }
    return null;
  }

  function proxied(u, prefix) {
    var ws = u.protocol === "ws:" || u.protocol === "wss:";
    var proto = ws ? (SECURE ? "wss:" : "ws:") : SECURE ? "https:" : "http:";
    return proto + "//" + AUTHORITY + prefix + u.pathname + u.search + u.hash;
  }

  // The one function everything below funnels through.
  function rw(input) {
    try {
      if (input === null || input === undefined) return input;
      if (typeof URL !== "undefined" && input instanceof URL) input = input.href;
      var u = String(input);
      if (u === "" || u.charAt(0) === "#") return input;
      if (/^(?:blob:|data:|about:|javascript:|mailto:|tel:|filesystem:)/i.test(u)) return input;

      var abs = new URL(u, base());

      if (abs.origin === ORIGIN) {
        // Already inside the proxy (any prefix)? Leave it. Otherwise it is a
        // root-relative path that resolved against our own origin and needs this page's
        // prefix put back on.
        if (abs.pathname === ROOT || abs.pathname.indexOf(ROOT + "/") === 0) return input;
        return ORIGIN + PREFIX + abs.pathname + abs.search + abs.hash;
      }
      var prefix = hostPrefix(abs.hostname);
      if (prefix) return proxied(abs, prefix);
      return input;
    } catch (e) {
      return input;
    }
  }

  g.__desmosProxyRewrite = rw;

  function wrapConstructor(name, rewriteArgs) {
    var C = g[name];
    if (typeof C !== "function") return;
    g[name] = new Proxy(C, {
      construct: function (Target, args, newTarget) {
        try {
          args = rewriteArgs(args) || args;
        } catch (e) {}
        return Reflect.construct(Target, args, newTarget === g[name] ? Target : newTarget);
      },
    });
  }

  // --- fetch / Request -----------------------------------------------------
  var _Request = g.Request;

  if (typeof g.fetch === "function") {
    var _fetch = g.fetch;
    g.fetch = function (input, init) {
      try {
        if (_Request && input instanceof _Request) {
          var next = rw(input.url);
          if (next !== input.url) input = new _Request(next, input);
        } else {
          input = rw(input);
        }
      } catch (e) {}
      return _fetch.call(this, input, init);
    };
  }

  wrapConstructor("Request", function (args) {
    if (args.length && (typeof args[0] === "string" || (typeof URL !== "undefined" && args[0] instanceof URL))) {
      args[0] = rw(args[0]);
    } else if (args.length && _Request && args[0] instanceof _Request) {
      var next = rw(args[0].url);
      if (next !== args[0].url) args[0] = new _Request(next, args[0]);
    }
    return args;
  });

  // --- XHR -----------------------------------------------------------------
  if (_XHR && _XHR.prototype && _XHR.prototype.open) {
    var _open = _XHR.prototype.open;
    _XHR.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (args.length > 1) args[1] = rw(args[1]);
      return _open.apply(this, args);
    };
  }

  // --- sockets / beacons ---------------------------------------------------
  ["WebSocket", "EventSource"].forEach(function (name) {
    wrapConstructor(name, function (args) {
      if (args.length) args[0] = rw(args[0]);
      return args;
    });
  });

  if (g.navigator && typeof g.navigator.sendBeacon === "function") {
    var _beacon = g.navigator.sendBeacon.bind(g.navigator);
    g.navigator.sendBeacon = function (url, data) {
      return _beacon(rw(url), data);
    };
  }

  // --- Workers -------------------------------------------------------------
  // Desmos hands blob: URLs to `new Worker(...)`; splice our own source in front of the
  // blob body so fetch/importScripts are patched inside the worker too.
  var bootSource = null;

  function readSync(url) {
    var xhr = new _XHR();
    xhr.open("GET", url, false);
    xhr.send();
    return xhr.responseText;
  }

  function boot() {
    if (bootSource === null) {
      try {
        bootSource = readSync(BOOT_URL);
      } catch (e) {
        bootSource = "";
      }
    }
    return bootSource;
  }

  ["Worker", "SharedWorker"].forEach(function (name) {
    wrapConstructor(name, function (args) {
      var url = args[0];
      var isModule = args[1] && args[1].type === "module";
      var body;

      if (typeof url === "string" && url.slice(0, 5) === "blob:") {
        body = boot() + "\n;\n" + readSync(url);
      } else {
        var real = rw(url);
        body = isModule
          ? boot() + "\nawait import(" + JSON.stringify(String(real)) + ");\n"
          : boot() + "\nimportScripts(" + JSON.stringify(String(real)) + ");\n";
      }

      args[0] = URL.createObjectURL(new Blob([body], { type: "text/javascript" }));
      return args;
    });
  });

  if (isWorker && typeof g.importScripts === "function") {
    var _importScripts = g.importScripts;
    g.importScripts = function () {
      return _importScripts.apply(g, Array.prototype.map.call(arguments, rw));
    };
  }

  if (isWorker) return; // everything below is document-only

  // --- service workers -----------------------------------------------------
  // A service worker would install its own unprefixed routing; not worth the trouble.
  if (g.navigator && g.navigator.serviceWorker && g.navigator.serviceWorker.register) {
    g.navigator.serviceWorker.register = function () {
      return Promise.reject(new Error("service workers are disabled behind the desmos proxy"));
    };
  }

  // --- navigation ----------------------------------------------------------
  if (g.history) {
    ["pushState", "replaceState"].forEach(function (method) {
      var original = g.history[method];
      if (typeof original !== "function") return;
      g.history[method] = function (state, title, url) {
        if (arguments.length < 3 || url === null || url === undefined) {
          return original.call(g.history, state, title);
        }
        return original.call(g.history, state, title, rw(url));
      };
    });
  }

  if (typeof g.open === "function") {
    var _windowOpen = g.open;
    g.open = function () {
      var args = Array.prototype.slice.call(arguments);
      if (args.length) args[0] = rw(args[0]);
      return _windowOpen.apply(g, args);
    };
  }

  // --- element URL properties ---------------------------------------------
  [
    ["HTMLScriptElement", "src"],
    ["HTMLImageElement", "src"],
    ["HTMLLinkElement", "href"],
    ["HTMLIFrameElement", "src"],
    ["HTMLSourceElement", "src"],
    ["HTMLMediaElement", "src"],
    ["HTMLEmbedElement", "src"],
    ["HTMLTrackElement", "src"],
    ["HTMLObjectElement", "data"],
    ["HTMLAnchorElement", "href"],
    ["HTMLFormElement", "action"],
    ["HTMLBaseElement", "href"],
  ].forEach(function (pair) {
    var C = g[pair[0]];
    var key = pair[1];
    if (!C || !C.prototype) return;
    var desc = Object.getOwnPropertyDescriptor(C.prototype, key);
    if (!desc || !desc.set || !desc.configurable) return;
    Object.defineProperty(C.prototype, key, {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        return desc.get.call(this);
      },
      set: function (value) {
        desc.set.call(this, rw(value));
      },
    });
  });

  if (g.Element && g.Element.prototype.setAttribute) {
    var URL_ATTRS = { src: 1, href: 1, action: 1, data: 1, poster: 1, formaction: 1 };
    var _setAttribute = g.Element.prototype.setAttribute;
    g.Element.prototype.setAttribute = function (name, value) {
      if (name && URL_ATTRS[String(name).toLowerCase()]) value = rw(value);
      return _setAttribute.call(this, name, value);
    };
  }
}
