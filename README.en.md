# @wjyfst/cesium-grid

[简体中文](./README.md) | English

CesiumJS **hundred-million-scale independent 3D grid** layer: real GPU instanced rendering,
progressive fill outward from the camera center, per-cell data coloring, O(1) picking.

Built for: meteorological grids (temperature / humidity / wind / precipitation), environmental
numeric fields, and any 3D visualization that needs "grid + per-cell value coloring + volumetric
height layers".

---

## Why it's worth using

| Capability           | How                                                                                              | Result                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 100M cells open fast | Fills frame by frame from the camera center outward; first frame needs no full data              | First-frame time is independent of cell count                            |
| Low VRAM             | One unit-box geometry shared by all cells; per cell only a 3×4 matrix (48 B) + RGBA8 color (4 B) | **52 B/cell**; 100M cells fully populated ≈ 5.2 GB                       |
| Few draw calls       | Chunked by `chunkSize`, one `DrawCommand` per chunk                                              | 100M cells (10000×10000) / chunk edge 128 ≈ 6200 draw calls              |
| Cheap picking        | Screen coords → lon/lat → cell directly; no offscreen picking render                             | **O(1)**, independent of cell count                                      |
| Per-cell data color  | `getCellColor(col, row)` baked into the instance buffer at creation time                         | Data color on the first frame; no "base color then recolor" double write |
| Height-layer switch  | `setBottomHeight(z)` rewrites instance matrices in place, throttled per frame                    | No layer rebuild; colors and selection are preserved                     |
| Bounded memory       | Untouched chunks allocate no CPU buffer                                                          | 100M cells won't eat several GB at construction time                     |

---

## Install

```bash
# From GitHub (currently recommended; no npm account needed)
npm install github:wjyfst/cesium-grid

# Or pin to a tag / commit
npm install github:wjyfst/cesium-grid#v0.1.0
```

`cesium` is a peer dependency provided by your app (must be `>=1.110.0 <2.0.0`):

```bash
npm install cesium
```

For local development you can also use the `file:` protocol:

```bash
npm install /path/to/cesium-grid
```

---

## Quick start

```js
import * as Cesium from 'cesium';
import { createGridLayer, destroyGridLayer } from '@wjyfst/cesium-grid';

const viewer = new Cesium.Viewer('cesiumContainer');

// Grid extent: west longitude / south latitude / cols / rows / cell edge (degrees)
const handle = createGridLayer(viewer, {
  originLon: 115.8,
  originLat: 23.5,
  cols: 470,
  rows: 480,
  cellSize: 0.01, // ≈ 1.1 km
  bottomHeight: 0, // bottom elevation (meters)
  gridHeight: 30, // column height (meters)
  fillColor: '#FF7043',
  // Per-cell coloring: returning { fillColor, outlineColor } lets the outline share
  // this cell's RGB while keeping its own alpha
  getCellColor: (col, row) => {
    const value = myData[row]?.[col];
    if (!Number.isFinite(value)) return null; // null → use the layer default color
    const color = palette(value); // your palette
    return { fillColor: color.withAlpha(0.5), outlineColor: color.withAlpha(0.8) };
  },
  onClick: (cell) => console.log('clicked', cell.code, cell.centerLon, cell.centerLat),
});

// Switch height layer (re-baked in place, keeps colors and selection)
handle.setBottomHeight(300);

// Read progress / diagnostics
console.log(handle.getFillProgress(), handle.logStats());

// Release (idempotent). Not needed if the viewer will be destroyed.
destroyGridLayer(handle);
```

### Three entry points

```js
import {
  createGridLayer, // recommended entry: default strategy
  createInstancedGridLayer, // explicit instancing (same as default; self-documenting)
  createPrimitiveGridLayer, // Primitive strategy: independent outline hue + GPU picking
} from '@wjyfst/cesium-grid';
```

The third parameter of `createGridLayer` is an internal preset slot you don't need day to day;
all three entries take exactly the same `options`.

### Pure-compute entry (no WebGL / DOM)

```js
// Import only the pure-compute subpath: this does not pull in cesium
import { packCellsMatrices, createRingFill } from '@wjyfst/cesium-grid/math';

const fill = createRingFill(100, 200, 1000, 1000);
let batch;
while (!fill.isDone()) {
  batch = fill.nextBatch(4000); // Int32Array [col,row,col,row,...]
  // ... precompute matrices in Node
}
```

The pure-compute functions are also exported from the main entry
(`import { createRingFill } from '@wjyfst/cesium-grid'`), but that loads `cesium` as well.

