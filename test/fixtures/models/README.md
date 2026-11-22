# Model compatibility fixtures

These files support `node test/model-corpus.mjs`. They are public or newly authored test geometry, not the user's own CAD files.

## CadQuery cube-and-cylinder assembly

- Local file: `cadquery-cube-cylinder.step` (unmodified upstream bytes).
- Upstream file: [CadQuery tests/testdata/red_cube_blue_cylinder.step](https://github.com/CadQuery/cadquery/blob/e87cba2232bd974fa569008dca7e5d71f0dc977c/tests/testdata/red_cube_blue_cylinder.step).
- Revision: `e87cba2232bd974fa569008dca7e5d71f0dc977c`.
- SHA-256: `1fd5c7d9325bcfb9863365faf84554f89e7e7a5e86760a0fc8d5db00619d9ef5`.
- Attribution: CadQuery Development Team, distributed under the repository's Apache-2.0 license. The unmodified upstream license is included as `CADQUERY-LICENSE.txt`.
- Source license: [CadQuery LICENSE](https://github.com/CadQuery/cadquery/blob/e87cba2232bd974fa569008dca7e5d71f0dc977c/LICENSE).
- This STEP fixture includes an analytic `CYLINDRICAL_SURFACE` and multiple positioned bodies. The imported render intentionally uses one material, so original per-face colors are not retained.

## Original geometric cases

`hollow-gear.stl`, `hollow-vase.obj`, and their generator `generate.mjs` were authored for Constellation and are dedicated to the public domain under [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/).

- `hollow-gear.stl`: binary STL with 640 triangles; a 20-tooth mechanical shape and an open center bore.
- `hollow-vase.obj`: triangulated OBJ with 1,728 triangles; a curved, hollow lathed vessel with a rim and inner wall.
- Reproduce both files with `node test/fixtures/models/generate.mjs`.

Their role is to exercise holes, concavity, curved silhouettes, multiple surfaces, and mesh sizes larger than the original chair sample. They are deterministic synthetic fixtures, not production engineering designs.
