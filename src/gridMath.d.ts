/**
 * @wjyfst/cesium-grid/math 子路径类型声明。
 *
 * 该子路径只导出**纯计算**部分（不 import cesium），可在 Node 脚本、Web Worker 或
 * 数据预处理流程里直接使用，不会触碰 DOM / WebGL。
 */

export interface GridMathModel {
  originLon: number;
  originLat: number;
  cellSize: number;
  bottomHeight: number;
  gridHeight: number;
}

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

export interface RingFill {
  nextBatch(size: number): Int32Array;
  isDone(): boolean;
}

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
  model: GridMathModel,
  out: Float64Array,
): void;

/** 计算格中心的 ECEF 4×4 列主序 modelMatrix（Primitive 方案用）。 */
export function writeCellModelMatrix(
  col: number,
  row: number,
  model: GridMathModel,
  out?: Float64Array,
  offset?: number,
): Float64Array;

/** 计算格在网格中心 ENU 下的 3×4 行主序实例矩阵（例化方案用）。 */
export function writeCellInstanceMatrix(
  col: number,
  row: number,
  model: GridMathModel,
  origin: EnuFrame,
  out?: Float32Array | Float64Array,
  offset?: number,
): Float32Array | Float64Array;

/** 对交错 (col,row) 清单批量计算 ECEF modelMatrix。 */
export function packCellsMatrices(packed: Int32Array, model: GridMathModel): Float64Array;

/** 对交错 (col,row) 清单批量计算 ENU 局部 3×4 实例矩阵。 */
export function packCellsInstanceMatrices(
  packed: Int32Array,
  model: GridMathModel,
  origin: EnuFrame,
): Float32Array;

/** 由 ENU→ECEF 变换矩阵（列主序 16 元）拆出标架对象。 */
export function enuFrameFromMatrix(matrix: ArrayLike<number>): EnuFrame;

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

/** 多边形环组：index 0 是外环，后续为洞。 */
export type Polygons = Array<PolygonRings>;

/** normalizePolygonGeometry 产物。 */
export interface NormalizedPolygon {
  /** 规范化后的环组（每元素 [外环, 洞...]）。 */
  polygons: Polygons;
  /** 处理过程中的告警文案（非法洞被丢弃、疑似跨日界线等）。 */
  warnings: string[];
  /** 由全部外环顶点求得的经纬度包围盒（度）。 */
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
}

/** 第 k 层网格模型（与 GridMathModel 同构，可直接传给矩阵函数）。 */
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
  /** 网格西边界经度（度）。 */
  originLon: number;
  /** 网格南边界纬度（度）。 */
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
  /** 面内水平格交错清单 [col,row,...]，行主序（row 南→北，行内 col 西→东）。 */
  cells2d: Int32Array;
  /** 立体格清单 [col,row,layer,...]：外层 layer 升序，内层顺序与 cells2d 相同。 */
  cells3d: Int32Array;
  /** 每层的 GridMathModel，可直接传 packCellsMatrices / writeCellFrame。 */
  layerModels: PolygonGridLayerModel[];
  /** 面的经纬度包围盒（度）。 */
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  /** 处理过程中的告警文案。 */
  warnings: string[];
}

/**
 * 把 GeoJSON Polygon / MultiPolygon（或 Feature 包装）规范化为环组。
 * 外环含非法点抛 TypeError；非法洞丢弃并进 warnings；未闭合自动闭合，不修改入参。
 */
export function normalizePolygonGeometry(input: unknown): NormalizedPolygon;

/**
 * 判断点是否落在任一多边形内（外环含边线、洞含边线；MultiPolygon 取并集）。
 * @param {Polygons} polygons - normalizePolygonGeometry 的 polygons 产物
 */
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
  /** 取最多 size 个面内格的交错清单 [col,row,...]；耗尽后为空数组。 */
  nextBatch(size: number): Int32Array;
  /** 全部面内格是否已产出。 */
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