> **`/math` is the only entry that can be imported in bare Node.** The main entry loads `cesium`,
> and Cesium's own ESM build fails to resolve there
> (`does not provide an export named '_shadersPolygonSignedDistanceFS'`). That's a Cesium packaging
> issue, not this package's — any `import 'cesium'` behaves the same in bare Node. Therefore:
>
> - Data preprocessing / precomputing matrices in Node → use `@wjyfst/cesium-grid/math`;
> - Building layers → use the main entry in a browser or bundler (Vite / Webpack).
>
> This package's tests work around it via `vi.mock('cesium')`, so `gridLayer` logic is still
> fully covered under Node.

### Polygon-area grid (pure compute)

The rectangular entry (`createGridLayer`) only supports `originLon/originLat/cols/rows` extents.
To generate a fixed-edge grid inside an **arbitrary polygon** (GeoJSON Polygon / MultiPolygon,
holes included), use the pure-compute generator in `/math`:

```js
import { generatePolygonGrid, packCellsMatrices } from '@wjyfst/cesium-grid/math';

// GeoJSON Polygon / MultiPolygon (holes allowed); [lon, lat], longitude first
const grid = generatePolygonGrid(geojsonPolygon, {
  cellSize: 0.01, // ≈ 1.1 km
  layers: 3, // vertically stacked layers
  bottomHeight: 0,
  gridHeight: 30,
});

// grid.cols / rows is the bounding rectangle covering the polygon;
// cells2d contains only in-polygon cells (out-of-polygon cells are removed)
// Pack matrices per layer with that layer's model (existing matrix fns have no layer axis)
const m0 = packCellsMatrices(grid.cells2d, grid.layerModels[0]);
const m1 = packCellsMatrices(grid.cells2d, grid.layerModels[1]);
const m2 = packCellsMatrices(grid.cells2d, grid.layerModels[2]);
```

Rules and limits:

- **Containment is decided by the cell center** (outer-ring edge lines count as inside, hole edge
  lines count as outside): cells whose center lies outside the polygon never enter `cells2d`;
  boundary cells may be short by up to half a cell, so the outline is not guaranteed to hug the
  polygon exactly;
- **Layers**: every layer shares the same (col,row) set; layer k's bottom elevation is
  `bottomHeight + k × gridHeight`. Render N layers by instancing the same cells at each layer's
  `bottomHeight` (or N `createGridLayer`s with the same bbox but different `bottomHeight`);
  **layered lists are not wired to picking**;
- Polygons crossing the antimeridian are not supported (warning, no splitting);
- This generator is a **preprocessing entry point** and is not wired into `createGridLayer`
  (layers stay rectangular); `createPolygonRingFill(grid, centerCol, centerRow)` provides ring
  fill that only emits in-polygon cells, reserved for a future layer integration;
- Invalid input (cellSize / layers / heights / geometry) **throws** — no silent fallback.

---

## Rendering strategies

Two rendering paths exist; the **instanced** strategy is the default.

|                  | Instanced (default)                            | Primitive                                           |
| ---------------- | ---------------------------------------------- | --------------------------------------------------- |
| Enable with      | default / `instancing: true`                   | `instancing: false` (or `createPrimitiveGridLayer`) |
| VRAM per cell    | **52 B**                                       | ≈ 1440 B                                            |
| Draw calls       | 1 per chunk                                    | 2 per batch (fill + wireframe)                      |
| Geometry build   | none (vertex shader transforms per cell)       | async `createGeometry` / `combineGeometry`          |
| Write visibility | rendered on the next frame                     | waits for Primitive `ready` (with delayed backfill) |
| Outline hue      | must match this cell's fill RGB (edge shading) | **can be set independently**                        |
| GPU picking      | unavailable (whole layer shares one pickId)    | available (`mathPick: false`)                       |
| CPU-side memory  | 12 B/cell                                      | ≈ 501 B/cell                                        |

**When to fall back to the Primitive strategy**: when columns are very tall (kilometers) or the
view is extremely oblique, so the horizontal error from mathematical inverse picking (which
intersects only the ellipsoid, h=0) is unacceptable; or when the business requires an outline hue
different from the fill.

### Grid lines: pick one of three

| Config                             | Effect                                                                                    | Vertices/cell |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | ------------- |
| `edgeShader: true` (default)       | Custom Appearance draws edges inside box faces; width via `fwidth` → constant pixel width | 24            |
| `edgeShader: false, outline: true` | Separate wireframe Primitive; can use a different hue                                     | 48            |
| `outline: false`                   | No grid lines (fallback switch for low-end devices)                                       | 24            |

