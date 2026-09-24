// Boots the proxied Desmos app (see worker.js) inside #desmos, with extensions.
//
// The frame is deliberately not just pointed at the proxy with a src: extensions have to
// run before any of Desmos' own bundles do, and an ordinary iframe load offers no point at
// which to get in first. So the page is fetched here, its build script is held back, what
// is left is written into the frame, the extensions run, and only then does Desmos start.
//
// See extensions.js for the hooks an extension can implement, and ui.js for what they draw
// with.

const PROXY = "/_/desmos";

// ?type=... -> where the app lives upstream. `key` is the name extensions.json uses.
const MODES = {
  graphing: { key: "graphing", path: "calculator", title: "Graphing Calculator" },
  "3d": { key: "3d", path: "3d", title: "3D Calculator" },
  geometry: { key: "geometry", path: "geometry", title: "Geometry" },
  matrix: { key: "matrix", path: "matrix", title: "Matrix Calculator" },
  scientific: { key: "scientific", path: "scientific", title: "Scientific Calculator" },
};

const ALIASES = {
  calculator: "graphing",
  calc: "graphing",
  graph: "graphing",
  three: "3d",
  "3": "3d",
  geo: "geometry",
  matrices: "matrix",
  sci: "scientific",
};

const DEFAULT_MODE = "graphing";

