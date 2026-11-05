# Offline packaging and SDK linkage

Offline packaging and SDK linkage proves that a clean source copy passes `npm ci --ignore-scripts`, `npm run typecheck`, `npm pack`, offline tarball installation, and runtime entry linkage against the real `@getpaseo/plugin` SDK.

## Sub-features

- `clean-ci-and-typecheck` installs locked dependencies and typechecks all server and test modules in an isolated directory.
- `pack-manifest-check` packs the tarball and verifies all required plugin manifest, entry, icon, overview, upstream, and license files are included.
- `real-sdk-entry-link` installs the packed tarball offline into a consumer package and links `index.server.ts` against the real `@getpaseo/plugin` runtime.

## How to get to it (user POV)

- Run `npm run verify:install -- <output-directory>` before publishing or deploying the plugin.

## Driving it with verify-install.mjs

Preconditions:

- Node.js and `npm` are available, and `<output-directory>` does not yet exist and is outside the repository root.

- **Run install verifier.** Run `npm run verify:install -- "$env:TEMP\agy-install-proof"`.
- **Inspect proof artifacts.** Confirm `steps.json`, `package-contents.json`, `packed-entry-link.stdout.log`, and `summary.json` exist in `$env:TEMP\agy-install-proof` and all steps report `status: 0`.

## Gotchas

- The output directory must be outside `E:\PROJECTS\paseo-plugins\paseo-antigravity-resilient` and must be a new path on each run so prior evidence is never overwritten.