`edgeShader` takes priority over `outline`: if both are given, only the in-face edge shading runs.

---

## Options

Every option is optional. **Invalid values always "fall back to the default + `console.warn`" and
never throw** — the layer can always be created, and any mistake stays traceable.

### Grid geometry

| Option         | Type   | Default | Description                                                       |
| -------------- | ------ | ------- | ----------------------------------------------------------------- |
| `originLon`    | number | `114.5` | West boundary longitude (degrees). Non-finite → default + warning |
| `originLat`    | number | `23.5`  | South boundary latitude (degrees)                                 |
| `cols`         | number | `1000`  | Logical column count; floor'd and ≥ 1                             |
| `rows`         | number | `1000`  | Logical row count; floor'd and ≥ 1                                |
| `cellSize`     | number | `0.01`  | Cell edge (degrees), must be > 0. `0.01°` ≈ 1.1 km                |
| `bottomHeight` | number | `30`    | Cell bottom elevation (meters, ellipsoid datum)                   |
| `gridHeight`   | number | `180`   | Column height (meters), must be > 0                               |

### Fill throttling

| Option         | Type   | Default     | Description                                                                                |
| -------------- | ------ | ----------- | ------------------------------------------------------------------------------------------ |
| `batchSize`    | number | `4000`      | Transfer block size: cells per Worker message. Affects only comms cost and prefetch memory |
| `pumpSize`     | number | `800`       | Initial cells written per frame, then adaptive                                             |
| `pumpBudgetMs` | number | `4`         | Per-frame `addBatch` sync time budget (ms). Higher fills faster but heavier frames         |
| `pumpMin`      | number | `256`       | Lower bound of cells per frame. Smaller → more Primitives, costlier picking                |
| `pumpMax`      | number | `batchSize` | Upper bound of cells per frame                                                             |

### Rendering strategy

| Option                 | Type    | Default | Description                                                                                   |
| ---------------------- | ------- | ------- | --------------------------------------------------------------------------------------------- |
| `instancing`           | boolean | `true`  | Use true instanced rendering. `false` falls back to the Primitive strategy                    |
| `chunkSize`            | number  | `128`   | Instanced chunk edge (cells), clamped to `[8, 1024]`. Sets draw calls and culling granularity |
| `heightChunksPerFrame` | number  | `4`     | Chunks rewritten per frame during height re-flow (throttle); instanced only                   |
| `mathPick`             | boolean | `true`  | Mathematical inverse picking. Always `true` in instanced mode                                 |
| `asyncGeometry`        | boolean | `true`  | Whether geometry is built asynchronously; Primitive mode only                                 |
| `outline`              | boolean | `true`  | Draw a separate wireframe Primitive (ignored when `edgeShader` is true)                       |
| `edgeShader`           | boolean | `true`  | Use a custom appearance to draw edges inside box faces                                        |
| `edgeAlpha`            | number  | `0.15`  | In-face edge opacity, clamped to `[0, 1]`                                                     |
| `edgeWidthPx`          | number  | `1.2`   | In-face edge width (pixels, constant on screen)                                               |

### Colors and interaction

| Option         | Type                                                         | Default             | Description                                                                                                     |
| -------------- | ------------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `fillColor`    | string \| `Cesium.Color`                                     | `#27D9FF` @ 0.42    | Default fill color                                                                                              |
| `outlineColor` | string \| `Cesium.Color`                                     | `#8CF3FF` @ 0.95    | Default outline color                                                                                           |
| `getCellColor` | `(col, row) => Color \| {fillColor?, outlineColor?} \| null` | —                   | Per-cell color provider (baked at creation). On throw, that cell falls back to the default color and warns once |
| `onClick`      | `(cell, event) => void`                                      | —                   | Left-click on an already-written cell                                                                           |
| `onMove`       | `(cell \| null, event) => void`                              | —                   | Mouse move (32 ms throttle; `cell` is `null` on miss)                                                           |
| `layerType`    | string                                                       | `'independentGrid'` | Written to `primitive._layerType` so external `scene.pick` can identify the layer                               |

### Worker

| Option          | Type                   | Default | Description                                 |
| --------------- | ---------------------- | ------- | ------------------------------------------- |
| `disableWorker` | boolean                | `false` | Force matrix computation on the main thread |
| `workerFactory` | `() => Worker \| null` | —       | Custom Worker factory                       |

---

## Handle API

