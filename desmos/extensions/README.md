# Extensions

## Adding an extension
- put a .js file in this folder
- add it to extensions.json

## Patching the Desmos bundle
Put a `patches` list in the object you hand to `extension()`. Each patch is
`{ match, replace }`, applied to the bundle in order:

```js
extension({
  id: "matrix",
  patches: [
    { match: /\i\.includes\(\i\)\|\|(?=\i\.restrictedFunctions)/g, replace: "", count: 1 },
  ],
});
```

- `\i` expands to one JavaScript identifier, `(?:[A-Za-z_$][\w$]*)`. Desmos' minified
  names change with every build, so never write them out.
- `replace` is a `String.replace` replacement: `$1`, `$2`, `$<name>` and `$&` put the
  captured pieces back. A function works too. A `/g` match replaces every occurrence, a
  plain one only the first.
- A patch that matches nothing throws, and the extension is dropped for that load - it
  will not silently half-apply itself to a build that moved on.
- `count` asserts how many times the pattern appears. `count: 1` is the usual "this had
  better be the only place" check.

`source(js, ctx)` is still there for anything this can't express, and runs after the
patches.
