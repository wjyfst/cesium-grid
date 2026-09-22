/**
 * @wjyfst/cesium-grid 类型声明（手写）。
 *
 * 覆盖对外入口、选项、句柄与渲染层对象。底层 Cesium 内部 API（DrawCommand / VertexArray /
 * Buffer / ShaderProgram / RenderState）不在此声明中暴露为具体类型——它们是 Cesium 私有接口，
 * 随版本变动，故统一用 `unknown` 或最小结构描述，避免给出会漂移的假类型。
 */

import type { Cartesian2, Color, PrimitiveCollection, Viewer } from 'cesium';

// ============================ 选项 ============================

/** 逐格颜色提供器：返回 Color 只改填充色；返回对象可让填充/框线各取本格颜色；返回 null 用图层默认色。 */
export type CellColorProvider = (
  col: number,
  row: number,
) => Color | { fillColor?: Color; outlineColor?: Color } | null | undefined;

/** Worker 工厂：返回实现了 postMessage 的 Worker；返回假值则继续尝试内置加载方式。 */
export type GridWorkerFactory = () => Worker | null | undefined;

export interface GridLayerOptions {
  /** 网格西边界经度（度）。默认 114.5。非有限值回退默认并告警。 */
  originLon?: number;
  /** 网格南边界纬度（度）。默认 23.5。非有限值回退默认并告警。 */
  originLat?: number;
  /** 逻辑列数，向下取整且至少为 1。默认 1000。 */
  cols?: number;
  /** 逻辑行数，向下取整且至少为 1。默认 1000。 */
  rows?: number;
  /** 格边长（度）。必须 > 0，默认 0.01（约 1.1 km）。 */
  cellSize?: number;
  /** 格底面高度（米，椭球基准）。默认 30。 */
  bottomHeight?: number;
  /** 格柱体高度（米）。默认 180。 */
  gridHeight?: number;

  /** 传输块大小：单条 Worker 消息（无 Worker 时为主线程单次直算）的格数。默认 4000。 */
  batchSize?: number;
  /** 每帧写入格数初值，随后按 pumpBudgetMs 自适应。默认 800。 */
  pumpSize?: number;
  /** 每帧 addBatch 同步耗时的预算（毫秒）。默认 4。 */
  pumpBudgetMs?: number;
  /** 每帧写入格数下限。默认 256。越小 Primitive 越多、draw call 与拾取越贵。 */
  pumpMin?: number;
  /** 每帧写入格数上限。默认 batchSize。 */
  pumpMax?: number;

  /** 是否用数学反算拾取（O(1)，无离屏拾取渲染）。默认 true。例化模式下恒为数学反算。 */
  mathPick?: boolean;
  /** 几何是否异步创建（Primitive.asynchronous）。默认 true。仅 instancing:false 时生效。 */
  asyncGeometry?: boolean;
  /** 是否走真实例化渲染。默认 true（推荐）。置 false 退回 Primitive 方案。 */
  instancing?: boolean;
  /** 例化模式的块边长（格数），决定 draw call 数与剔除粒度，夹到 [8, 1024]。默认 128。 */
  chunkSize?: number;
  /** 高度回流时每帧重写的块数（限流）。默认 4。仅例化模式生效。 */
  heightChunksPerFrame?: number;

  /** 默认填充色（CSS 颜色串或 Cesium.Color）。 */
  fillColor?: string | Color;
  /** 默认框线色（CSS 颜色串或 Cesium.Color）。 */
  outlineColor?: string | Color;
  /** 是否绘制独立线框 Primitive。默认 true；edgeShader 为 true 时被忽略。 */
  outline?: boolean;
  /** 是否用自定义外观在盒面内描边（替代独立线框 Primitive）。默认 true。 */
  edgeShader?: boolean;
  /** edgeShader 模式下的描边透明度（0~1）。默认 0.15。 */
  edgeAlpha?: number;
  /** edgeShader 模式下的描边线宽（像素，屏幕上恒定）。默认 1.2。 */
  edgeWidthPx?: number;

  /** primitive 类型标记（写入 _layerType，供外部 scene.pick 识别）。默认 'independentGrid'。 */
  layerType?: string;
  /** 逐格颜色提供器（创建期烘焙，首屏即数据色）。抛错时该格回退默认色并告警一次。 */
  getCellColor?: CellColorProvider;

  /** 左键点击已写入格的回调（内部异常被捕获，不影响填充与拾取）。 */
  onClick?: (cell: GridCell, movement: unknown) => void;
  /** 鼠标移动回调（32ms 节流；未命中格时 cell 为 null）。 */
  onMove?: (cell: GridCell | null, movement: unknown) => void;

