// Extension registry for the proxied Desmos frame. desmos.js is the loader that runs these.
//
// Extensions are declared by hand in extensions/extensions.json:
//
//   {
//     "extensions": {
//       "matrix": {
//         "name": "Matrices",                 // shown in the settings panel
//         "description": "...",               // its tooltip
//         "supports": ["graphing", "3d"],     // optional; every calculator when absent
//         "file": "matrix.js"                 // optional; "<id>.js" when absent
//       }
//     },
//     "defaultExtensions": ["matrix"]         // on for anyone who has not said otherwise
//   }
//
// extensions/extensions.schema.json has the format in full.
//
// That manifest is everything the page knows before it loads anything: the settings panel is
// drawn from it, and only the extensions that are actually on have their scripts fetched. So
// the name, description, supported calculators and default state live there, and the script
// itself holds nothing but the hooks.
//
// An extension is a plain object handed to extension(). Every hook is optional:
//
//   patches: [...]          parent - declarative rewrites of the Desmos bundle text
//   html(doc, ctx)          parent - mutate the proxied page before it is written
//   source(js, ctx) -> js   parent - rewrite the Desmos bundle text
//   setup(ctx) -> data      parent - may fetch; the result is handed to main() and ready()
//   main(data)              frame  - runs before the bundle does
//   ready(Calc, data)       frame  - runs the moment Desmos assigns window.Calc
//
// `patches` runs before `source`, so an extension with both hands its own hook a bundle
// that the patches have already been applied to. See the patches section below.
//
// main() and ready() are serialized with Function.prototype.toString and run inside the
// frame, so they must not reference anything outside themselves - everything they need
// comes through `data`, which is whatever setup() returned.
//
// `ownsBundle: true` means the extension executes the Desmos bundle itself and the loader
// must not; DesModder fetches, patches and evals it.

const MANIFEST_URL = "/desmos/extensions/extensions.json";
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

/** Read extensions.json. Must finish before anything else here is called. */
async function loadManifest() {
  // no-cache rather than the default: the manifest is hand-edited, and a stale copy means
  // an extension that was just added silently isn't there.
  const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
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
      src: new URL(meta.file || `${id}.js`, new URL(EXT_DIR, location.origin)).toString(),
      default: defaults.has(id),
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
        script.src = entry.src;
        script.async = false;
        script.addEventListener("load", () => resolve());
        script.addEventListener("error", () => reject(new Error(`could not load ${entry.src}`)));
        document.head.appendChild(script);
      }),
    );
  }
  return scripts.get(entry.id);
}

/** The def for `entry`, fetching its script the first time; null if that doesn't work out. */
async function loadExtension(entry) {
  try {
    await loadScript(entry);
  } catch (error) {
    console.error(`desmos: extension "${entry.id}" could not be loaded`, error);
    return null;
  }
  const def = EXTENSIONS.get(entry.id);
  if (!def) console.warn(`desmos: ${entry.src} did not register an extension called "${entry.id}"`);
  return def || null;
}

// ---------------------------------------------------------------------------
// which extensions load
// ---------------------------------------------------------------------------

/** `?ext=matrix,desmodder@v0.15.17` -> [{id, arg}], or null if there is no ?ext= at all. */
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

/**
 * The extensions to run, scripts and all. ?ext= wins when present; with no ?ext= at all,
 * fall back to the stored toggles over the manifest's defaults.
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
  } else {
    const stored = storedExtensions();
    for (const entry of MANIFEST.values()) {
      if (stored[entry.id] ?? entry.default) wanted.push({ entry, arg: null });
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
      const def = await loadExtension(entry);
      return def && { def, meta: entry, arg, failed: false };
    }),
  );
  return active.filter(Boolean);
}

// ---------------------------------------------------------------------------
// settings panel (parent page - the frame belongs to Desmos' own chrome)
// ---------------------------------------------------------------------------

/** Fills in the panel markup from index.html, from the manifest alone - no script needed. */
function extensionSettings(mode) {
  const overridden = requestedExtensions() !== null;
  const stored = storedExtensions();
  const list = $("#ext-list");
  const reload = $("#ext-reload");

  for (const entry of MANIFEST.values()) {
    const supported = supportsMode(entry, mode);
    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = (stored[entry.id] ?? entry.default) && supported;
    box.disabled = overridden || !supported;
    box.addEventListener("change", () => {
      storeExtension(entry.id, box.checked);
      reload.hidden = false;
    });
    row.append(box, " ", entry.name);
    row.title = supported ? entry.description : `Not available on the ${mode.title.toLowerCase()}`;
    if (!supported) row.style.opacity = "0.5";
    list.appendChild(row);
  }

  $("#ext-note").hidden = !overridden;
  $("#ext-toggle").addEventListener("click", () => {
    const panel = $("#ext-panel");
    panel.hidden = !panel.hidden;
  });
  reload.addEventListener("click", () => location.reload());
}
