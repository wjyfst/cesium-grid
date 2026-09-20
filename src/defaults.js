/**
 * @Description: 图层默认值与选项归一化。
 *
 *   把「外部入参 → 内部模型」的转换集中在一处，好处有三：
 *   1. 所有非法输入在这里被收口并告警，渲染路径不必再防御（若静默回退默认值，
 *      调用方写错经纬度只会看到网格跑到别处，很难定位）；
 *   2. 归一化是纯函数，可脱离 WebGL 单测；
 *   3. 默认值集中，README 的选项表与代码不会漂移。
 */
import * as Cesium from 'cesium';

/** 默认填充色（半透明青） */
export const DEFAULT_FILL = Cesium.Color.fromCssColorString('#27D9FF').withAlpha(0.42);
/** 默认框线色（高亮青） */
export const DEFAULT_OUTLINE = Cesium.Color.fromCssColorString('#8CF3FF').withAlpha(0.95);

/** Worker 流水线预取批数（在途批次数上限） */
export const PREFETCH_BATCHES = 3;

/**
 * drillPick 回退层数：drillPick 每多钻一层就多一遍全场景离屏渲染
 * （Cesium 在 Picking.js:885 自己标了 PERFORMANCE_IDEA），够穿透地形/边界/设备标记即可。
 */
export const PICK_DRILL_LIMIT = 3;

/**
 * 默认格索引上限告警阈值：超过则提示调用方确认是否真的需要一次性铺满（不阻断）。
 *
 * 取 10 亿（1e9）而非 1 亿：本包的定位是亿级网格，若阈值定在 1e8，
 * 恰好落在设计目标上会每次都弹告警，等于把正常用法标成异常。
 */
export const TOTAL_CELLS_WARN_THRESHOLD = 1e9;

/** 默认网格参数（集中定义，便于文档与校验共用） */
export const DEFAULT_GRID = Object.freeze({
  originLon: 114.5,
  originLat: 23.5,
  cols: 1000,
  rows: 1000,
  cellSize: 0.01,
  bottomHeight: 30,
  gridHeight: 180,
  batchSize: 4000,
  pumpSize: 800,
  pumpBudgetMs: 4,
  pumpMin: 256,
  chunkSize: 128,
  edgeAlpha: 0.15,
  edgeWidthPx: 1.2,
  layerType: 'independentGrid',
});

/**
 * 把外部传入的颜色（CSS 颜色串或 Cesium.Color）规整成一个新的 Cesium.Color 实例。
 *
 * 返回值恒为新对象（clone 或解析结果），调用方修改它不会污染入参、也不会污染图层默认色。
 *
 * @param {string|import('cesium').Color|undefined|null} color - 颜色来源：CSS 颜色串（如 '#27D9FF'）或 Cesium.Color；空串 / undefined / 解析失败视为无效
 * @param {import('cesium').Color} fallback - 无效时使用的兜底色，不会被修改
 * @returns {import('cesium').Color} 规整后的颜色副本
 */
export function toColor(color, fallback) {
  if (color instanceof Cesium.Color) return color.clone();
  if (typeof color === 'string' && color.trim()) {
    const parsed = Cesium.Color.fromCssColorString(color);
    if (parsed) return parsed;
  }
  return fallback.clone();
}

/**
 * 生成选中态填充色：取本格自身填充色，只把透明度提到 1（不换色相）。
 *
 * 半透明格叠在地形/底图上时颜色会被背景稀释，选中后置为不透明才能看清本格真实数据色。
 *
 * @param {import('cesium').Color} base - 本格的基础填充色（baseFillColor）
 * @returns {import('cesium').Color} alpha = 1 的同色相颜色；base 为假值时原样返回
 */
export function toOpaque(base) {
  return base ? base.withAlpha(1) : base;
}

/**
 * 取有限数字，非法时回退默认值并记一条告警。
 *
 * @param {unknown} value - 外部传入值
 * @param {number} fallback - 兜底值
 * @param {string} name - 选项名（用于告警文案）
 * @param {string[]} warnings - 告警收集数组，函数只往里追加文案
 * @returns {number} 可用的有限数字
 */