  /** true = 跳过 Worker，强制主线程计算矩阵。默认 false。 */
  disableWorker?: boolean;
  /** 自定义 Worker 工厂；用于自定义 worker 加载策略或规避打包器问题。 */
  workerFactory?: GridWorkerFactory;
}

// ============================ 数据对象 ============================

/** 对外暴露的格描述对象（onClick / onMove / pick / getCellByLngLat 的产物）。 */
export interface GridCell {
  /** 格编码，形如 "12,34" */
  code: string;
  /** 列号（0 起） */
  col: number;
  /** 行号（0 起） */
  row: number;
  /** 西边界经度（度） */
  west: number;
  /** 南边界纬度（度） */
  south: number;
  /** 东边界经度（度） */
  east: number;
  /** 北边界纬度（度） */
  north: number;
  /** 格中心经度（度） */
  centerLon: number;
  /** 格中心纬度（度） */
  centerLat: number;
  /** 当前填充色（内部引用，勿就地修改） */
  fillColor: Color;
  /** 当前框线色（内部引用，勿就地修改） */
  outlineColor: Color;
}

/** 生效后的网格参数（默认值已填充，颜色字段为 Cesium.Color 实例）。 */
export interface GridModel {
  originLon: number;
  originLat: number;
  cols: number;
  rows: number;
  cellSize: number;
  bottomHeight: number;
  gridHeight: number;
  batchSize: number;
  fillColor: Color;
  outlineColor: Color;
}

/** 运行期诊断计数（累计值，refresh 不清零）。 */
export interface GridLayerStats {
  pumpFrames: number;
  pumpedCells: number;
  cellsPerFrameMax: number;
  pumpCostTotalMs: number;
  pumpCostMaxMs: number;
  pumpOverBudgetFrames: number;
  pickCount: number;
  pickCostTotalMs: number;
  pickCostMaxMs: number;
  workerBatches: number;
  primitiveCount: number;
  pumpSize: number;
  instancedWriteTotalMs: number;
  instancedWriteMaxMs: number;
}

/** logStats 的返回快照。 */
export interface GridLayerStatsSnapshot extends GridLayerStats {
  notReadyPrimitives: number;
  primitiveLikeCount: number;
  avgPumpCostMs: number;
  avgPickCostMs: number;
  avgWriteCostMs: number;
  instanced: InstancedGridStats | null;
}

/** 已写入格索引。例化模式为紧凑 TypedArray 存储，Primitive 模式为 Map。 */
export interface GridCellStore {
  readonly size: number;
  has(code: string): boolean;
  get(code: string): unknown;
  values(): IterableIterator<unknown>;
  clear(): void;
}

/** 例化渲染层统计。 */
export interface InstancedGridStats {
  /** 块总数 */
  chunks: number;
  /** 块边长（格数） */
  chunkSize: number;
  /** 逻辑容量（cols × rows），不等于已分配量 */
  capacity: number;
  /** 每格实例数据字节数（3×vec4 矩阵 + RGBA8 颜色 = 52） */
  bytesPerInstance: number;
  /** 已分配 CPU 侧缓冲的块数 */
  allocatedChunks: number;
  /** 已分配的 CPU 侧缓冲字节数 */
  allocatedBytes: number;
  /** 已写入格数 */
  writtenCells: number;
  /** 矩阵缓冲字节数 */
  matrixBytes: number;
  /** 颜色缓冲字节数 */
  colorBytes: number;
  /** 发生高度回流重写的帧数 */
  heightRewriteFrames: number;
  /** 累计上传字节数 */
  uploadBytes: number;
}

/** 例化渲染对象（可作为 PrimitiveCollection 成员，实现 update / destroy / isDestroyed）。 */
export interface InstancedGridPrimitive {
  _layerType: string;
  show: boolean;
  readonly instanceCount: number;
  update(frameState: unknown): void;
  destroy(): void;
  isDestroyed(): boolean;
  getStats(): InstancedGridStats;
  writePackedCells(
    packed: Int32Array,
    getColor?: (col: number, row: number) => Color | null,
    onCell?: (col: number, row: number, handle: number, color: Color | null) => void,
  ): Int32Array;
  setCellColor(handle: number, color: Color): boolean;
  setAllFillColor(color: Color): void;
  setBottomHeight(): void;
}

/** createInstancedGridPrimitive 的配置。 */
export interface InstancedGridPrimitiveOptions {
  model: Pick<
    GridModel,
    'originLon' | 'originLat' | 'cols' | 'rows' | 'cellSize' | 'bottomHeight' | 'gridHeight'
  >;
  chunkSize?: number;
  layerType?: string;
  edgeAlpha?: number;
  edgeWidthPx?: number;
  heightChunksPerFrame?: number;
}

