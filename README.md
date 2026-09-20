# @wjyfst/cesium-grid

CesiumJS **亿级独立立体网格**图层：真实 GPU 实例化渲染、从相机中心向外分批填充、
逐格数据着色、O(1) 拾取。

面向的场景：气象格点（温度/湿度/风速/降水）、环境数值要素、任何「格网 + 逐格数值着色 + 需要立体高度层」的三维可视化。

---

## 为什么值得用

| 能力         | 实现方式                                                                 | 结果                                      |
| ------------ | ------------------------------------------------------------------------ | ----------------------------------------- |
| 亿级格秒开   | 只从相机中心向外逐帧填充，首屏不必等全量数据                             | 首帧时间与格数无关                        |
| 显存占用低   | 一份单位盒几何被所有格共享，每格只传 3×4 矩阵（48 B）+ RGBA8 颜色（4 B） | **52 B/格**，1 亿格满铺约 5.2 GB          |
| draw call 少 | 按 `chunkSize` 分块，每块一个 `DrawCommand`                              | 1 亿格（10000×10000）/ 块边长 128 ≈ 6200 个 draw call |
| 拾取便宜     | 屏幕坐标反算经纬度直接取格，不产生离屏拾取渲染                           | **O(1)**，与格数无关                      |
| 逐格数据色   | `getCellColor(col, row)` 在创建期烘焙进实例缓冲                          | 首屏即数据色，无「基础色 + 事后换色」双写 |
| 高度层切换   | `setBottomHeight(z)` 就地重写实例矩阵，分帧限流                          | 不重建图层、不丢颜色与选中态              |
| 内存可控     | 未触及的块不分配 CPU 缓冲                                                | 1 亿格不会在构造时吃掉数 GB               |

---

## 安装

```bash
# 从 GitHub 安装（当前推荐，无需 npm 账号）
npm install github:wjyfst/cesium-grid

# 或固定到某个 tag / commit
npm install github:wjyfst/cesium-grid#v0.1.0
```

`cesium` 是 peer dependency，由你的应用提供（版本需 `>=1.110.0 <2.0.0`）：

```bash
npm install cesium
```

本地开发时也可以用 `file:` 协议：

```bash
npm install /path/to/cesium-grid
```

---

## 快速上手

```js
import * as Cesium from 'cesium';
import { createGridLayer, destroyGridLayer } from '@wjyfst/cesium-grid';

const viewer = new Cesium.Viewer('cesiumContainer');

// 网格范围：西边界经度 / 南边界纬度 / 行列数 / 格边长（度）
const handle = createGridLayer(viewer, {
  originLon: 115.8,
  originLat: 23.5,
  cols: 470,
  rows: 480,
  cellSize: 0.01, // 约 1.1 km
  bottomHeight: 0, // 底面高度（米）
  gridHeight: 30, // 柱体高度（米）
  fillColor: '#FF7043',
  // 逐格着色：返回 { fillColor, outlineColor } 可让框线与本格同 RGB、透明度独立
  getCellColor: (col, row) => {
    const value = myData[row]?.[col];
    if (!Number.isFinite(value)) return null; // null → 用图层默认色
    const color = palette(value); // 你的调色板
    return { fillColor: color.withAlpha(0.5), outlineColor: color.withAlpha(0.8) };
  },
  onClick: (cell) => console.log('点击', cell.code, cell.centerLon, cell.centerLat),
});

// 高度层切换（原地重烘焙，保留颜色与选中态）
handle.setBottomHeight(300);

// 读取进度 / 诊断
console.log(handle.getFillProgress(), handle.logStats());

// 释放（幂等）。若 viewer 会被 destroy，则无需手动调用
destroyGridLayer(handle);
```

### 三个入口

```js
import {
  createGridLayer, // 推荐入口：默认方案
  createInstancedGridLayer, // 显式声明例化方案（与默认一致，用于自文档化）
  createPrimitiveGridLayer, // Primitive 方案：支持独立框线色相与 GPU 拾取
} from '@wjyfst/cesium-grid';
```

`createGridLayer` 的第三个参数是内部预设槽位，日常无需使用；三个入口的 `options` 完全一致。

### 纯计算入口（不需要 WebGL / DOM）

