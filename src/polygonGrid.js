/**
 * @Description: 多边形面内多层网格纯计算生成器（不依赖 Cesium / Turf）。
 *
 *   接收 GeoJSON Polygon / MultiPolygon（含洞），在面的包围盒内按 cellSize 对齐经纬度网格，
 *   只保留**格中心点在面内**的格（外环边线算面内、洞边线算面外），再把同一水平格
 *   清单竖直堆叠成 layers 层（第 k 层底高 = bottomHeight + k × gridHeight）。
 *
 *   纯计算模块：可在裸 Node / Worker 运行；不接入 createGridLayer（图层仍是矩形网格），
 *   产出的 cells2d 可直接喂 packCellsMatrices / writeCellFrame 等，每层用
 *   layerModels[k] 的 bottomHeight 区分。
 *
 *   已知限制：
 *   - 判定基于格中心点，边界格最多缺半格，不保证格面完全落在面内；
 *   - 不支持跨日界线多边形（只告警不拆分）；
 *   - 经纬度按平面处理（与既有经纬网格一致），非测地线。
 */

import { createRingFill, isValidLngLat } from './gridMath.js';

/** 候选格数上限：超过则 throw，避免一次调用扫描巨大矩形 */
const CANDIDATE_CELLS_LIMIT = 1e9;

/** 对齐浮点容差（以「格数」为单位）：吸收 lon/cellSize 的 double 误差，避免恰好落在格线上时误加一行/列 */
const ALIGN_EPS = 1e-9;

/** 点在线上判定容差（相对线段长度的比例） */
const EDGE_EPS = 1e-12;

/**
 * 判断点是否落在线段上（含端点；容差为线段长度的 EDGE_EPS 倍）。
 *
 * @param {number} px - 点经度
 * @param {number} py - 点纬度
 * @param {number} ax - 线段端点 A 经度
 * @param {number} ay - 线段端点 A 纬度
 * @param {number} bx - 线段端点 B 经度
 * @param {number} by - 线段端点 B 纬度
 * @returns {boolean} true = 点在线段上（含端点）
 */
function pointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return px === ax && py === ay;
  const len = Math.hypot(dx, dy);
  // 点到直线距离（绝对值），与「线段长度 × 相对容差」比较
  const dist = Math.abs(dx * (py - ay) - dy * (px - ax)) / len;
  if (dist > EDGE_EPS * len) return false;
  const t = (dx * (px - ax) + dy * (py - ay)) / (len * len);
  return t >= -EDGE_EPS && t <= 1 + EDGE_EPS;
}

/**
 * even-odd 射线法：判断点是否在一个闭合环内（经纬度按平面处理）。
 *
 * 点在环边上（含顶点）时直接返回 true——外环与洞统一按「边线算环内」处理：
 * 外环边上的格中心算面内（保留），洞边上的格中心算洞内（剔除），与规格一致。
 * 射线只统计「一端严格在点上方」的交叉，避免顶点被两条边重复计数。
 *
 * @param {number} lon - 点经度
 * @param {number} lat - 点纬度
 * @param {Array<[number, number]>} ring - 闭合环（首点与末点相同）
 * @returns {boolean} true = 点在环内或环边上
 */
function ringContainsPoint(lon, lat, ring) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (pointOnSegment(lon, lat, xi, yi, xj, yj)) return true;
    // 水平向右射线：仅当一条边恰好有一端严格在点上方时才可能相交（半开区间规则）
    if (yi > lat !== yj > lat) {
      const xInt = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (xInt > lon) inside = !inside;
    }
  }
  return inside;
}

/**
 * 判断点是否落在任一多边形内（外环含边线、洞含边线；MultiPolygon 取并集）。
 *
 * 点在多边形 A 的洞里时继续检查其余多边形（兼容多边形边界重叠的场景）。
 *
 * @param {number} lon - 点经度（度）
 * @param {number} lat - 点纬度（度）
 * @param {Array<Array<Array<[number, number]>>>} polygons - normalizePolygonGeometry 的 polygons 产物（每元素 [外环, 洞...]）
 * @returns {boolean} true = 点在某多边形内且不在其任何洞里
 */