function finiteOr(value, fallback, name, warnings) {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num === 'number' && Number.isFinite(num)) return num;
  if (value !== undefined && value !== null) {
    warnings.push(`${name} 非法（收到 ${JSON.stringify(value)}），回退默认值 ${fallback}`);
  }
  return fallback;
}

/**
 * 归一化网格选项：校验、夹取、填默认值，并把非法项汇总成告警。
 *
 * 校验规则（全部为「回退 + 告警」，不抛错，保证图层永远能建起来）：
 * - originLon / originLat：非有限值回退默认并告警（静默回退会让网格位置错误难以定位）；
 * - cols / rows：向下取整且至少为 1；
 * - cellSize：必须 > 0，否则回退 0.01；
 * - bottomHeight：非负有限值，否则回退默认；
 * - gridHeight：> 0，否则回退默认；
 * - batchSize / pumpSize / pumpMin / pumpMax：向下取整并按上下限夹取；
 * - chunkSize：夹到 [8, 1024]（越界值由底层渲染对象再夹一次，这里提前告警）；
 * - edgeAlpha：夹到 [0, 1]；edgeWidthPx：> 0。
 *
 * @param {object} [options={}] - 外部选项，见 README 选项表
 * @returns {object} 归一化结果：
 *   `{ model, render, pump, worker, warnings }`；
 *   model 为底层网格模型（含 Cesium.Color 实例），render 为渲染方案开关，
 *   pump 为填充节流参数，worker 为 Worker 配置，warnings 为告警文案数组
 */
