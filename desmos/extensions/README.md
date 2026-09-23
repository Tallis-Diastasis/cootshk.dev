# Extensions

Every extension is one file in this directory plus one entry in `extensions.json`, which is
maintained by hand. The page reads the manifest first and only fetches the scripts of the
extensions that are actually turned on, so nothing has to be registered anywhere else.

```jsonc
{
  "extensions": {
    "matrix": {
      "name": "Matrices",                          // shown in the settings panel
      "description": "Add matrix support ...",     // its tooltip
      "supports": ["graphing", "3d"],              // optional; every calculator when absent
      "file": "matrix.js"                          // optional; "<id>.js" when absent
    }
  },
  "defaultExtensions": ["matrix"]                  // on for anyone who has not said otherwise
}
```

[`extensions.schema.json`](extensions.schema.json) is the whole format, field by field;
`extensions.json` points at it, so an editor that understands JSON Schema will complete and
check it as you type.

`supports` names calculators the way `?type=` does — `graphing`, `3d`, `geometry`, `matrix`,
`scientific` — and takes their aliases and upstream paths (`calculator`) too.

The script itself holds only behaviour: it calls `extension({ id: "matrix", ... })` with the
hooks it wants, and the id has to match its key in the manifest. The hooks are documented at
the top of [`../extensions.js`](../extensions.js).

Which extensions run: `?ext=matrix,desmodder@v0.15.17` if it is in the URL (`?ext=none` for
none at all), otherwise the checkboxes in the settings panel, which fall back to
`defaultExtensions`.

extension tutorial coming eventually™.
