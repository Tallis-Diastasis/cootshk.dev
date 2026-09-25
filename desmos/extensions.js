// Extension registry for the proxied Desmos page. desmos.js is the loader that runs these.
//
// An extension is a folder under extensions/ named after its id, holding an index.js and,
// if it draws anything, an index.css. It is declared by hand in extensions.json:
//
//   {
//     "extensions": {
//       "matrices": {
//         "name": "Matrices",                 // shown in the settings panel
//         "description": "...",               // its tooltip
//         "supports": ["graphing", "3d"],     // optional; every calculator when absent
//         "css": true,                        // optional; load extensions/matrices/index.css
//         "file": "index.js",                 // optional; "index.js" when absent
//         "forceEnabled": false               // optional; always on, and not togglable
//       }
//     },
//     "defaultExtensions": ["matrices"]         // on for anyone who has not said otherwise
//   }
//
// extensions.schema.json has the format in full.
//
// That manifest is everything the page knows before it loads anything: the settings panel is
// drawn from it, and only the extensions that are actually on have their files fetched. So
// the name, description, supported calculators and default state live there, and the script
// itself holds nothing but the hooks.
//
// An extension is a plain object handed to extension(). Every hook is optional:
//
//   patches: [...]          declarative rewrites of the Desmos bundle text
//   html(doc, ctx)          mutate the proxied page before it replaces this one
//   source(js, ctx) -> js   rewrite the Desmos bundle text
//   setup(ctx) -> data      may fetch; the result is handed to ui(), main() and ready()
//   ---                     the proxied page replaces this document here
//   main(data)              runs before the bundle does
//   ready(Calc, data)       runs the moment Desmos assigns window.Calc
//   ui(root, data)          draws this extension's settings on its card in the Extensions
//                           tab; see ui.js for what it can draw with
//
// They run in that order, and all of them in this one window: Desmos does not get a frame of
// its own (see desmos.js). So a hook is ordinary code - it may close over module scope, share
// helpers with its neighbours and be broken on in a debugger, and `data` is passed to it
// rather than serialized.
//
// The one rule is `local`: after the swap, the proxy's bootstrap has patched fetch and the
// src/href setters, and anything of ours it is handed goes to desmos.com instead. Reach for
// ctx.fetch (or __desmosExt.fetch) for a file of this site's own.
//
// An index.css is not a hook: the loader fetches it alongside index.js and injects it before
// any of the extension's own code runs.
//
// `patches` runs before `source`, so an extension with both hands its own hook a bundle
// that the patches have already been applied to. See the patches section below.
//
// `ownsBundle: true` means the extension executes the Desmos bundle itself and the loader
// must not; DesModder fetches, patches and evals it.

const MANIFEST_URL = "/desmos/extensions.json";
const EXT_DIR = "/desmos/extensions/";
const EXT_STORAGE = "desmos-extensions";

// id -> the object its script handed to extension(); filled in as scripts load.
const EXTENSIONS = new Map();
// id -> what extensions.json says about it; filled in by loadManifest(), before anything else.
const MANIFEST = new Map();

function extension(def) {
  if (EXTENSIONS.has(def.id)) throw new Error(`desmos: duplicate extension id "${def.id}"`);
  // Patches are a source() written declaratively, so make them one: everything downstream
  // looks for def.source and needs to know nothing about either form.
  EXTENSIONS.set(def.id, def.patches ? { ...def, source: patchSource(def) } : def);
}

// ---------------------------------------------------------------------------
// patches
// ---------------------------------------------------------------------------

/**
 * `patches` is the declarative half of source(): a list of
 *
 *   { match: /regex/, replace: "text", count?: number }
 *
 * applied to the bundle in order, each one's output feeding the next. `replace` is a
 * String.prototype.replace replacement, so $1, $2, $<name> and $& put the pieces the match
 * captured back into the bundle; it can also be a function, called with the arguments
 * String.replace would pass it. A regex without /g replaces the first match, one with /g
 * replaces every match, and a plain string matches literally.
 *
 * Minified names change with every Desmos build, so write the identifiers in a pattern as
 * \i, which expands to exactly one of them:
 *
 *   patches: [{ match: /\i\.restrictedFunctions/, replace: "$&" }]
 *
 * A patch that matches nothing is an error rather than a no-op: the extension is dropped
 * for the rest of the load and says so in the console, instead of silently half-applying
 * itself to a build that has moved on. `count` tightens that to an exact number of
 * matches, for a pattern that is only correct if it is as specific as it looks. It counts
 * how many times the pattern appears, not how many of them get replaced - `count: 1` on a
 * regex without /g is the usual "this had better be the only one" check.
 */

/** What `\i` expands to: one JavaScript identifier, minified or not. */
const IDENTIFIER = "(?:[A-Za-z_$][\\w$]*)";