```js
handle.viewer; // owning Viewer
handle.collection; // PrimitiveCollection; collection.show toggles visibility
handle.model; // effective grid parameters (defaults filled in)
handle.cells; // index of written cells: size / has(code) / get(code) / values() / clear()
handle.instanced; // instanced render object (null when instancing:false); getStats() gives chunks and bytes
handle.stats; // runtime diagnostic counters (cumulative)

handle.getLoadedCount(); // cells written to the scene
handle.getLogicalCount(); // logical total cells cols × rows
handle.getFillProgress(); // fill progress 0~1
handle.isFillDone(); // whether everything has been written
handle.getSelectedCode(); // currently selected cell code, null if none
handle.logStats(); // prints and returns a diagnostics snapshot

handle.setCellFillColor(code, color); // change one cell's fill color; false if the cell doesn't exist
handle.setCellOutlineColor(code, color); // change one cell's outline color
handle.setAllFillColor(color); // change the fill color of all written cells
handle.setAllOutlineColor(color); // change the outline color of all written cells

handle.pick(windowPosition); // pick by screen coords; null on miss
handle.getCellByLngLat(lng, lat); // get a written cell by lon/lat
handle.setVisible(visible); // show/hide the whole layer
handle.refresh(); // re-seed the fill order from the current camera center
handle.setBottomHeight(meters); // change the bottom elevation in place
handle.dispose(); // release (idempotent)
```

`cell` object shape:

```ts
{
  code: '12,34',    // cell code
  col: 12, row: 34, // column / row index (0-based)
  west, south, east, north,  // four boundary lon/lats (degrees)
  centerLon, centerLat,      // cell center lon/lat (degrees)
  fillColor, outlineColor,   // current colors (internal refs; do not mutate in place)
}
```

---

## Lifecycle and resource cleanup

**Recommended: do nothing.** The package wraps `viewer.destroy` when a layer is created, so
destroying the viewer automatically releases all layer resources (terminates the Worker, cancels
rAF and timers, destroys the `ScreenSpaceEventHandler`, removes the `PrimitiveCollection`). The
wrap is applied once per viewer and is safe to share across layers.

To release a single layer early, call `destroyGridLayer(handle)` — idempotent.

> The `viewer.destroy` wrap is the point of this layer: without it, consumers must remember to call
> `dispose` themselves, and a missed call leaks WebGL contexts and event listeners. Browsers cap
> the number of live WebGL contexts, and leaks surface as
> `Too many active WebGL contexts`.

Usage in Vue 3:

```ts
import { onUnmounted, shallowRef, markRaw } from 'vue';
import { createGridLayer, destroyGridLayer } from '@wjyfst/cesium-grid';

const handle = shallowRef(null); // use shallowRef for complex Cesium objects, never ref/reactive

onUnmounted(() => {
  destroyGridLayer(handle.value); // omittable if the viewer is destroyed at the same lifecycle
  handle.value = null;
});
```

---

## Workers and bundlers

Matrix packing is handed to a Web Worker by default (per-batch `modelMatrix` computation,
zero-copy via `transfer`); the main thread keeps a 3-batch prefetch pipeline. Worker resolution
tries four paths in priority order:

1. `options.workerFactory` — injected by the caller;
2. `globalThis.__CESIUM_GRID_WORKER__` — a globally injected constructor (the Vite `?worker` pattern);
3. Built-in default — `new Worker(new URL('./gridMatrix.worker.js', import.meta.url), { type: 'module' })`,
   statically recognized by both Vite and Webpack 5;
4. All fail → return `null` and **fall back to synchronous main-thread computation** (behavior is
   identical; only the matrix math moves back to the main thread).

