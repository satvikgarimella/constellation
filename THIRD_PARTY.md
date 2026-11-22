# Third-party software and sample models

## STEP conversion

Constellation uses the unmodified `occt-import-js` npm package, pinned to **0.0.23**, for optional STEP conversion. Its JavaScript and WebAssembly files are served separately and loaded only when the host imports a STEP file. The dependency is installed through `pnpm-lock.yaml`; it is not copied into application sources.

- Upstream source and build instructions: https://github.com/kovacsv/occt-import-js
- Exact package: https://www.npmjs.com/package/occt-import-js/v/0.0.23
- Importer license, supplied by the package: `node_modules/occt-import-js/dist/license.occt-import-js.txt`, available at `/vendor/occt/license.occt-import-js.txt`.
- OpenCascade license and exception, supplied by the package: `node_modules/occt-import-js/dist/license.occt.txt`, available at `/vendor/occt/license.occt.txt`.

The importer is LGPL-2.1; OpenCascade carries the LGPL-2.1 license with its additional exception. Refer to the complete upstream notices above. The separate dependency can be replaced or rebuilt by following its upstream instructions and updating the installed package.

## Sample geometry

`public/models/demo-chair.obj` is original geometry provided under CC0, as recorded in the file. The STEP test fixture is authored for this project, with no third-party CAD asset included.

Other runtime dependencies and their licenses are listed in their installed package directories and pinned in `pnpm-lock.yaml`.