/** `match` with `\i` expanded. Strings are literal, so they come back untouched. */
function canonicalizeMatch(match) {
  if (typeof match === "string") return match;
  // One escape sequence at a time: that way the i in "\\i" - an escaped backslash, then a
  // letter - is left alone, while the \i in "\\\i" is seen as an escape of its own.
  const source = match.source.replace(/\\[\s\S]/g, (escape) => (escape === "\\i" ? IDENTIFIER : escape));
  return source === match.source ? match : new RegExp(source, match.flags);
}

/** How many times `match` appears in `js`. */
function countMatches(js, match) {
  if (typeof match === "string") return match ? js.split(match).length - 1 : 0;
  // Always a fresh regex: /g and /y carry a lastIndex between calls, and counting the
  // matches must not move the one the replace is about to use.
  const flags = match.flags.includes("g") ? match.flags : match.flags + "g";
  return (js.match(new RegExp(match.source, flags)) || []).length;
}

/** Apply `patches` to the bundle text. Throws on the first one that did not take. */
function applyPatches(patches, js, id) {
  patches.forEach((patch, i) => {
    const where = `desmos: "${id}" patch ${i + 1} of ${patches.length}`;
    if (typeof patch.match !== "string" && !(patch.match instanceof RegExp))
      throw new Error(`${where}: match must be a regex or a string`);
    if (typeof patch.replace !== "string" && typeof patch.replace !== "function")
      throw new Error(`${where}: replace must be a string or a function`);

    const match = canonicalizeMatch(patch.match);
    const found = countMatches(js, match);
    const expected = patch.count;
    if (expected === undefined ? found === 0 : found !== expected)
      throw new Error(
        `${where} (${match}) matched ${found} time(s)` + (expected === undefined ? "" : `, expected ${expected}`),
      );

    js = js.replace(match, patch.replace);
  });
  return js;
}

/** The source hook a patched extension gets: its patches, then its own source() if it has one. */
function patchSource(def) {
  const source = def.source;
  return function (js, ctx) {
    const patched = applyPatches(def.patches, js, def.id);
    return source ? source.call(def, patched, ctx) : patched;
  };
}

// ---------------------------------------------------------------------------
// the manifest
// ---------------------------------------------------------------------------

/** A file inside one extension's folder, as an absolute URL. */
function extensionUrl(id, file) {
  return new URL(`${id}/${file}`, new URL(EXT_DIR, location.origin)).toString();
}