```js
// 只引纯计算子路径：不会拉入 cesium
import { packCellsMatrices, createRingFill } from '@wjyfst/cesium-grid/math';

const fill = createRingFill(100, 200, 1000, 1000);
let batch;
while (!fill.isDone()) {
  batch = fill.nextBatch(4000); // Int32Array [col,row,col,row,...]
  // ... 在 Node 里预计算矩阵
}
```

纯计算函数也从主入口导出（`import { createRingFill } from '@wjyfst/cesium-grid'`），但那样会连带加载 `cesium`。

> **`/math` 是唯一能在裸 Node 里 import 的入口。** 主入口会加载 `cesium`，而 Cesium 自身的 ESM 产物
> 在裸 Node 下无法解析（报 `does not provide an export named '_shadersPolygonSignedDistanceFS'`）。
> 这是 Cesium 的打包问题、不是本包的问题——任何 `import 'cesium'` 的代码在裸 Node 下都一样。因此：
>
> - Node 里做数据预处理 / 预计算矩阵 → 用 `@wjyfst/cesium-grid/math`；
> - 建图层 → 在浏览器或打包器（Vite / Webpack）环境里用主入口。
>
> 本包的测试通过 `vi.mock('cesium')` 绕开这一点，因此 `gridLayer` 的逻辑在 Node 下仍被完整覆盖。

---

## 渲染方案

本包有两条渲染路径，默认走**例化方案**。

|            | 例化方案（默认）              | Primitive 方案                                         |
| ---------- | ----------------------------- | ------------------------------------------------------ |
| 开启方式   | 默认 / `instancing: true`     | `instancing: false`（或用 `createPrimitiveGridLayer`） |
| 每格显存   | **52 B**                      | 约 1440 B                                              |
| draw call  | 每块 1 个                     | 每批 2 个（填充 + 线框）                               |
| 几何构建   | 无（顶点着色器逐格变换）      | 异步 `createGeometry` / `combineGeometry`              |
| 写入可见性 | 下一帧即渲染                  | 需等 Primitive `ready`（有延迟补写机制）               |
| 框线色相   | 只能取本格填充色 RGB（描边）  | **可独立设色相**                                       |
| GPU 拾取   | 不可用（整层共用一个 pickId） | 可用（`mathPick: false`）                              |
| CPU 侧内存 | 12 B/格                       | 约 501 B/格                                            |

**什么时候需要退回 Primitive 方案**：柱体很高（上千米）或视角极斜，数学反算拾取因只交椭球（h=0）产生的水平偏差不可接受时；或业务要求框线与填充不同色相时。

### 格线三选一

| 配置                               | 效果                                                                 | 每格顶点 |
| ---------------------------------- | -------------------------------------------------------------------- | -------- |
| `edgeShader: true`（默认）         | 自定义 Appearance 在盒面内描边，线宽用 `fwidth` 换算成像素级恒定宽度 | 24       |
| `edgeShader: false, outline: true` | 独立线框 Primitive，可用不同色相                                     | 48       |
| `outline: false`                   | 不画格线（低端机降级开关）                                           | 24       |

`edgeShader` 优先级高于 `outline`：两者同时给时只走盒面描边。

---

## 选项表

所有选项均可省略。**非法值一律「回退默认值 + `console.warn`」，不抛错**——图层在任何情况下都能建起来，且错误可定位。

### 网格几何

| 选项           | 类型   | 默认值  | 说明                                         |
| -------------- | ------ | ------- | -------------------------------------------- |
| `originLon`    | number | `114.5` | 网格西边界经度（度）。非有限值回退默认并告警 |
| `originLat`    | number | `23.5`  | 网格南边界纬度（度）                         |
| `cols`         | number | `1000`  | 逻辑列数，向下取整且 ≥ 1                     |
| `rows`         | number | `1000`  | 逻辑行数，向下取整且 ≥ 1                     |
| `cellSize`     | number | `0.01`  | 格边长（度），必须 > 0。`0.01°` ≈ 1.1 km     |
| `bottomHeight` | number | `30`    | 格底面高度（米，椭球基准）                   |
| `gridHeight`   | number | `180`   | 柱体高度（米），必须 > 0                     |

### 填充节流