export function isPointInPolygon(lon, lat, polygons) {
  for (const poly of polygons) {
    if (!ringContainsPoint(lon, lat, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length && !inHole; h += 1) {
      inHole = ringContainsPoint(lon, lat, poly[h]);
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * 闭合并校验一个环（浅拷贝，不修改入参）。
 *
 * @param {unknown} raw - 环原始坐标数组（[lon, lat] 序列）
 * @param {string} name - 环名称（用于错误文案）
 * @param {boolean} invalidThrows - true = 非法环抛 TypeError（外环）；false = 返回 null 由调用方丢弃并告警（洞）
 * @returns {Array<[number, number]>|null} 闭合后的环（首末点相同）；null = 洞被丢弃
 * @throws {TypeError} invalidThrows 为 true 且环点数不足 / 含非法经纬度点时
 */
function closeRing(raw, name, invalidThrows) {
  const fail = (message) => {
    if (invalidThrows) throw new TypeError(`[cesium-grid] ${message}`);
    return null;
  };
  if (!Array.isArray(raw) || raw.length === 0) return fail(`${name} 必须是非空坐标数组`);
  const pts = [];
  for (let i = 0; i < raw.length; i += 1) {
    const p = raw[i];
    if (!Array.isArray(p) || p.length < 2) return fail(`${name} 第 ${i} 个点必须是 [经度, 纬度]`);
    const lon = p[0];
    const lat = p[1];
    if (!isValidLngLat(lon, lat)) {
      return fail(`${name} 含非法经纬度点 (${lon}, ${lat})`);
    }
    pts.push([Number(lon), Number(lat)]);
  }
  if (pts.length < 3) return fail(`${name} 至少需要 3 个点（收到 ${pts.length}）`);
  // 相邻点重复 → 有效顶点数不足，无法构成面（退化环对射线法也毫无意义）
  for (let i = 0; i + 1 < pts.length; i += 1) {
    if (pts[i][0] === pts[i + 1][0] && pts[i][1] === pts[i + 1][1]) {
      return fail(`${name} 第 ${i} 与第 ${i + 1} 个点重复，无法构成面`);
    }
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  const closed = a[0] === b[0] && a[1] === b[1];
  if (closed) {
    if (pts.length < 4) return fail(`${name} 闭合后仅 2 个不同点，无法构成面`);
    return pts;
  }
  pts.push([a[0], a[1]]);
  return pts;
}

/**
 * 把 GeoJSON Polygon / MultiPolygon（或其 Feature 包装）规范化为环组。
 *
 * 接受：
 * - `{ type:'Polygon', coordinates:[[外环],[洞...]] }`
 * - `{ type:'MultiPolygon', coordinates:[[[外环],[洞]], ...] }`
 * - `{ type:'Feature', geometry: 以上两者 }`（properties 忽略）
 * 其余（FeatureCollection、Point、LineString、null 等）抛 TypeError。
 *
 * 规则：
 * - 坐标为 [经度, 纬度]（经度在前），第三维（高度）忽略；
 * - 外环含非法点 / 点数不足 → 抛错；洞非法 → 丢弃并告警；
 * - 未闭合自动补首点到尾部，不修改入参；
 * - 经度跨度 > 180° → 告警疑似跨日界线（仍继续，不拆分）。
 *
 * @param {unknown} input - GeoJSON 几何或 Feature
 * @returns {{polygons: Array<Array<Array<[number, number]>>>, warnings: string[], bbox: {minLon:number, minLat:number, maxLon:number, maxLat:number}}}
 *   polygons 每元素为 [外环, 洞...]；bbox 由全部外环顶点求得
 * @throws {TypeError} 类型不支持或外环数据非法
 */
export function normalizePolygonGeometry(input) {
  /** @type {string[]} */
  const warnings = [];
  let geom = input;
  if (geom && typeof geom === 'object' && geom.type === 'Feature' && geom.geometry) {
    geom = geom.geometry;
  }
  if (!geom || typeof geom !== 'object' || !Array.isArray(geom.coordinates)) {
    throw new TypeError(
      '[cesium-grid] polygon 必须是 GeoJSON Polygon / MultiPolygon（或 Feature 包装）',
    );
  }
  let rawPolys;
  if (geom.type === 'Polygon') {
    rawPolys = [geom.coordinates];
  } else if (geom.type === 'MultiPolygon') {
    rawPolys = geom.coordinates;
  } else {
    throw new TypeError(`[cesium-grid] 不支持的几何类型: ${geom.type}`);
  }
  if (!Array.isArray(rawPolys) || rawPolys.length === 0) {
    throw new TypeError('[cesium-grid] polygon 没有环数据');
  }

  /** @type {Array<Array<Array<[number, number]>>>} */
  const polygons = [];
  for (let p = 0; p < rawPolys.length; p += 1) {
    const rawRings = rawPolys[p];
    if (!Array.isArray(rawRings) || rawRings.length === 0) {
      throw new TypeError(`[cesium-grid] polygon ${p} 没有环数据`);
    }
    const outer = closeRing(rawRings[0], `polygon ${p} 外环`, true);
    const rings = [outer];
    for (let h = 1; h < rawRings.length; h += 1) {
      const hole = closeRing(rawRings[h], `polygon ${p} 洞 ${h - 1}`, false);
      if (hole) {
        rings.push(hole);
      } else {
        warnings.push(
          `[cesium-grid] polygon ${p} 洞 ${h - 1} 点数不足或含非法坐标，已丢弃（外环不受影响）`,
        );
      }
    }
    polygons.push(rings);
  }

  // bbox 与跨日界线检查（只看外环：洞不扩大候选矩形）
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const rings of polygons) {
    for (const [lon, lat] of rings[0]) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (maxLon - minLon > 180) {
    warnings.push(
      '[cesium-grid] 多边形经度跨度超过 180°，疑似跨越日界线：按平面几何处理，结果可能异常，本生成器不拆分日界线',
    );
  }

  return { polygons, warnings, bbox: { minLon, minLat, maxLon, maxLat } };
}

/**
 * 取有限数字，非法则抛带明确文案的 RangeError（本入口是纯计算 API，不做静默回退）。
 *
 * @param {unknown} value - 外部传入值（字符串数字可转）
 * @param {string} name - 选项名（用于错误文案）
 * @returns {number}
 * @throws {RangeError} 非有限数字
 */
function finiteOrThrow(value, name) {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    throw new RangeError(`[cesium-grid] ${name} 必须是有限数字（收到 ${JSON.stringify(value)}）`);
  }
  return num;
}

/**
 * 在多边形面内生成指定边长的多层经纬度网格。
 *
 * 流程：规范化几何 → bbox → 对齐格线（候选矩形）→ 逐格取中心点做面内测试
 * （外环含边线、洞含边线）→ 面内 (col,row) 清单竖直堆叠 layers 层。
 *
 * 产出的 cells2d **只含面内格**：bbox 四角的面外格已被剔除；边界格按中心点判定，
 * 最多缺半格。第 k 层与第 0 层共享同一 (col,row) 集合，仅 bottomHeight 不同，
 * 打包矩阵时请逐层使用 layerModels[k]（现有矩阵函数没有 layer 维度）。
 *
 * 纯计算入口：非法输入抛错（不静默回退）；不接入 createGridLayer，不产生拾取。
 *
 * @param {unknown} polygon - GeoJSON Polygon / MultiPolygon，或 Feature 包装；不接受 FeatureCollection
 * @param {object} [options={}] - 选项
 * @param {number} options.cellSize - 格边长（度），必须 > 0
 * @param {number} [options.layers=1] - 竖直堆叠层数，向下取整且 ≥ 1
 * @param {number} [options.bottomHeight=0] - 第 0 层底高（米，椭球基准），必须 ≥ 0
 * @param {number} [options.gridHeight=180] - 单层柱高（米），必须 > 0
 * @param {number} [options.originLon] - 可选：强制网格西边界（度）；缺省为 bbox 西南角向下对齐格线
 * @param {number} [options.originLat] - 可选：强制网格南边界（度）；缺省为 bbox 西南角向下对齐格线
 * @returns {{
 *   originLon:number, originLat:number, cols:number, rows:number, cellSize:number,
 *   layers:number, bottomHeight:number, gridHeight:number,
 *   cellCount2d:number, cellCount3d:number,
 *   cells2d:Int32Array, cells3d:Int32Array,
 *   layerModels:Array<{originLon:number, originLat:number, cellSize:number, bottomHeight:number, gridHeight:number}>,
 *   bbox:{minLon:number, minLat:number, maxLon:number, maxLat:number},
 *   warnings:string[]
 * }} cells2d 为面内水平格交错清单 [col,row,...]（行主序：row 南→北，行内 col 西→东）；
 *    cells3d 为 [col,row,layer,...]（外层 layer 升序，内层与 cells2d 相同）
 * @throws {TypeError} 几何类型 / 外环数据非法
 * @throws {RangeError} cellSize / layers / 高度 / 候选格数非法，或 origin 覆盖不到面
 */
export function generatePolygonGrid(polygon, options = {}) {
  const cellSize = finiteOrThrow(options.cellSize, 'cellSize');
  if (cellSize <= 0) throw new RangeError(`[cesium-grid] cellSize 必须大于 0（收到 ${cellSize}）`);

  const layersNum = finiteOrThrow(options.layers === undefined ? 1 : options.layers, 'layers');
  const layers = Math.floor(layersNum);
  if (layers < 1) {
    throw new RangeError(
      `[cesium-grid] layers 向下取整后必须 ≥ 1（收到 ${JSON.stringify(options.layers)}）`,
    );
  }

  const bottomHeight = finiteOrThrow(
    options.bottomHeight === undefined ? 0 : options.bottomHeight,
    'bottomHeight',
  );
  if (bottomHeight < 0) {
    throw new RangeError(`[cesium-grid] bottomHeight 不能为负（收到 ${bottomHeight}）`);
  }
  const gridHeight = finiteOrThrow(
    options.gridHeight === undefined ? 180 : options.gridHeight,
    'gridHeight',
  );
  if (gridHeight <= 0) {
    throw new RangeError(`[cesium-grid] gridHeight 必须大于 0（收到 ${gridHeight}）`);
  }

  const { polygons, warnings, bbox } = normalizePolygonGeometry(polygon);

  // bbox 对齐格线：西南角 floor、东北角 ceil（EPS 吸收 lon/cellSize 的 double 误差，
  // 恰好落在格线上时不多出候选行/列）
  const eastCol = Math.ceil(bbox.maxLon / cellSize - ALIGN_EPS);
  const northRow = Math.ceil(bbox.maxLat / cellSize - ALIGN_EPS);
  const originLon =
    options.originLon === undefined
      ? Math.floor(bbox.minLon / cellSize + ALIGN_EPS) * cellSize
      : finiteOrThrow(options.originLon, 'originLon');
  const originLat =
    options.originLat === undefined
      ? Math.floor(bbox.minLat / cellSize + ALIGN_EPS) * cellSize
      : finiteOrThrow(options.originLat, 'originLat');
  if (originLon + ALIGN_EPS * cellSize >= bbox.maxLon) {
    throw new RangeError(
      `[cesium-grid] originLon (${originLon}) 在 polygon 东边界 (${bbox.maxLon}) 以东（含），无法覆盖任何格`,
    );
  }
  if (originLat + ALIGN_EPS * cellSize >= bbox.maxLat) {
    throw new RangeError(
      `[cesium-grid] originLat (${originLat}) 在 polygon 北边界 (${bbox.maxLat}) 以北（含），无法覆盖任何格`,
    );
  }
  const cols = Math.max(1, Math.ceil((eastCol * cellSize - originLon) / cellSize - ALIGN_EPS));
  const rows = Math.max(1, Math.ceil((northRow * cellSize - originLat) / cellSize - ALIGN_EPS));
  if (cols * rows > CANDIDATE_CELLS_LIMIT) {
    throw new RangeError(
      `[cesium-grid] 候选网格 cols × rows = ${cols * rows} 超过上限 ${CANDIDATE_CELLS_LIMIT}，请增大 cellSize 或缩小面范围`,
    );
  }

  // 过滤：只保留中心点在面内的格（行主序：row 南→北，行内 col 西→东）。
  // 扫描量 = cols × rows（bbox 矩形），产出量 = 面内格；面外格在此被物理剔除。
  const hits = [];
  for (let row = 0; row < rows; row += 1) {
    const lat = originLat + (row + 0.5) * cellSize;
    for (let col = 0; col < cols; col += 1) {
      const lon = originLon + (col + 0.5) * cellSize;
      if (isPointInPolygon(lon, lat, polygons)) hits.push(col, row);
    }
  }
  const cells2d = Int32Array.from(hits);

  // 竖直堆叠：第 k 层底高 = bottomHeight + k × gridHeight；水平格集各层相同
  /** @type {Array<{originLon:number, originLat:number, cellSize:number, bottomHeight:number, gridHeight:number}>} */
  const layerModels = [];
  /** @type {number[]} */
  const hits3d = [];
  for (let k = 0; k < layers; k += 1) {
    layerModels.push({
      originLon,
      originLat,
      cellSize,
      bottomHeight: bottomHeight + k * gridHeight,
      gridHeight,
    });
    for (let i = 0; i + 1 < hits.length; i += 2) {
      hits3d.push(hits[i], hits[i + 1], k);
    }
  }
  const cells3d = Int32Array.from(hits3d);
  const cellCount2d = hits.length >> 1;

  return {
    originLon,
    originLat,
    cols,
    rows,
    cellSize,
    layers,
    bottomHeight,
    gridHeight,
    cellCount2d,
    cellCount3d: cellCount2d * layers,
    cells2d,
    cells3d,
    layerModels,
    bbox: { minLon: bbox.minLon, minLat: bbox.minLat, maxLon: bbox.maxLon, maxLat: bbox.maxLat },
    warnings,
  };
}

/**
 * 创建「多边形面内方环」填充器：从种子格按 Chebyshev 方环向外产出，但只产面内的格。
 *
 * 等价于 createRingFill + cells2d mask。为后续接入图层（从相机中心渐进铺面内格）预留的
 * 纯计算入口；本模块不接 createGridLayer。
 *
 * 种子处理：先向下取整并夹到 [0, cols) × [0, rows)；夹取后的种子不在面内时，换用 Chebyshev
 * 距离最小的面内格（并列取更小 col，再更小 row）。面内无格时立即 isDone。
 *
 * @param {{cols:number, rows:number, cells2d:Int32Array}} grid - generatePolygonGrid 产出的 cols / rows / cells2d 子集
 * @param {number} centerCol - 种子列号（非有限值按 0 处理）
 * @param {number} centerRow - 种子行号（非有限值按 0 处理）
 * @returns {{nextBatch:(size:number)=>Int32Array, isDone:()=>boolean}}
 *   nextBatch(size) 返回最多 size 个面内格的交错清单 [col,row,...]（不足返回剩余全部，耗尽后为空数组）；
 *   isDone() 表示全部面内格已产出
 */
export function createPolygonRingFill(grid, centerCol, centerRow) {
  const { cols, rows, cells2d } = grid;

  // 面内格 mask（线性下标 col * rows + row）
  const mask = new Uint8Array(cols * rows);
  for (let i = 0; i + 1 < cells2d.length; i += 2) {
    const c = cells2d[i];
    const r = cells2d[i + 1];
    if (c >= 0 && c < cols && r >= 0 && r < rows) mask[c * rows + r] = 1;
  }

  // 种子：floor + 夹取
  let sx = Math.floor(centerCol);
  let sy = Math.floor(centerRow);
  if (!Number.isFinite(sx)) sx = 0;
  if (!Number.isFinite(sy)) sy = 0;
  sx = Math.min(Math.max(sx, 0), cols - 1);
  sy = Math.min(Math.max(sy, 0), rows - 1);

  /** @type {{c:number, r:number}|null} */
  let seed = mask[sx * rows + sy] ? { c: sx, r: sy } : null;
  if (!seed && cells2d.length > 0) {
    let best = Infinity;
    for (let i = 0; i + 1 < cells2d.length; i += 2) {
      const c = cells2d[i];
      const r = cells2d[i + 1];
      const d = Math.max(Math.abs(c - sx), Math.abs(r - sy));
      if (d < best || (d === best && (c < seed.c || (c === seed.c && r < seed.r)))) {
        best = d;
        seed = { c, r };
      }
    }
  }

  if (!seed) {
    // 面内无格：立即结束
    return {
      nextBatch: () => new Int32Array(0),
      isDone: () => true,
    };
  }

  const base = createRingFill(seed.c, seed.r, cols, rows);
  /** @type {Int32Array} */
  let buf = new Int32Array(0);
  let bi = 0;

  /**
   * 取最多 size 个面内格：底座方环产出的面外格在此丢弃，取完一桶再向底座要下一桶。
   * 底座耗尽（nextBatch 返回空）即全部产出完毕。
   *
   * @param {number} size - 期望取出的格数（上限，实际可能更少）
   * @returns {Int32Array} 交错格清单 [col,row,...]；已耗尽时为空数组
   */
  function nextBatch(size) {
    const want = Math.max(1, Math.floor(size) || 1);
    const out = [];
    while (out.length < want * 2) {
      if (bi >= buf.length) {
        buf = base.nextBatch(Math.max(16, want));
        bi = 0;
        if (buf.length === 0) break;
      }
      const c = buf[bi];
      const r = buf[bi + 1];
      bi += 2;
      if (mask[c * rows + r]) out.push(c, r);
    }
    return Int32Array.from(out);
  }

  /**
   * 是否已把全部面内格产出完毕。
   *
   * @returns {boolean} true = 底座方环已耗尽且当前桶取空
   */
  function isDone() {
    return bi >= buf.length && base.isDone();
  }

  return { nextBatch, isDone };
}