/** Read extensions.json. Must finish before anything else here is called. */
async function loadManifest() {
  // no-cache rather than the default: the manifest is hand-edited, and a stale copy means
  // an extension that was just added silently isn't there.
  const res = await local.fetch(MANIFEST_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${MANIFEST_URL} -> ${res.status} ${res.statusText}`);
  const json = await res.json();

  const defaults = new Set(json.defaultExtensions || []);
  MANIFEST.clear();
  for (const [id, meta] of Object.entries(json.extensions || {})) {
    MANIFEST.set(id, {
      id,
      name: meta.name || id,
      description: meta.description || "",
      // The calculators it is for, named as ?type= is (aliases and upstream paths are taken
      // too). Null means all of them.
      supports: meta.supports || null,
      src: extensionUrl(id, meta.file || "index.js"),
      // An extension's own stylesheet, fetched with its script and injected before it
      // runs. `true` is the index.css beside its index.js; a string names another file in
      // the same folder.
      css: meta.css ? extensionUrl(id, meta.css === true ? "index.css" : meta.css) : null,
      default: defaults.has(id),
      // Always on, ?ext= included: an extension that draws the settings UI is no use if it
      // can be switched off from inside that UI, or left out of the URL that overrides it.
      forced: !!meta.forceEnabled,
    });
  }

  const unknown = [...defaults].filter((id) => !MANIFEST.has(id));
  if (unknown.length) console.warn(`desmos: defaultExtensions lists unknown extension(s): ${unknown.join(", ")}`);
  return MANIFEST;
}

// One promise per script: load() runs again on every graph change, and a second <script>
// tag for the same extension would only trip the duplicate-id check.
const scripts = new Map();

function loadScript(entry) {
  if (!scripts.has(entry.id)) {
    scripts.set(
      entry.id,
      new Promise((resolve, reject) => {
        const script = document.createElement("script");
        // local.setAttribute, not script.src: by the time a graph change loads an extension
        // for the first time, the proxy has patched that setter.
        local.setAttribute.call(script, "src", entry.src);
        script.async = false;
        script.addEventListener("load", () => resolve());
        script.addEventListener("error", () => reject(new Error(`could not load ${entry.src}`)));
        document.head.appendChild(script);
      }),
    );
  }
  return scripts.get(entry.id);
}

// ...and one per stylesheet, for the same reason. Fetched rather than linked, and through
// local.fetch: the proxy bootstrap rewrites every href it is given, and would send a <link>
// of ours off to desmos.com.
const sheets = new Map();

function loadSheet(entry) {
  if (!entry.css) return Promise.resolve(null);
  if (!sheets.has(entry.id)) {
    sheets.set(
      entry.id,
      local.fetch(entry.css).then((res) => {
        if (!res.ok) throw new Error(`${entry.css} -> ${res.status} ${res.statusText}`);
        return res.text();
      }),
    );
  }
  return sheets.get(entry.id);
}

/** `entry`'s def and stylesheet, fetched the first time; null if the script doesn't work out. */
async function loadExtension(entry) {
  // Not Promise.all: a missing stylesheet leaves an extension unstyled, which is worth
  // saying out loud but not worth dropping a working extension over. A missing script is.
  const css = loadSheet(entry).catch((error) => {
    console.error(`desmos: extension "${entry.id}" could not load its stylesheet`, error);
    return null;
  });

  try {
    await loadScript(entry);
  } catch (error) {
    console.error(`desmos: extension "${entry.id}" could not be loaded`, error);
    return null;
  }
  const def = EXTENSIONS.get(entry.id);
  if (!def) {
    console.warn(`desmos: ${entry.src} did not register an extension called "${entry.id}"`);
    return null;
  }
  return { def, css: await css };
}

// ---------------------------------------------------------------------------
// which extensions load
// ---------------------------------------------------------------------------

/** `?ext=matrices,desmodder@v0.15.17` -> [{id, arg}], or null if there is no ?ext= at all. */
function requestedExtensions() {
  const raw = new URLSearchParams(location.search).get("ext");
  if (raw === null) return null;
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && part !== "none")
    .map((part) => {
      const at = part.indexOf("@");
      return at === -1 ? { id: part, arg: null } : { id: part.slice(0, at), arg: part.slice(at + 1) };
    });
}

function storedExtensions() {
  try {
    return JSON.parse(localStorage.getItem(EXT_STORAGE)) || {};
  } catch (_) {
    return {};
  }
}

function storeExtension(id, enabled) {
  const stored = storedExtensions();
  stored[id] = enabled;
  try {
    localStorage.setItem(EXT_STORAGE, JSON.stringify(stored));
  } catch (_) {
    /* private browsing - the choice just doesn't stick */
  }
}

/** Does `entry` claim this calculator? A manifest with no "supports" claims all of them. */
function supportsMode(entry, mode) {
  return !entry.supports || entry.supports.some((name) => canonicalMode(name) === mode.key);
}

/** Is `entry` on? forceEnabled beats everything; otherwise the stored choice, then default. */
function isEnabled(entry, stored) {
  return entry.forced || (stored[entry.id] ?? entry.default);
}

/**
 * The extensions to run, scripts and all. ?ext= wins when present; with no ?ext= at all,
 * fall back to the stored toggles over the manifest's defaults. Either way the forced ones
 * come too.
 */
async function enabledExtensions(mode) {
  const wanted = [];
  const requested = requestedExtensions();

  if (requested) {
    for (const { id, arg } of requested) {
      const entry = MANIFEST.get(id);
      if (entry) wanted.push({ entry, arg });
      else console.warn(`desmos: no extension named "${id}"`);
    }
    // ...and the forced ones, which ?ext= does not get a say over. After the rest, in
    // manifest order among themselves.
    const asked = new Set(requested.map(({ id }) => id));
    for (const entry of MANIFEST.values()) {
      if (entry.forced && !asked.has(entry.id)) wanted.push({ entry, arg: null });
    }
  } else {
    const stored = storedExtensions();
    for (const entry of MANIFEST.values()) {
      if (isEnabled(entry, stored)) wanted.push({ entry, arg: null });
    }
  }

  // An extension aimed at the wrong calculator is not just useless: DesModder looks for a
  // bundle name that mode never loads, and polls for it forever.
  const supported = wanted.filter(({ entry }) => {
    if (supportsMode(entry, mode)) return true;
    console.warn(`desmos: extension "${entry.id}" does not support ${mode.path}`);
    return false;
  });

  // Fetched together, but kept in manifest order: the hooks run in the order they appear in
  // extensions.json, whatever order the network hands the scripts back in.
  const active = await Promise.all(
    supported.map(async ({ entry, arg }) => {
      const loaded = await loadExtension(entry);
      return loaded && { def: loaded.def, css: loaded.css, meta: entry, arg, failed: false };
    }),
  );
  return active.filter(Boolean);
}

// ---------------------------------------------------------------------------
// what the UI is told
// ---------------------------------------------------------------------------

/**
 * The manifest as ui.js sees it: everything it needs to draw the Extensions tab. `active` is
 * what this load actually started, which is how the UI knows a toggle has been flipped since.
 */
function extensionCatalog(mode, active) {
  const running = new Set(active.map((entry) => entry.def.id));
  return [...MANIFEST.values()].map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    supported: supportsMode(entry, mode),
    forced: entry.forced,
    default: entry.default,
    active: running.has(entry.id),
  }));
}

/** The config uiRuntime() is handed. */
function uiConfig(mode, active) {
  return {
    storage: EXT_STORAGE,
    overridden: requestedExtensions() !== null,
    extensions: extensionCatalog(mode, active),
  };
}