| 选项           | 类型   | 默认值      | 说明                                                         |
| -------------- | ------ | ----------- | ------------------------------------------------------------ |
| `batchSize`    | number | `4000`      | 传输块大小：单条 Worker 消息的格数。只影响通信开销与预取内存 |
| `pumpSize`     | number | `800`       | 每帧写入格数初值，随后自适应                                 |
| `pumpBudgetMs` | number | `4`         | 每帧 `addBatch` 同步耗时预算（毫秒）。调大铺满更快但单帧更重 |
| `pumpMin`      | number | `256`       | 每帧写入格数下限。越小 Primitive 越多、拾取越贵              |
| `pumpMax`      | number | `batchSize` | 每帧写入格数上限                                             |

### 渲染方案

| 选项                   | 类型    | 默认值 | 说明                                                                  |
| ---------------------- | ------- | ------ | --------------------------------------------------------------------- |
| `instancing`           | boolean | `true` | 是否走真实例化渲染。`false` 退回 Primitive 方案                       |
| `chunkSize`            | number  | `128`  | 例化模式块边长（格数），夹到 `[8, 1024]`。决定 draw call 数与剔除粒度 |
| `heightChunksPerFrame` | number  | `4`    | 高度回流时每帧重写的块数（限流），仅例化模式                          |
| `mathPick`             | boolean | `true` | 数学反算拾取。例化模式下恒为 `true`                                   |
| `asyncGeometry`        | boolean | `true` | 几何是否异步创建，仅 Primitive 模式                                   |
| `outline`              | boolean | `true` | 是否绘制独立线框 Primitive（`edgeShader` 为 true 时忽略）             |
| `edgeShader`           | boolean | `true` | 是否用自定义外观在盒面内描边                                          |
| `edgeAlpha`            | number  | `0.15` | 盒面描边透明度，夹到 `[0, 1]`                                         |
| `edgeWidthPx`          | number  | `1.2`  | 盒面描边线宽（像素，屏幕上恒定）                                      |

### 颜色与交互

| 选项           | 类型                                                         | 默认值              | 说明                                                         |
| -------------- | ------------------------------------------------------------ | ------------------- | ------------------------------------------------------------ |
| `fillColor`    | string \| `Cesium.Color`                                     | `#27D9FF` @ 0.42    | 默认填充色                                                   |
| `outlineColor` | string \| `Cesium.Color`                                     | `#8CF3FF` @ 0.95    | 默认框线色                                                   |
| `getCellColor` | `(col, row) => Color \| {fillColor?, outlineColor?} \| null` | —                   | 逐格颜色提供器（创建期烘焙）。抛错时该格回退默认色并告警一次 |
| `onClick`      | `(cell, event) => void`                                      | —                   | 左键点击已写入格                                             |
| `onMove`       | `(cell \| null, event) => void`                              | —                   | 鼠标移动（32 ms 节流；未命中格时 `cell` 为 `null`）          |
| `layerType`    | string                                                       | `'independentGrid'` | 写入 `primitive._layerType`，供外部 `scene.pick` 识别图层    |

### Worker

| 选项            | 类型                   | 默认值  | 说明               |
| --------------- | ---------------------- | ------- | ------------------ |
| `disableWorker` | boolean                | `false` | 强制主线程计算矩阵 |
| `workerFactory` | `() => Worker \| null` | —       | 自定义 Worker 工厂 |

---

## 句柄 API

```js
handle.viewer; // 所属 Viewer
handle.collection; // PrimitiveCollection；collection.show 可切换显隐
handle.model; // 生效后的网格参数（默认值已填充）
handle.cells; // 已写入格索引：size / has(code) / get(code) / values() / clear()
handle.instanced; // 例化渲染对象（instancing:false 时为 null），getStats() 给块数与字节
handle.stats; // 运行期诊断计数（累计值）

handle.getLoadedCount(); // 已写入场景的格数
handle.getLogicalCount(); // 逻辑总格数 cols × rows
handle.getFillProgress(); // 填充进度 0~1
handle.isFillDone(); // 是否已全部写入
handle.getSelectedCode(); // 当前选中格编码，未选中为 null
handle.logStats(); // 打印并返回诊断汇总快照

handle.setCellFillColor(code, color); // 改单格填充色；格不存在返回 false
handle.setCellOutlineColor(code, color); // 改单格框线色
handle.setAllFillColor(color); // 改已写入全部格的填充色
handle.setAllOutlineColor(color); // 改已写入全部格的框线色

handle.pick(windowPosition); // 按屏幕坐标拾取；未命中返回 null
handle.getCellByLngLat(lng, lat); // 按经纬度取已写入的格
handle.setVisible(visible); // 显隐整个图层
handle.refresh(); // 以当前相机中心重播种填充顺序
handle.setBottomHeight(meters); // 原地改底面高度
handle.dispose(); // 释放（幂等）
```

