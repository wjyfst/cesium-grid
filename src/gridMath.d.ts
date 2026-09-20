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