// ============================ 句柄 ============================

/** 网格图层句柄（createGridLayer / createIndependentGridLayer 的返回值）。 */
export interface GridLayerHandle {
  readonly viewer: Viewer;
  /** 承载全部批次的集合；dispose 时整体移除，其 show 属性可切换显隐 */
  readonly collection: PrimitiveCollection;
  /** 生效后的网格参数 */
  readonly model: GridModel;
  /** 已写入格索引 */
  readonly cells: GridCellStore;
  /** 例化渲染对象；instancing:false 时为 null */
  readonly instanced: InstancedGridPrimitive | null;
  readonly stats: GridLayerStats;
  /** 已写入场景的格数 */
  getLoadedCount(): number;
  /** 逻辑总格数 cols × rows */
  getLogicalCount(): number;
  /** 填充进度，0~1 */
  getFillProgress(): number;
  /** 是否已把全部逻辑格写入完毕 */
  isFillDone(): boolean;
  /** 当前选中格编码；未选中为 null */
  getSelectedCode(): string | null;
  /** 打印并返回一次诊断汇总快照 */
  logStats(): GridLayerStatsSnapshot;
  /** 改单格填充色并同步 baseFillColor；格不存在返回 false */
  setCellFillColor(code: string, color: string | Color): boolean;
  /** 改单格框线色；格不存在返回 false */
  setCellOutlineColor(code: string, color: string | Color): boolean;
  /** 改已写入全部格的填充色 */
  setAllFillColor(color: string | Color): void;
  /** 改已写入全部格的框线色 */
  setAllOutlineColor(color: string | Color): void;
  /** 按屏幕坐标拾取本图层格；未命中返回 null */
  pick(windowPosition: Cartesian2): GridCell | null;
  /** 按经纬度取已写入的格；未命中返回 null */
  getCellByLngLat(lng: number, lat: number): GridCell | null;
  /** 显隐整个图层 */
  setVisible(visible: boolean): void;
  /** 以当前相机中心重播种填充顺序；已写入格不受影响 */
  refresh(): void;
  /** 原地改底面高度（米），已写入格按原批次逐帧重烘焙 */
  setBottomHeight(newBottomHeight: number): void;
  /** 释放 Worker / 事件监听 / Primitive（幂等） */
  dispose(): void;
  /** @internal */
  readonly _internal: unknown;
}

// ============================ 函数 ============================

/**
 * 创建网格图层（推荐入口）。options 中的显式字段优先于 preset。
 * viewer 不可用时返回 null（并打一条 warn），不抛错。
 */
export function createGridLayer(
  viewer: Viewer,
  options?: GridLayerOptions,
  preset?: Partial<GridLayerOptions>,
): GridLayerHandle | null;

/** 创建网格图层（显式例化方案预设）。 */
export function createInstancedGridLayer(
  viewer: Viewer,
  options?: GridLayerOptions,
): GridLayerHandle | null;

/** 创建网格图层（Primitive 方案预设：支持独立框线色相与 GPU 拾取）。 */
export function createPrimitiveGridLayer(
  viewer: Viewer,
  options?: GridLayerOptions,
): GridLayerHandle | null;

/** 创建网格图层（底层实现；createGridLayer 会先做选项归一化再委托到它）。 */
export function createIndependentGridLayer(
  viewer: Viewer,
  options?: GridLayerOptions,
): GridLayerHandle | null;

/** 释放网格图层。幂等；viewer 销毁时会自动触发。 */
export function destroyIndependentGridLayer(handle: GridLayerHandle | null): void;

/** 释放网格图层（destroyIndependentGridLayer 的别名）。 */
export const destroyGridLayer: typeof destroyIndependentGridLayer;

/** 生成格编码，形如 "12,34"。 */
export function independentGridCellCode(col: number, row: number): string;

/** 解析格编码为行列号；格式非法返回 null。 */
export function parseCellCode(code: string): { col: number; row: number } | null;

/** 校验经纬度是否可用（空值 / 字符串数字 / NaN / 越界一律判为非法）。 */
export function isValidLngLat(lng: unknown, lat: unknown): boolean;

/** 推导格中心的 WGS84 局部标架（ECEF 位置 + ENU 基 + 三向尺度），写入 out 的 [0,15)。 */
export function writeCellFrame(
  col: number,
  row: number,
  model: Pick<GridModel, 'originLon' | 'originLat' | 'cellSize' | 'bottomHeight' | 'gridHeight'>,
  out: Float64Array,
): void;

