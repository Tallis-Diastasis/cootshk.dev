// DesModder (https://github.com/DesModder/DesModder, MIT) without the browser extension.
//
// DesModder normally ships as an extension: a content script blocks Desmos' bundle at the
// network layer, re-fetches it, rewrites it, and evals the result. Everything it needs from
// the extension shell is a `<script>` tag to find the bundle URL on, a settings store, and
// somewhere to load its own files from. This loader already holds the bundle back, so the
// only real work is a localStorage-backed stand-in for its content script.
//
// Its own build artifacts are not on npm or any CDN - only GitHub release zips, which serve
// no CORS headers - so they come through the proxy in worker.js and are unzipped here. Pin a
// version with `?ext=desmodder@v0.15.17`, or follow the latest release with
// `?ext=desmodder@latest`.
//
// Known not to work: the video-creator plugin's export needs SharedArrayBuffer, which needs
// COOP/COEP response headers that GitHub Pages cannot set.

const DESMODDER_VERSION = "v0.15.17";
const DESMODDER_REPO = "DesModder/DesModder";
const DESMODDER_ASSET = (version) => `DesModder-Chrome-${version}.zip`;
const DESMODDER_CACHE = "desmodder-files";
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

// github.com and api.github.com, through the proxy (see worker.js).
const GITHUB = "/_/github";
const GITHUB_API = "/_/_github/api";

// A tag, and nothing that could walk out of the release path it is pasted into: ?ext= hands
// this straight to whoever opens the link.
const TAG = /^v?[A-Za-z0-9][\w.-]{0,31}$/;

// what we pull out of the release zip, and what to serve it as
const DESMODDER_FILES = {
  preload: ["dist/preload/script.js", "text/javascript"],
  script: ["dist/script.js", "text/javascript"],
  css: ["dist/script.css", "text/css"],
};

let jszipPromise = null;
const getJszip = () => (jszipPromise ??= import(JSZIP_URL).then((m) => m.default ?? m));

// Cache keys only - nothing is served at this path, but the Cache API insists on a URL.
const desmodderKey = (version, name) => `/desmos/extensions/desmodder/${version}/${name}`;

/** The three files for `version`, or null if they aren't all cached. */
async function desmodderCached(version) {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(DESMODDER_CACHE);
    const files = {};
    for (const name of Object.keys(DESMODDER_FILES)) {
      const hit = await cache.match(desmodderKey(version, name));
      if (!hit) return null;
      files[name] = await hit.text();
    }
    return files;
  } catch (_) {
    return null;
  }
}

async function desmodderStore(version, files) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(DESMODDER_CACHE);
    await Promise.all(
      Object.entries(files).map(([name, text]) => cache.put(desmodderKey(version, name), new Response(text))),
    );
  } catch (_) {
    /* storage full or unavailable - just means we download again next time */
  }
}

/** The tag of the newest release. Only `?ext=desmodder@latest` ever asks. */
async function desmodderLatest() {
  const res = await fetch(`${GITHUB_API}/repos/${DESMODDER_REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`desmodder latest -> ${res.status} ${res.statusText}`);
  const tag = (await res.json()).tag_name;
  if (!tag) throw new Error("desmodder: the latest release has no tag");
  return tag;
}

/** Fetch and unzip a release. GitHub redirects the download onto githubusercontent.com. */
async function desmodderDownload(version) {
  const url = `${GITHUB}/${DESMODDER_REPO}/releases/download/${version}/${DESMODDER_ASSET(version)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`desmodder ${version} -> ${res.status} ${res.statusText}`);

  const JSZip = await getJszip();
  const zip = await JSZip.loadAsync(await res.arrayBuffer());

  const files = {};
  for (const [name, [path]] of Object.entries(DESMODDER_FILES)) {
    const entry = zip.file(path);
    if (!entry) throw new Error(`desmodder ${version}: ${path} is missing from the release zip`);
    files[name] = await entry.async("string");
  }
  return files;
}

// Name, description and default state are declared in ../../extensions.json, and so is the list
// of calculators this is for: DesModder finds Desmos' bundle by name and only knows the four
// desktop calculator bundles, while the matrices and scientific calculators ship
// calculator_matrix / calculator_basic instead, which its (untimed) poll would wait on
// forever. Hence "supports" there leaves those two out.
extension({
  id: "desmodder",

  // DesModder fetches, patches and evals the bundle itself. The loader hands it our
  // already-patched source and stays out of the way.
  ownsBundle: true,

  async setup(ctx) {
    // Whatever is cached under the keys the removed /_/ext route used is unreachable now.
    if (typeof caches !== "undefined") void caches.delete("desmodder");

    const requested = ctx.arg || DESMODDER_VERSION;
    // Resolved before anything is looked up, so a cached copy counts for `latest` too.
    const version = requested === "latest" ? await desmodderLatest() : requested;
    if (!TAG.test(version)) throw new Error(`desmodder: ${JSON.stringify(version)} is not a release tag`);

    let files = await desmodderCached(version);
    if (!files) {
      files = await desmodderDownload(version);
      void desmodderStore(version, files);
    }

    // blob: URLs because DesModder assigns them to script.src / link.href, and the proxy
    // bootstrap rewrites everything it is handed there except blob: and data:. ctx.blob
    // hands the loader the lifetime, so they are released when the page is next loaded.
    const url = (name) => ctx.blob(files[name], DESMODDER_FILES[name][1]);
    return { version, preload: url("preload"), script: url("script"), css: url("css") };
  },

  // Stands in for DesModder's content script: same postMessage protocol, localStorage
  // instead of chrome.storage.sync.
  main(data) {
    const KEYS = {
      enabled: "desmodder-plugins-enabled",
      forceDisabled: "desmodder-force-disabled",
      forceDisabledVersion: "desmodder-force-disabled-version",
      settings: "desmodder-plugin-settings",
    };

    const read = (key, fallback) => {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    };
    const write = (key, value) => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (_) {
        /* nothing we can do */
      }
    };

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const message = event.data;
      if (!message || typeof message.type !== "string") return;

      switch (message.type) {
        case "get-initial-data": {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = data.css;
          (document.head || document.documentElement).appendChild(link);

          // DesModder drops its force-disable list whenever its own version changes.
          const stale = read(KEYS.forceDisabledVersion, "") !== data.version;
          window.postMessage(
            {
              type: "apply-initial-data",
              pluginsEnabled: read(KEYS.enabled, {}),
              pluginsForceDisabled: stale ? [] : read(KEYS.forceDisabled, []),
              pluginSettings: read(KEYS.settings, {}),
              scriptURL: data.script,
            },
            "*",
          );
          break;
        }
        case "set-plugins-enabled":
          write(KEYS.enabled, message.value);
          break;
        case "set-plugins-force-disabled":
          write(KEYS.forceDisabled, Array.from(message.value));
          write(KEYS.forceDisabledVersion, data.version);
          break;
        case "set-plugin-settings":
          write(KEYS.settings, message.value);
          break;
        case "send-heartbeat":
          // WakaTime reporting needs the extension's background page to proxy the API.
          break;
      }
    });

    const preload = document.createElement("script");
    preload.src = data.preload;
    (document.head || document.documentElement).appendChild(preload);
  },
});