`cell` 对象结构：

```ts
{
  code: '12,34',    // 格编码
  col: 12, row: 34, // 行列号（0 起）
  west, south, east, north,  // 四边界经纬度（度）
  centerLon, centerLat,      // 格中心经纬度（度）
  fillColor, outlineColor,   // 当前颜色（内部引用，勿就地修改）
}
```

---

## 生命周期与资源回收

**推荐做法：什么都不用做。** 本包在创建图层时会包装 `viewer.destroy`，销毁 viewer 时自动回收全部图层资源（终止 Worker、取消 rAF 与定时器、销毁 `ScreenSpaceEventHandler`、移除 `PrimitiveCollection`）。同一 viewer 只包装一次，多个图层共用也安全。

需要提前单独释放某个图层时调用 `destroyGridLayer(handle)`，幂等。

> `viewer.destroy` 包装是这层的重点：没有它，消费者就得自己记住调用 `dispose`，漏调会造成 WebGL 上下文与事件监听泄漏。浏览器有 WebGL 上下文数量上限，泄漏会报 `Too many active WebGL contexts`。

在 Vue 3 中使用：

```ts
import { onUnmounted, shallowRef, markRaw } from 'vue';
import { createGridLayer, destroyGridLayer } from '@wjyfst/cesium-grid';

const handle = shallowRef(null); // Cesium 复杂对象用 shallowRef，绝不用 ref/reactive

onUnmounted(() => {
  destroyGridLayer(handle.value); // 若 viewer 同生命周期销毁，此行可省
  handle.value = null;
});
```

---

## Worker 与打包器

矩阵打包默认交给 Web Worker（每批 `modelMatrix` 计算，`transfer` 零拷贝），主线程保持 3 批预取流水线。Worker 解析按优先级尝试四条路径：

1. `options.workerFactory` —— 调用方注入；
2. `globalThis.__CESIUM_GRID_WORKER__` —— 全局注入的构造器（Vite `?worker` 用法）；
3. 内置默认 —— `new Worker(new URL('./gridMatrix.worker.js', import.meta.url), { type: 'module' })`，Vite 与 Webpack 5 都能静态识别；
4. 全部失败 → 返回 `null`，**回退主线程同步计算**（功能完全一致，只是矩阵计算回到主线程）。

**注意**：若打包器把本包纳入依赖预打包（Vite 的 `optimizeDeps`），`import.meta.url` 会指向预打包产物导致 worker 资源 404。二选一：

```js
// vite.config.js
export default defineConfig({
  optimizeDeps: { exclude: ['@wjyfst/cesium-grid'] },
});
```

```js
// 或显式注入（Vite 项目）
import GridWorker from '@wjyfst/cesium-grid/src/gridMatrix.worker.js?worker';
globalThis.__CESIUM_GRID_WORKER__ = GridWorker;
```

不需要 Worker 时设 `disableWorker: true`。

**Worker 崩溃可恢复**：在途批次会在主线程留一份格清单副本，Worker 报错时把这些格抢回主线程计算，因此填充不会卡在某个百分比（这条路径有测试覆盖）。

---

## Cesium 版本与内部 API

本包直接使用 Cesium **渲染器层 API**：`Buffer` / `VertexArray` / `DrawCommand` / `ShaderProgram` / `RenderState` / `Context.createPickId`。这些是 Cesium 内部接口，官方不保证跨大版本兼容，因此：

- `peerDependencies` 锁定 `cesium >=1.110.0 <2.0.0`；
- 开发与验证版本为 **cesium 1.143.0**，源码注释中标注的关键行为都对着该版本核实（含文件与行号，见 `src/instancedGridPrimitive.js` 头部）；
- **升级 Cesium 大版本前请先跑通下面的手工验证清单**。