/** 计算格中心的 ECEF 4×4 列主序 modelMatrix（Primitive 方案用）。 */
export function writeCellModelMatrix(
  col: number,
  row: number,
  model: Pick<GridModel, 'originLon' | 'originLat' | 'cellSize' | 'bottomHeight' | 'gridHeight'>,
  out?: Float64Array,
  offset?: number,
): Float64Array;

/** 计算格在网格中心 ENU 下的 3×4 行主序实例矩阵（例化方案用）。 */
export function writeCellInstanceMatrix(
  col: number,
  row: number,
  model: Pick<GridModel, 'originLon' | 'originLat' | 'cellSize' | 'bottomHeight' | 'gridHeight'>,
  origin: EnuFrame,
  out?: Float32Array | Float64Array,
  offset?: number,
): Float32Array | Float64Array;

/** 对交错 (col,row) 清单批量计算 ECEF modelMatrix。 */
export function packCellsMatrices(
  packed: Int32Array,
  model: Pick<GridModel, 'originLon' | 'originLat' | 'cellSize' | 'bottomHeight' | 'gridHeight'>,
): Float64Array;

/** 对交错 (col,row) 清单批量计算 ENU 局部 3×4 实例矩阵。 */
export function packCellsInstanceMatrices(
  packed: Int32Array,
  model: Pick<GridModel, 'originLon' | 'originLat' | 'cellSize' | 'bottomHeight' | 'gridHeight'>,
  origin: EnuFrame,
): Float32Array;

/** 网格中心 ENU 标架（ECEF 原点 + 三轴单位向量）。 */
export interface EnuFrame {
  x: number;
  y: number;
  z: number;
  ex: number;
  ey: number;
  ez: number;
  nx: number;
  ny: number;
  nz: number;
  ux: number;
  uy: number;
  uz: number;
}

/** 由 ENU→ECEF 变换矩阵（列主序 16 元）拆出标架对象。 */
export function enuFrameFromMatrix(matrix: ArrayLike<number>): EnuFrame;

/** 从中心格起按方环向外产出格清单的填充器。 */
export interface RingFill {
  /** 取最多 size 格的交错清单 [col,row,...]；全部环取完时为空数组。 */
  nextBatch(size: number): Int32Array;
  /** 所有环是否已产出完毕。 */
  isDone(): boolean;
}

/** 创建「中心方环」填充器。 */
export function createRingFill(
  centerCol: number,
  centerRow: number,
  cols: number,
  rows: number,
): RingFill;

// ============================ 多边形面内网格生成 ============================

/** 闭合环：[经度, 纬度] 位置数组，首点与末点相同（度）。 */
export type Ring = Array<[number, number]>;

/** 一个多边形：index 0 为外环，1.. 为洞。 */
export type PolygonRings = Array<Ring>;

/** 多边形环组：每元素 [外环, 洞...]。 */
export type Polygons = Array<PolygonRings>;

/** normalizePolygonGeometry 产物。 */
export interface NormalizedPolygon {
  polygons: Polygons;
  warnings: string[];
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
}

/** 第 k 层网格模型（与 GridModel 的几何字段同构，可直接传给矩阵函数）。 */
export interface PolygonGridLayerModel {
  originLon: number;
  originLat: number;
  cellSize: number;
  /** 第 k 层底高 = bottomHeight + k × gridHeight（米，椭球基准）。 */
  bottomHeight: number;
  gridHeight: number;
}

/** generatePolygonGrid 选项。 */
export interface GeneratePolygonGridOptions {
  /** 格边长（度），必须 > 0。 */
  cellSize: number;
  /** 竖直堆叠层数，向下取整且 ≥ 1。默认 1。 */
  layers?: number;
  /** 第 0 层底高（米，椭球基准），必须 ≥ 0。默认 0。 */
  bottomHeight?: number;
  /** 单层柱高（米），必须 > 0。默认 180。 */
  gridHeight?: number;
  /** 可选：强制网格西边界（度）；缺省为 bbox 西南角向下对齐格线。 */
  originLon?: number;
  /** 可选：强制网格南边界（度）；缺省为 bbox 西南角向下对齐格线。 */
  originLat?: number;
}

