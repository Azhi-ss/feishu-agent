# Vendored themes

Third-party themes bundled under this directory are vendored (not npm
dependencies), so they never read from `~/.pi/`. Keep each entry's source,
version, and sync steps current.

## breezy-ocean

- **Source:** [awesome-pi-themes](https://github.com/isashi/awesome-pi-themes),
  `themes/breezy-ocean.json`, by [isashi](https://github.com/isashi).
- **License:** MIT.
- **Vendored:** 2026-09-07, from awesome-pi-themes v1.1.22, verbatim (only the
  JSON file; the `$schema` URL points at the Pi upstream).
- **Sync steps:**
  1. Fetch the latest `themes/breezy-ocean.json` from the upstream repo/release
     and replace the file here.
  2. Bump the vendored version/date above.
  3. `npm run build && npm test` — the resource-loader test asserts the theme
     loads; open the TUI and check the banner bird (it follows `accent`/`mdLink`).