export function normalizeGridOptions(options = {}) {
  /** @type {string[]} */
  const warnings = [];
  let opt = options;
  if (!opt || typeof opt !== 'object') {
    if (opt !== undefined && opt !== null) {
      warnings.push(`options 必须是对象（收到 ${typeof opt}），已按空对象处理`);
    }
    opt = {};
  }

  const cols = Math.max(1, Math.floor(finiteOr(opt.cols, DEFAULT_GRID.cols, 'cols', warnings)));
  const rows = Math.max(1, Math.floor(finiteOr(opt.rows, DEFAULT_GRID.rows, 'rows', warnings)));
  const rawCellSize = finiteOr(opt.cellSize, DEFAULT_GRID.cellSize, 'cellSize', warnings);
  const cellSize = rawCellSize > 0 ? rawCellSize : DEFAULT_GRID.cellSize;
  if (rawCellSize <= 0)
    warnings.push(`cellSize 必须大于 0（收到 ${rawCellSize}），回退 ${cellSize}`);

  const rawBottom = finiteOr(opt.bottomHeight, DEFAULT_GRID.bottomHeight, 'bottomHeight', warnings);
  const bottomHeight = rawBottom >= 0 ? rawBottom : DEFAULT_GRID.bottomHeight;
  if (rawBottom < 0) {
    warnings.push(`bottomHeight 不能为负（收到 ${rawBottom}），回退 ${bottomHeight}`);
  }

  const rawHeight = finiteOr(opt.gridHeight, DEFAULT_GRID.gridHeight, 'gridHeight', warnings);
  const gridHeight = rawHeight > 0 ? rawHeight : DEFAULT_GRID.gridHeight;
  if (rawHeight <= 0) {
    warnings.push(`gridHeight 必须大于 0（收到 ${rawHeight}），回退 ${gridHeight}`);
  }

  const batchSize = Math.max(
    32,
    Math.floor(finiteOr(opt.batchSize, DEFAULT_GRID.batchSize, 'batchSize', warnings)),
  );
  const pumpBudgetMs = Math.max(
    0.5,
    finiteOr(opt.pumpBudgetMs, DEFAULT_GRID.pumpBudgetMs, 'pumpBudgetMs', warnings),
  );
  const pumpMin = Math.max(
    32,
    Math.floor(finiteOr(opt.pumpMin, DEFAULT_GRID.pumpMin, 'pumpMin', warnings)),
  );
  const rawPumpMax = finiteOr(opt.pumpMax, batchSize, 'pumpMax', warnings);
  const pumpMax = Math.max(pumpMin, Math.floor(rawPumpMax));
  const pumpSize = Math.min(
    pumpMax,
    Math.max(
      pumpMin,
      Math.floor(finiteOr(opt.pumpSize, DEFAULT_GRID.pumpSize, 'pumpSize', warnings)),
    ),
  );

  const rawChunk = Math.floor(
    finiteOr(opt.chunkSize, DEFAULT_GRID.chunkSize, 'chunkSize', warnings),
  );
  const chunkSize = Math.max(8, Math.min(1024, rawChunk));
  if (rawChunk !== chunkSize) {
    warnings.push(`chunkSize 超出 [8, 1024]（收到 ${rawChunk}），已夹到 ${chunkSize}`);
  }

  const rawEdgeAlpha = finiteOr(opt.edgeAlpha, DEFAULT_GRID.edgeAlpha, 'edgeAlpha', warnings);
  const edgeAlpha = Math.min(1, Math.max(0, rawEdgeAlpha));
  if (rawEdgeAlpha !== edgeAlpha) {
    warnings.push(`edgeAlpha 超出 [0, 1]（收到 ${rawEdgeAlpha}），已夹到 ${edgeAlpha}`);
  }
  const rawEdgeWidth = finiteOr(opt.edgeWidthPx, DEFAULT_GRID.edgeWidthPx, 'edgeWidthPx', warnings);
  const edgeWidthPx = rawEdgeWidth > 0 ? rawEdgeWidth : DEFAULT_GRID.edgeWidthPx;
  if (rawEdgeWidth <= 0) {
    warnings.push(`edgeWidthPx 必须大于 0（收到 ${rawEdgeWidth}），回退 ${edgeWidthPx}`);
  }

  const totalCells = cols * rows;
  if (totalCells > TOTAL_CELLS_WARN_THRESHOLD) {
    warnings.push(
      `cols × rows = ${totalCells} 超过 ${TOTAL_CELLS_WARN_THRESHOLD}，` +
        `请确认确实需要一次性铺满（内存与显存占用随格数线性增长）`,
    );
  }

  const model = {
    originLon: finiteOr(opt.originLon, DEFAULT_GRID.originLon, 'originLon', warnings),
    originLat: finiteOr(opt.originLat, DEFAULT_GRID.originLat, 'originLat', warnings),
    cols,
    rows,
    cellSize,
    bottomHeight,
    gridHeight,
    batchSize,
    fillColor: toColor(opt.fillColor, DEFAULT_FILL),
    outlineColor: toColor(opt.outlineColor, DEFAULT_OUTLINE),
  };

  // 格线方案：edgeShader（默认 true）用自定义外观在盒面内描边（不建线框 Primitive）；
  // 置 edgeShader:false 才按 outline 决定是否建独立线框 Primitive。两者互斥，edgeShader 优先。
  const edgeShader = opt.edgeShader !== false;
  const render = {
    mathPick: opt.mathPick !== false,
    edgeShader,
    edgeAlpha,
    edgeWidthPx,
    outlineEnabled: opt.outline !== false && !edgeShader,
    asyncGeometry: opt.asyncGeometry !== false,
    instancing: opt.instancing !== false,
    chunkSize,
    heightChunksPerFrame: Math.max(
      1,
      Math.floor(finiteOr(opt.heightChunksPerFrame, 4, 'heightChunksPerFrame', warnings)),
    ),
    layerType:
      typeof opt.layerType === 'string' && opt.layerType ? opt.layerType : DEFAULT_GRID.layerType,
  };

  const pump = { budgetMs: pumpBudgetMs, min: pumpMin, max: pumpMax, initial: pumpSize };
  const worker = {
    disableWorker: opt.disableWorker === true,
    workerFactory: typeof opt.workerFactory === 'function' ? opt.workerFactory : undefined,
  };

  return { model, render, pump, worker, warnings, totalCells };
}