**Note**: if your bundler pre-bundles this package (Vite's `optimizeDeps`), `import.meta.url`
points at the pre-bundled output and the worker asset 404s. Pick one:

```js
// vite.config.js
export default defineConfig({
  optimizeDeps: { exclude: ['@wjyfst/cesium-grid'] },
});
```

```js
// Or inject explicitly (Vite projects)
import GridWorker from '@wjyfst/cesium-grid/src/gridMatrix.worker.js?worker';
globalThis.__CESIUM_GRID_WORKER__ = GridWorker;
```

Set `disableWorker: true` if you don't want a Worker.

**Worker crashes are recoverable**: in-flight batches keep a copy of the cell list on the main
thread, so when the Worker errors those cells are taken back onto the main thread and computed
there — the fill never stalls at some percentage (this path is covered by tests).

---

## Cesium version and internal APIs

This package uses Cesium **renderer-layer APIs** directly: `Buffer` / `VertexArray` /
`DrawCommand` / `ShaderProgram` / `RenderState` / `Context.createPickId`. These are Cesium
internals with no cross-major-version compatibility guarantee, therefore:

- `peerDependencies` pins `cesium >=1.110.0 <2.0.0`;
- development and verification target **cesium 1.143.0** — key behaviors noted in the source
  comments were checked against that version (file and line references are in the header of
  `src/instancedGridPrimitive.js`);
- **run the manual checklist below before upgrading Cesium across a major version**.

The instanced strategy also deliberately avoids two known pitfalls (see source comments):

- attribute index 0 must not have `instanceDivisor > 0`, so `position` takes 0 and instance
  attributes start at 2;
- shared vertex/index buffers must set `vertexArrayDestroyable = false`, otherwise
  `VertexArray.destroy()` destroys them along with the array.

---

## Development and testing

```bash
npm install
npm test          # vitest run (110 cases)
npm run check     # node --check across all sources
npm run verify:pack   # packaging smoke test: temp Vite app build, verifies exports and Worker chunk
npm run format    # prettier
```

Tests are split into four groups:

| File                                  | Coverage                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/gridMath.test.js`               | ellipsoid radius formulas, ENU orthogonality, numerical equivalence of the two matrix schemes, ring-fill completeness/dedup and out-of-range clipping |
| `test/gridLayer.options.test.js`      | option normalization, invalid-input fallback, callback exception isolation                                                                            |
| `test/gridLayer.lifecycle.test.js`    | fill progress, selection state, height re-flow, dispose cleanup, `viewer.destroy` auto-cleanup, Worker fallback and crash recovery                    |
| `test/instancedGridPrimitive.test.js` | chunking and draw-call count, instanceCount, dirty-range upload, shared-buffer ownership, GPU resource release                                        |

`npm run verify:pack` is a **packaging smoke test**: it generates a minimal temp Vite app (with a
`file:` dependency on this package), builds it, then asserts that a standalone
`gridMatrix.worker-*.js` chunk exists and that the main bundle contains a
`new Worker(new URL(".../gridMatrix.worker-*.js", import.meta.url))` reference. Unit tests can't
cover this path (vitest mocks `cesium` and the Worker goes down the injection branch), but if it
breaks, users see a worker 404 and a silent main-thread fallback — functionality doesn't error,
the main thread just stalls, and that is very hard to trace.

### Manual checklist (browser-side, not unit-testable in Node)

The automated tests replace Cesium with `vi.mock('cesium')`, so the following **real rendering
behaviors must be confirmed visually in a browser**:

- [ ] The grid aligns correctly with the target lon/lat extent, with no overall offset;
- [ ] Per-cell data colors match the palette, with no large uniformly-colored areas;
- [ ] Grid lines are visible and keep constant width while zooming (`fwidth` working);
- [ ] Translucent cells sort correctly over terrain/imagery, with no obvious interpenetration;
- [ ] With `requestRenderMode` on, recoloring / height re-flow still triggers a redraw;
- [ ] Click-to-select (alpha raised to 1) and click-again-to-restore behave normally;
- [ ] After `setBottomHeight`, colors and selection are preserved with no flicker or gaps;
- [ ] Written cells don't disappear when panning/zooming out; frustum culling works;
- [ ] Repeatedly entering/leaving the page or HMR causes no `Too many active WebGL contexts`;
- [ ] If using `mathPick: false`, GPU picking (`scene.pick` + `drillPick`) hits correctly.

---

## Known limitations

- **Outline hue in instanced mode** can only be this cell's fill RGB (edges are derived from the
  fill color in the fragment shader). Use `createPrimitiveGridLayer` if you need an independent hue.
- **Instanced mode has no GPU picking**: the whole layer shares one pickId, `scene.pick` can't
  recover an instance id, so picking must use the mathematical inverse.
- **Mathematical inverse picking intersects only the ellipsoid (h=0)**, ignoring `bottomHeight` /
  `gridHeight`. The taller the column and the more oblique the view, the larger the horizontal
  error (≈ column height × tan(angle from nadir)). A 30 m column at 0.01° cell size is under 0.1
  cell and negligible; for kilometer-scale columns use `mathPick: false`.
- **Cells are a lon/lat grid**, so east–west physical length shrinks by `cos(lat)` at high
  latitudes (scale conversion uses the prime-vertical radius of curvature, so cells are still
  correct metric cubes — they just get narrower in longitude).
- **`cells.get()` returns a temporary proxy record in instanced mode** (a new one each call; field
  reads/writes go straight to the TypedArray). Don't hold it across calls.

---

## License

[MIT](./LICENSE)