// <script src="*/assets/build/*.js"> - Desmos' own bundle.
const BUILD_SCRIPT = /\/assets\/build\/[^?#]*\.js(?:[?#]|$)/i;

// A type the browser will not execute. The tag stays in the document because DesModder
// finds the bundle by querying for it, and polls forever if it is not there.
const HELD_TYPE = "text/x-desmos-held";

// How long to give an extension that owns the bundle before starting Desmos ourselves.
const BUNDLE_TIMEOUT = 10000;

/** Any of a mode's names - a ?type= value, an alias, or its upstream path - as a MODES key. */
function canonicalMode(name) {
  const raw = String(name ?? "").trim().toLowerCase();
  const key = ALIASES[raw] || raw;
  if (MODES[key]) return key;
  return Object.keys(MODES).find((k) => MODES[k].path === raw) || null;
}

/** The mode named by ?type=, falling back to the graphing calculator. */
function currentMode() {
  return MODES[canonicalMode(new URLSearchParams(location.search).get("type")) || DEFAULT_MODE];
}

/** The #fragment, which is the graph ID (`#abcdef1234`), if there is one. */
function currentGraph() {
  const raw = location.hash.replace(/^#\/?/, "");
  try {
    return decodeURIComponent(raw).trim();
  } catch (_) {
    return raw.trim(); // stray % - take it literally rather than throwing the load away
  }
}

function sourceUrl(mode, graph) {
  const path = graph ? PROXY + "/" + mode.path + "/" + encodeURIComponent(graph) : PROXY + "/" + mode.path;
  return new URL(path, location.origin).toString();
}

/** The path Desmos itself would be served at, which is what it expects to read back. */
function framePath(mode, graph) {
  return "/" + mode.path + (graph ? "/" + encodeURIComponent(graph) : "");
}

// Object URLs belonging to the current load, handed out through ctx.blob() and released
// when the next load starts (the frame may still be reading them until then).
let blobs = [];

function makeBlob(text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  blobs.push(url);
  return url;
}

function releaseBlobs() {
  for (const url of blobs) URL.revokeObjectURL(url);
  blobs = [];
}

// ---------------------------------------------------------------------------
// frame preamble
// ---------------------------------------------------------------------------

/**
 * The first thing to run inside the frame, before any extension or Desmos itself.
 * Serialized with Function.prototype.toString, so it must not reference anything out here.
 */
function preamble(cfg) {
  var g = window;
  var hooks = [];
  var calc;

  // History.prototype holds the unpatched methods; the proxy bootstrap wraps the ones on
  // the history instance and would put /_/desmos straight back on everything below.
  var replace = g.History.prototype.replaceState;

  // Desmos reads the graph ID out of location.pathname, which in this frame is "blank" -
  // the document is about:blank. Give it the path it would have seen on desmos.com.
  // Subresources are unaffected: they resolve against <base href>, which stays on the proxy.
  if (cfg.path) {
    try {
      replace.call(g.history, null, "", cfg.path);
    } catch (e) {
      console.warn("desmos: could not set the frame path; graphs may not open by ID", e);
    }
  }

  // Keep it that way as Desmos rewrites the URL opening and saving graphs, and tell the
  // page above so it can mirror the graph ID into its own #fragment.
  ["pushState", "replaceState"].forEach(function (name) {
    var original = g.History.prototype[name];
    g.history[name] = function (state, title, url) {
      if (arguments.length < 3 || url === null || url === undefined) {
        return original.call(g.history, state, title);
      }
      var next = url;
      try {
        var abs = new URL(String(url), g.location.href);
        if (abs.origin === cfg.origin && abs.pathname.indexOf(cfg.prefix + "/") === 0) {
          next = abs.pathname.slice(cfg.prefix.length) + abs.search + abs.hash;
        }
      } catch (e) {}
      var result = original.call(g.history, state, title, next);
      // "*" rather than the origin: an about:blank document whose replaceState above did
      // not take reports a null origin. The only window this reaches is the page holding
      // the frame, which checks event.source, and a path is not a secret.
      try {
        g.parent.postMessage({ __desmos: "path", path: g.location.pathname }, "*");
      } catch (e) {}
      return result;
    };
  });

  // Extensions that rewrite the bundle hand us a blob of the patched source. DesModder
  // re-fetches the bundle by URL, so point that fetch at the patched copy instead. Matching
  // on the path alone: it appends a "?" to the URL to dodge its own blocking rules.
  if (cfg.bundle && cfg.buildPath) {
    var fetched = g.fetch;
    g.fetch = function (input, init) {
      try {
        var url = String(input && input.url !== undefined ? input.url : input);
        if (new URL(url, g.document.baseURI).pathname === cfg.buildPath) {
          return fetched.call(this, cfg.bundle, init);
        }
      } catch (e) {}
      return fetched.call(this, input, init);
    };
  }

  // window.Calc is a plain assignment inside the bundle, so a setter beats polling for it.
  Object.defineProperty(g, "Calc", {
    configurable: true,
    enumerable: true,
    get: function () {
      return calc;
    },
    set: function (value) {
      calc = value;
      var pending = hooks;
      hooks = null;
      // The assignment happens in the middle of Desmos' own startup, so get out of its
      // stack before running anything: a slow hook here stalls initialization.
      if (pending) pending.forEach(function (hook) {
        (g.queueMicrotask || setTimeout)(function () { run(hook.fn, hook.data); });
      });
    },
  });

  function run(fn, data) {
    try {
      fn(calc, data);
    } catch (error) {
      console.error("desmos: extension ready hook failed", error);
    }
  }

  g.__desmosExt = {
    onCalc: function (fn, data) {
      if (hooks) hooks.push({ fn: fn, data: data });
      else run(fn, data);
    },
  };
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

/** Resolves once `doc` has finished parsing (and so has run its inline/blocking scripts). */
function parsed(doc) {
  if (doc.readyState !== "loading") return Promise.resolve();
  return new Promise((resolve) => doc.addEventListener("DOMContentLoaded", resolve, { once: true }));
}

/** Swap in a frame holding `html`, resolving once its document has been parsed. */
async function write(html) {
  // A fresh element rather than a second document.open(), so a reload cannot inherit
  // the timers, workers and globals a previous Desmos left running in that window.
  const stale = $("#desmos");
  const frame = stale.cloneNode(false);
  stale.replaceWith(frame);

  const doc = frame.contentDocument; // srcless iframe: its about:blank is there already
  doc.open();
  doc.write(html);
  doc.close();
  await parsed(doc);
  return doc;
}

function inject(doc, code) {
  const script = doc.createElement("script");
  script.textContent = code;
  (doc.head || doc.documentElement).appendChild(script);
}

/**
 * A function's source, as something that parses as an expression. Written as object method
 * shorthand - `main(data) {}`, which is the natural way to write one of these - toString()
 * gives back text that is only valid inside an object literal, so put it back in one.
 */
function asExpression(fn, key) {
  const src = fn.toString().trim();
  const standalone =
    /^(?:async\s+)?(?:function\b|\()/.test(src) || /^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(src);
  return standalone ? `(${src})` : `({ ${src} }).${key}`;
}

/** Run one hook. An extension that throws is dropped for the rest of this load. */
async function guard(entry, fn) {
  if (entry.failed) return undefined;
  try {
    return await fn();
  } catch (error) {
    entry.failed = true;
    console.error(`desmos: extension "${entry.def.id}" failed`, error);
    return undefined;
  }
}

/** Apply the source hooks to Desmos' bundle; null when nothing wanted to patch it. */
async function patchBundle(buildUrl, active, context) {
  const patchers = active.filter((entry) => entry.def.source);
  if (!buildUrl || !patchers.length) return null;

  const res = await fetch(buildUrl);
  if (!res.ok) throw new Error(`${buildUrl} -> ${res.status} ${res.statusText}`);

  // Desmos builds its worker from a string inside this file, so one text pass covers both.
  let text = await res.text();
  for (const entry of patchers) {
    const next = await guard(entry, () => entry.def.source(text, context(entry)));
    if (typeof next === "string") text = next;
  }
  return makeBlob(text, "text/javascript");
}

/** Start Desmos: `src` is our patched blob, or the original URL when nothing patched it. */
function runBundle(doc, src, original) {
  const script = doc.createElement("script");
  if (original) {
    for (const { name, value } of original.attributes) {
      if (name === "src" || name === "type") continue;
      script.setAttribute(name, value);
    }
  }
  script.async = false; // dynamically inserted scripts would otherwise run out of order
  script.src = src;
  (doc.head || doc.documentElement).appendChild(script);
}

/**
 * An extension that owns the bundle can still fail after we have handed off - a throw
 * inside DesModder's own preload is not catchable from here. Rather than leave the user
 * with a blank frame, start Desmos ourselves if nothing else has.
 */
function watchdog(doc, src, original, id) {
  setTimeout(() => {
    if (doc.defaultView === null || $("#desmos").contentDocument !== doc) return; // superseded
    if (doc.defaultView.Calc !== undefined) return;
    console.warn(`desmos: "${id}" never started Desmos; starting it directly`);
    runBundle(doc, src, original);
  }, BUNDLE_TIMEOUT);
}

async function load(mode, graph) {
  releaseBlobs();

  const url = sourceUrl(mode, graph);
  const active = await enabledExtensions(mode);
  const context = (entry) => ({ mode, graph, url, arg: entry.arg, blob: makeBlob });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  const source = new DOMParser().parseFromString(await res.text(), "text/html");

  // Hold Desmos' bundle back without taking the tag out of the document.
  const build = [...source.querySelectorAll("script[src]")].filter((s) => BUILD_SCRIPT.test(s.getAttribute("src")));
  for (const script of build) script.setAttribute("type", HELD_TYPE);

  // The written document's own URL is about:blank, so relative URLs (and the proxy
  // bootstrap, which resolves against document.baseURI) need the real one spelled out.
  const base = source.createElement("base");
  base.setAttribute("href", url);
  source.head.prepend(base);

  for (const entry of active) {
    if (entry.def.html) await guard(entry, () => entry.def.html(source, context(entry)));
  }

  const buildUrl = build.length ? new URL(build[0].getAttribute("src"), url).toString() : null;
  const bundle = await patchBundle(buildUrl, active, context);

  // setup() may go to the network; let them all run at once.
  await Promise.all(
    active.map((entry) =>
      entry.def.setup ? guard(entry, async () => { entry.data = await entry.def.setup(context(entry)); }) : null,
    ),
  );

  const doc = await write("<!DOCTYPE html>" + source.documentElement.outerHTML);
  const config = {
    prefix: PROXY,
    origin: location.origin,
    path: framePath(mode, graph),
    buildPath: buildUrl ? new URL(buildUrl).pathname : null,
    bundle,
  };
  inject(doc, `${asExpression(preamble, "preamble")}(${JSON.stringify(config)});`);
  // Before any extension runs: main() and ui() are where an extension draws, and both of
  // them reach for __desmosExt.ui.
  inject(doc, `${asExpression(uiRuntime, "uiRuntime")}(${JSON.stringify(uiConfig(mode, active))});`);

  for (const entry of active) {
    if (entry.failed) continue;
    const data = JSON.stringify(entry.data ?? null);
    const id = JSON.stringify(entry.def.id);
    let code = "";
    // First, so that whatever the hooks below draw is styled the moment it appears.
    if (entry.css) code += `__desmosExt.ui.css(${id}, ${JSON.stringify(entry.css)});\n`;
    if (entry.def.ui) code += `__desmosExt.ui.panel(${id}, ${asExpression(entry.def.ui, "ui")}, ${data});\n`;
    if (entry.def.main) code += `${asExpression(entry.def.main, "main")}(${data});\n`;
    if (entry.def.ready) code += `__desmosExt.onCalc(${asExpression(entry.def.ready, "ready")}, ${data});\n`;
    if (!code) continue;
    // One <script> each, so an extension that throws does not stop the next one.
    inject(doc, `try {\n${code}} catch (error) {\n  console.error("desmos: extension " + ${id} + " failed", error);\n}`);
  }

  const src = bundle || (build.length ? build[0].getAttribute("src") : null);
  if (!src) {
    console.warn(`desmos: no build script in ${url}; the page shape must have changed`);
    return;
  }

  const owner = active.find((entry) => !entry.failed && entry.def.ownsBundle);
  if (owner) watchdog(doc, src, build[0], owner.def.id);
  else runBundle(doc, src, build[0]);
}

function fail(error) {
  console.error("desmos: failed to load", error);
  write(
    '<!DOCTYPE html><meta charset="utf-8"><body style="font:16px/1.5 system-ui;padding:2rem">' +
      "<h1>Couldn't load Desmos</h1><pre></pre>",
  ).then((doc) => {
    doc.querySelector("pre").textContent = String(error);
  });
}

const mode = currentMode();
let graph = currentGraph();

document.title = `Desmos | ${mode.title} (modded)`;

// Nothing can be drawn or loaded until the manifest says what exists. A manifest that will
// not read is not worth losing the calculator over: log it and carry on with no extensions.
loadManifest()
  .catch((error) => console.error("desmos: could not read the extension manifest", error))
  .then(() => {
    extensionSettings(mode);
    return load(mode, graph);
  })
  .catch(fail);

// Editing the fragment by hand (or following a link to another graph) swaps the graph out.
addEventListener("hashchange", () => {
  const next = currentGraph();
  if (next === graph) return;
  graph = next;
  load(mode, graph).catch(fail);
});

// ...and the frame tells us when Desmos changes the graph from the inside, so that saving
// or opening one leaves a shareable URL up here.
addEventListener("message", (event) => {
  if (!event.data || event.data.__desmos !== "path") return;
  if (event.source !== $("#desmos").contentWindow) return;
  const next = String(event.data.path || "").split("/").filter(Boolean)[1] || "";
  if (next === graph) return;
  graph = next;
  location.hash = next ? "#" + next : "";
});