例化方案还刻意绕开了两个已知陷阱（详见源码注释）：

- attribute index 0 不能有 `instanceDivisor > 0`，故 `position` 占 0、实例属性从 2 起；
- 共享顶点/索引缓冲必须置 `vertexArrayDestroyable = false`，否则 `VertexArray.destroy()` 会连带销毁它们。

---

## 开发与测试

```bash
npm install
npm test          # vitest run（110 个用例）
npm run check     # node --check 全部源码
npm run verify:pack   # 打包冒烟：临时 Vite 应用构建，验证 exports 与 Worker chunk
npm run format    # prettier
```

测试分四组：

| 文件                                  | 覆盖                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `test/gridMath.test.js`               | 椭球半径公式、ENU 正交性、两种矩阵方案的数值等价性、方环填充的不重不漏与越界裁剪           |
| `test/gridLayer.options.test.js`      | 选项归一化、非法入参回退、回调异常隔离                                                     |
| `test/gridLayer.lifecycle.test.js`    | 填充进度、选中态、高度回流、dispose 回收、`viewer.destroy` 自动清理、Worker 回退与崩溃恢复 |
| `test/instancedGridPrimitive.test.js` | 分块与 draw call 数、instanceCount、脏区间上传、共享缓冲所有权、GPU 资源释放               |

`npm run verify:pack` 是一条**打包冒烟**：临时生成一个最小 Vite 应用（用 `file:` 依赖指向本包），
构建后断言「存在 `gridMatrix.worker-*.js` 独立 chunk」且「主 bundle 里有
`new Worker(new URL(".../gridMatrix.worker-*.js", import.meta.url))` 引用」。这条路径单测覆盖不到
（vitest 里 `cesium` 被 mock、Worker 走注入分支），但一旦坏了，用户装完包会看到 worker 404 并静默
回退主线程——功能不报错、只是主线程卡，很难定位。

### 手工验证清单（浏览器端，无法在 Node 单测）

自动化测试用 `vi.mock('cesium')` 替换了 Cesium，因此以下**真实渲染行为必须在浏览器里目视确认**：

- [ ] 网格正确贴合目标经纬度范围，无整体偏移；
- [ ] 逐格数据色与调色板一致，无整片同色；
- [ ] 格线可见且宽度在缩放时保持恒定（`fwidth` 生效）；
- [ ] 半透明格叠在地形/影像上的排序正确，无明显穿插错误；
- [ ] 开启 `requestRenderMode` 后，换色 / 高度回流仍能触发重绘；
- [ ] 点击选中（alpha 提到 1）与再次点击还原正常；
- [ ] `setBottomHeight` 切换高度层后颜色与选中态保留、无空洞闪烁；
- [ ] 相机拉远 / 平移时已写入格不消失，视锥剔除正常；
- [ ] 反复进出页面 / HMR 后无 `Too many active WebGL contexts`；
- [ ] 若用 `mathPick: false`，GPU 拾取（`scene.pick` + `drillPick`）命中正确。

---

## 已知限制

- **例化模式的框线色相**只能取本格填充色 RGB（描边由片元着色器从填充色推导），需要独立色相请用 `createPrimitiveGridLayer`。
- **例化模式不支持 GPU 拾取**：整层共用一个 pickId，`scene.pick` 拿不到实例 id，拾取只能走数学反算。
- **数学反算拾取只交椭球（h=0）**，忽略 `bottomHeight` / `gridHeight`。柱体越高、视角越斜，水平偏差越大（≈ 柱高 × tan(离天底角)）。30 m 柱高在 0.01° 格边长下不足 0.1 格可忽略；柱高上千米时请用 `mathPick: false`。
- **格是经纬度网格**，高纬处东西向物理边长会按 `cos(lat)` 收缩（尺度换算已按卯酉圈曲率处理，故仍是正确的米制立方体，只是格在经度方向变窄）。
- **`cells.get()` 在例化模式返回临时代理记录**（每次新建、字段读写直接落到 TypedArray），不要跨调用持有。

---

## License

[MIT](./LICENSE)
