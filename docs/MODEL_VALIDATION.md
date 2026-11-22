# Expanded model validation

Verified November 22, 2026, using the actual import controls and GPU renderer in isolated browser sessions. All three cases passed. This extends the original chair and authored STEP-cube tests with an external curved CAD assembly and two deterministic geometric fixtures.

| Model | Input | Imported triangles | GPU versus CPU mean channel-byte difference |
| --- | --- | ---: | ---: |
| CadQuery cube-and-cylinder assembly | STEP, 18,322 bytes | 112 | 0 |
| Hollow mechanical gear | Binary STL, 32,084 bytes | 640 | 0.0000038 |
| Hollow curved vase | Triangulated OBJ, 54,882 bytes | 1,728 | 0.0002174 |

For each model, the test uses the real file picker, checks the accepted mesh, renders all 64 tiles of a 256 × 256 image at 8 samples / 4 bounces, confirms actual work from both WebGPU contributors, and compares every output channel with the CPU reference. No tiles required retry. Both adapters reported Apple Metal hardware, not a software fallback. An invalid STL was then rejected while preserving the last accepted scene, with no browser page errors.

The external STEP includes an analytic cylindrical surface and multiple bodies. The two original fixtures exercise a center bore, teeth, a curved hollow silhouette, interior walls, and flat triangle shading. Screenshots were visually inspected: all three shapes, holes, and shadows are visible.

## Reproduce

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
GPU_ARGS='["--enable-unsafe-webgpu","--use-angle=metal"]' \
node test/model-corpus.mjs
```

The test starts and stops its own localhost server. It needs no Gemini key, database connection, or cloud account. The GPU flags above are for the verified Mac; adapt them for another platform. Runtime artifacts are saved under `artifacts/`:

- `model-corpus-report.json` — per-model hashes, import timings, triangle counts, contributor work, and pixel errors.
- `model-corpus-contact-sheet.png` — the three verified renderings together.
- `model-corpus-*.png` — individual rendered images.

Fixture source, exact upstream revision, license, and reproduction instructions are in [the fixture README](../test/fixtures/models/README.md).

## Practical limits

This is representative public/synthetic validation, not a test of the user's own CAD files. Complex assemblies, native SolidWorks `.sldprt`, textures, animation, and files above the importer limits remain unsupported. Imported models use one material, flat face normals, and the existing Y-up convention. STEP tessellation quality is bounded by the 10,000-triangle ceiling.

The two browser workers share one Mac GPU. These results verify import and distributed-render correctness, not physical-phone compatibility or a real crowd speedup. That comparison still requires the user's laptop and separate participating phones.