/** generatePolygonGrid 产物。 */
export interface PolygonGridResult {
  originLon: number;
  originLat: number;
  /** 候选矩形列数（覆盖面的 bbox，不是面内格数）。 */
  cols: number;
  /** 候选矩形行数。 */
  rows: number;
  cellSize: number;
  layers: number;
  bottomHeight: number;
  gridHeight: number;
  /** 面内水平格数（不含层复制）。 */
  cellCount2d: number;
  /** 面内立体格数 = cellCount2d × layers。 */
  cellCount3d: number;
  /** 面内水平格交错清单 [col,row,...]，行主序。 */
  cells2d: Int32Array;
  /** 立体格清单 [col,row,layer,...]：外层 layer 升序，内层顺序与 cells2d 相同。 */
  cells3d: Int32Array;
  layerModels: PolygonGridLayerModel[];
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  warnings: string[];
}

/**
 * 把 GeoJSON Polygon / MultiPolygon（或 Feature 包装）规范化为环组。
 * 外环含非法点抛 TypeError；非法洞丢弃并进 warnings；未闭合自动闭合，不修改入参。
 */
export function normalizePolygonGeometry(input: unknown): NormalizedPolygon;

/** 判断点是否落在任一多边形内（外环含边线、洞含边线；MultiPolygon 取并集）。 */
export function isPointInPolygon(lon: number, lat: number, polygons: Polygons): boolean;

/**
 * 在多边形面内生成指定边长的多层经纬度网格。
 * 只保留格中心点在面内的格（边界最多缺半格）；第 k 层底高 = bottomHeight + k × gridHeight。
 * 非法输入抛错（不静默回退）；不接入 createGridLayer，不产生拾取。
 */
export function generatePolygonGrid(
  polygon: unknown,
  options: GeneratePolygonGridOptions,
): PolygonGridResult;

/** 多边形面内的方环填充器（只产面内格）。 */
export interface PolygonRingFill {
  nextBatch(size: number): Int32Array;
  isDone(): boolean;
}

/**
 * 创建「多边形面内方环」填充器：从种子格按 Chebyshev 方环向外产出，但只产面内的格。
 * 种子不在面内时换用 Chebyshev 距离最小的面内格（并列取更小 col，再更小 row）。
 */
export function createPolygonRingFill(
  grid: Pick<PolygonGridResult, 'cols' | 'rows' | 'cells2d'>,
  centerCol: number,
  centerRow: number,
): PolygonRingFill;

/** 创建例化渲染对象（可直接 add 进 viewer.scene.primitives）。 */
export function createInstancedGridPrimitive(
  options: InstancedGridPrimitiveOptions,
): InstancedGridPrimitive;

/** Viewer 是否仍可安全调用 Cesium API。 */
export function isViewerAlive(viewer: Viewer | null | undefined): boolean;

/** 登记 viewer 销毁前回调，返回取消登记函数。 */
export function onViewerBeforeDestroy(viewer: Viewer, fn: (viewer: Viewer) => void): () => void;

/** 手动触发某 viewer 的全部销毁前钩子（不销毁 viewer 本身）。 */
export function flushViewerBeforeDestroy(viewer: Viewer): number;

/** 创建矩阵打包 Worker；不可用时返回 null（调用方回退主线程计算）。 */
export function createGridWorker(options?: {
  disableWorker?: boolean;
  workerFactory?: GridWorkerFactory;
}): Worker | null;

/** 全局注入 Worker 构造器的属性名（Vite `?worker` 用法）。 */
export const GLOBAL_WORKER_KEY: string;

/** 选项归一化结果。 */
export interface NormalizedGridOptions {
  model: GridModel;
  render: {
    mathPick: boolean;
    edgeShader: boolean;
    edgeAlpha: number;
    edgeWidthPx: number;
    outlineEnabled: boolean;
    asyncGeometry: boolean;
    instancing: boolean;
    chunkSize: number;
    heightChunksPerFrame: number;
    layerType: string;
  };
  pump: { budgetMs: number; min: number; max: number; initial: number };
  worker: { disableWorker: boolean; workerFactory?: GridWorkerFactory };
  warnings: string[];
  totalCells: number;
}

/** 校验、夹取、填默认值；非法项汇总到 warnings（不抛错）。 */
export function normalizeGridOptions(options?: GridLayerOptions): NormalizedGridOptions;

/** 把 CSS 颜色串或 Cesium.Color 规整成新的 Cesium.Color 实例。 */
export function toColor(color: string | Color | undefined | null, fallback: Color): Color;

/** 取本格填充色并把 alpha 提到 1（选中态）。 */
export function toOpaque(base: Color): Color;

/** 默认填充色。 */
export const DEFAULT_FILL: Color;
/** 默认框线色。 */
export const DEFAULT_OUTLINE: Color;
/** 默认网格参数。 */
export const DEFAULT_GRID: Readonly<Record<string, number | string>>;
