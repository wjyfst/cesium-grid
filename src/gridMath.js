/**
 * @Description: 独立立体网格纯计算（主线程 / Worker 共用，不依赖 Cesium）。
 *   格编码 + 每格 WGS84 局部标架推导，产出两种形态的逐格变换：
 *   - writeCellModelMatrix：ECEF 世界坐标下的 4×4 列主序矩阵（Primitive 方案用，几何烘焙进顶点）；
 *   - writeCellInstanceMatrix：网格中心 ENU 局部坐标下的 3×4 行主序矩阵（例化方案用，只传变换参数）。
 *   两者数值上满足 modelMatrix(网格中心 ENU→ECEF) × instanceMatrix === ecefMatrix。
 *
 *   本文件不含任何 Cesium 引用，可在 Node / Worker / 主线程任意环境执行，
 *   因此测试与 Node 侧预处理（如预计算矩阵）都不需要 WebGL 或 DOM。
 */

/** WGS84 长半轴（米） */
const WGS84_A = 6378137.0;
/** WGS84 第一偏心率平方 */
const WGS84_E2 = 0.0066943799901413165;

/** writeCellFrame 的输出长度（3 位置 + 9 基向量 + 3 尺度） */
const FRAME_LENGTH = 15;

/**
 * 标架推导的复用缓冲，避免逐格 new 数组。
 *
 * 模块内所有导出函数都同步执行且不互相嵌套调用，共用一份不会被污染；
 * 调用方不得跨调用持有 writeCellFrame 的入参 out。
 * @type {Float64Array}
 */
const frameScratch = new Float64Array(FRAME_LENGTH);

/**
 * 生成格子的唯一编码，作为格索引的键。
 *
 * @param {number} col - 列号，从 0 起向东递增
 * @param {number} row - 行号，从 0 起向北递增
 * @returns {string} 形如 `"12,34"` 的编码字符串
 */
export function independentGridCellCode(col, row) {
  return `${col},${row}`;
}

/**
 * 解析格编码为行列号，是 independentGridCellCode 的逆运算。
 *
 * 与内部紧凑索引（compact cell store）使用同一套解析规则：不合法时返回 null，
 * 调用方据此走「未命中」分支而不是抛错。
 *
 * 严格性说明：两段都必须非空且能转成整数。这一点很重要——`Number('')` 是 0 而不是 NaN，
 * 若只做 Number 转换，`"12,"` 会被解析成 (12, 0) 并**命中一个完全无关的格**，
 * 这种「静默错格」比返回 null 危险得多。
 *
 * @param {string} code - 格编码，形如 `"12,34"`
 * @returns {{col:number, row:number}|null} 解析结果；格式非法时为 null
 */
export function parseCellCode(code) {
  if (typeof code !== 'string') return null;
  const comma = code.indexOf(',');
  if (comma <= 0) return null;
  const colText = code.slice(0, comma);
  const rowText = code.slice(comma + 1);
  if (!colText || !rowText) return null;
  const col = Number(colText);
  const row = Number(rowText);
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
  return { col, row };
}

/**
 * 校验经纬度是否可用（空值 / 字符串数字 / NaN / 越界一律判为非法）。
 *
 * 外部数据源（接口、颜色文件、CSV）的坐标可能是 null、空串、字符串或 NaN，
 * 直接进 Cesium 会抛 NaN/Infinity 或渲染到错误位置，故统一在此收口。
 *
 * @param {unknown} lng - 经度，允许数字或可转成有限数字的字符串
 * @param {unknown} lat - 纬度，允许数字或可转成有限数字的字符串
 * @returns {boolean} true = 落在 [-180,180] × [-90,90] 且为有限数字
 */
export function isValidLngLat(lng, lat) {
  if (lng === null || lng === undefined || lat === null || lat === undefined) return false;
  const x = typeof lng === 'string' ? Number(lng) : lng;
  const y = typeof lat === 'string' ? Number(lat) : lat;
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < -180 || x > 180) return false;
  if (y < -90 || y > 90) return false;
  return true;
}

/**
 * 推导格中心的 WGS84 局部标架：ECEF 位置 + ENU 单位基 + 三向尺度。
 *
 * 立方体局部坐标系约定：x∈[-0.5,0.5] 向东、y∈[-0.5,0.5] 向北、z∈[-0.5,0.5] 向上。
 * 尺度由该纬度处的卯酉圈曲率半径 N（东西向）与子午圈曲率半径 M（南北向）换算，
 * 保证格边长在米制下约为 cellSize；高纬处 cosLat 趋零，取 1e-6 下限避免退化。
 * 位置取底面高度 bottomHeight 处，柱体自该处向上生长。
 *
 * 内部辅助：writeCellModelMatrix 与 writeCellInstanceMatrix 共用，避免椭球公式重复。
 *
 * @param {number} col - 列号（0 起）
 * @param {number} row - 行号（0 起）
 * @param {{originLon:number, originLat:number, cellSize:number, bottomHeight:number, gridHeight:number}} model - 网格模型参数；cellSize 单位为度，高度单位为米
 * @param {Float64Array} out - 写入目标，长度需 ≥ 15
 * @returns {void} 副作用：覆写 out 的 [0,15) 区间
 */
export function writeCellFrame(col, row, model, out) {
  const lon = model.originLon + (col + 0.5) * model.cellSize;
  const lat = model.originLat + (row + 0.5) * model.cellSize;
  const lonR = (lon * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const sinLon = Math.sin(lonR);
  const cosLon = Math.cos(lonR);
  const sinLat2 = sinLat * sinLat;
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat2);
  const M = (WGS84_A * (1 - WGS84_E2)) / Math.pow(1 - WGS84_E2 * sinLat2, 1.5);
  const h = model.bottomHeight;

  // ECEF 位置（底面高度处）
  out[0] = (N + h) * cosLat * cosLon;
  out[1] = (N + h) * cosLat * sinLon;
  out[2] = (N * (1 - WGS84_E2) + h) * sinLat;

  // ENU 单位基：east 沿纬圈切向、north 沿经圈切向、up 沿椭球法线
  out[3] = -sinLon;
  out[4] = cosLon;
  out[5] = 0;
  out[6] = -sinLat * cosLon;
  out[7] = -sinLat * sinLon;
  out[8] = cosLat;
  out[9] = cosLat * cosLon;
  out[10] = cosLat * sinLon;
  out[11] = sinLat;

  // 三向尺度（米）：东西向按卯酉圈、南北向按子午圈、高度直接用柱高
  const perDeg = (model.cellSize * Math.PI) / 180;
  out[12] = perDeg * N * Math.max(1e-6, Math.abs(cosLat));
  out[13] = perDeg * M;
  out[14] = model.gridHeight;
}

/**
 * 计算格中心的 ECEF 世界坐标 4×4 实例化矩阵（列主序），把单位立方体变换成该格对应的立体格。
 *
 * 供 Primitive 方案使用：该矩阵会被 combineGeometry 烘焙进顶点，因此是「结果数据」。
 * BoxGeometry 以原点为中心，故平移项额外沿 up 偏移半高，使盒底面落在 bottomHeight。
 *
 * @param {number} col - 列号（0 起）
 * @param {number} row - 行号（0 起）
 * @param {{originLon:number, originLat:number, cellSize:number, bottomHeight:number, gridHeight:number}} model - 网格模型参数，cellSize 单位为度
 * @param {Float64Array} [out] - 写入目标，长度需 ≥ offset + 16；不传则内部新建
 * @param {number} [offset=0] - 写入 out 的起始下标（列主序 16 元一组）
 * @returns {Float64Array} 写入后的矩阵数组（即入参 out，便于链式复用）
 */
export function writeCellModelMatrix(col, row, model, out = new Float64Array(16), offset = 0) {
  const f = frameScratch;
  writeCellFrame(col, row, model, f);
  const x = f[0];
  const y = f[1];
  const z = f[2];
  const ex = f[3];
  const ey = f[4];
  const nx = f[6];
  const ny = f[7];
  const nz = f[8];
  const ux = f[9];
  const uy = f[10];
  const uz = f[11];
  const sx = f[12];
  const sy = f[13];
  const sz = f[14];

  out[offset] = ex * sx;
  out[offset + 1] = ey * sx;
  out[offset + 2] = 0;
  out[offset + 3] = 0;
  out[offset + 4] = nx * sy;
  out[offset + 5] = ny * sy;
  out[offset + 6] = nz * sy;
  out[offset + 7] = 0;
  out[offset + 8] = ux * sz;
  out[offset + 9] = uy * sz;
  out[offset + 10] = uz * sz;
  out[offset + 11] = 0;
  // BoxGeometry 以原点为中心（z∈[-0.5,0.5]），沿 up 平移半高，使底面落在 bottomHeight
  out[offset + 12] = x + ux * sz * 0.5;
  out[offset + 13] = y + uy * sz * 0.5;
  out[offset + 14] = z + uz * sz * 0.5;
  out[offset + 15] = 1;
  return out;
}

/**
 * 计算格在「网格中心 ENU 局部坐标系」下的 3×4 实例矩阵（行主序，每行一个 vec4）。
 *
 * 供例化方案使用：GPU 顶点着色器按此矩阵把单位盒变换到格位置，大平移（ECEF 量级）
 * 交给 DrawCommand.modelMatrix（float64），实例矩阵只承载局部小量，故 float32 精度足够。
 * 与 writeCellModelMatrix 数值等价：modelMatrix(originFrame) × 本矩阵 === ECEF 版矩阵。
 *
 * 输出布局（每格 12 个 float，与着色器里 mat4 的四列一一对应）：
 *   [0..3]  row0 = (eastLocal.x·sx, northLocal.x·sy, upLocal.x·sz, tx)
 *   [4..7]  row1 = (eastLocal.y·sx, northLocal.y·sy, upLocal.y·sz, ty)
 *   [8..11] row2 = (eastLocal.z·sx, northLocal.z·sy, upLocal.z·sz, tz)
 *
 * @param {number} col - 列号（0 起）
 * @param {number} row - 行号（0 起）
 * @param {{originLon:number, originLat:number, cellSize:number, bottomHeight:number, gridHeight:number}} model - 网格模型参数
 * @param {{x:number,y:number,z:number,ex:number,ey:number,ez:number,nx:number,ny:number,nz:number,ux:number,uy:number,uz:number}} origin - 网格中心的 ENU 标架（ECEF 原点 + 三轴单位向量），可用 enuFrameFromMatrix 从 eastNorthUpToFixedFrame 拆出
 * @param {Float32Array|Float64Array} [out] - 写入目标，长度需 ≥ offset + 12；不传则内部新建 Float32Array(12)
 * @param {number} [offset=0] - 写入 out 的起始下标
 * @returns {Float32Array|Float64Array} 写入后的数组（即入参 out，便于链式复用）
 */
export function writeCellInstanceMatrix(
  col,
  row,
  model,
  origin,
  out = new Float32Array(12),
  offset = 0,
) {
  const f = frameScratch;
  writeCellFrame(col, row, model, f);
  const x = f[0];
  const y = f[1];
  const z = f[2];
  const ex = f[3];
  const ey = f[4];
  const nx = f[6];
  const ny = f[7];
  const nz = f[8];
  const ux = f[9];
  const uy = f[10];
  const uz = f[11];
  const sx = f[12];
  const sy = f[13];
  const sz = f[14];

  // 格中心相对网格中心的 ECEF 位移
  const dx = x - origin.x;
  const dy = y - origin.y;
  const dz = z - origin.z;

  // 位移换基到网格中心 ENU：local = R_g^T · d
  const lx = dx * origin.ex + dy * origin.ey + dz * origin.ez;
  const ly = dx * origin.nx + dy * origin.ny + dz * origin.nz;
  const lz = dx * origin.ux + dy * origin.uy + dz * origin.uz;

  // 格的 ENU 三轴换基到网格中心 ENU：eL = R_g^T · e_c（同理 nL / uL）
  const eLx = ex * origin.ex + ey * origin.ey;
  const eLy = ex * origin.nx + ey * origin.ny;
  const eLz = ex * origin.ux + ey * origin.uy;
  const nLx = nx * origin.ex + ny * origin.ey + nz * origin.ez;
  const nLy = nx * origin.nx + ny * origin.ny + nz * origin.nz;
  const nLz = nx * origin.ux + ny * origin.uy + nz * origin.uz;
  const uLx = ux * origin.ex + uy * origin.ey + uz * origin.ez;
  const uLy = ux * origin.nx + uy * origin.ny + uz * origin.nz;
  const uLz = ux * origin.ux + uy * origin.uy + uz * origin.uz;

  // 平移：格中心沿本格 up 抬升半高，使盒底面落在 bottomHeight（与 ECEF 版一致）
  const half = sz * 0.5;
  out[offset] = eLx * sx;
  out[offset + 1] = nLx * sy;
  out[offset + 2] = uLx * sz;
  out[offset + 3] = lx + uLx * half;
  out[offset + 4] = eLy * sx;
  out[offset + 5] = nLy * sy;
  out[offset + 6] = uLy * sz;
  out[offset + 7] = ly + uLy * half;
  out[offset + 8] = eLz * sx;
  out[offset + 9] = nLz * sy;
  out[offset + 10] = uLz * sz;
  out[offset + 11] = lz + uLz * half;
  return out;
}

/**
 * 对交错的 (col,row) 清单逐格计算 ECEF 版 modelMatrix（Worker 与主线程回退共用）。
 *
 * @param {Int32Array} packed - 交错格清单，形如 [col,row,col,row,...]
 * @param {{originLon:number, originLat:number, cellSize:number, bottomHeight:number, gridHeight:number}} model - 网格模型参数，与 writeCellModelMatrix 一致
 * @returns {Float64Array} 长度为「格数 × 16」的列主序矩阵数组，第 i 格占 [i*16, i*16+16)
 */
export function packCellsMatrices(packed, model) {
  const count = packed.length >> 1;
  const matrices = new Float64Array(count * 16);
  for (let i = 0, m = 0; i + 1 < packed.length; i += 2, m += 16) {
    writeCellModelMatrix(packed[i], packed[i + 1], model, matrices, m);
  }
  return matrices;
}

/**
 * 对交错的 (col,row) 清单逐格计算 ENU 局部 3×4 实例矩阵（例化方案用）。
 *
 * 产出为 Float32Array，长度为「格数 × 12」，可整段 copyFromArrayView 上传到实例缓冲。
 *
 * @param {Int32Array} packed - 交错格清单，形如 [col,row,col,row,...]
 * @param {{originLon:number, originLat:number, cellSize:number, bottomHeight:number, gridHeight:number}} model - 网格模型参数
 * @param {{x:number,y:number,z:number,ex:number,ey:number,ez:number,nx:number,ny:number,nz:number,ux:number,uy:number,uz:number}} origin - 网格中心的 ENU 标架
 * @returns {Float32Array} 长度为「格数 × 12」的行主序 3×4 矩阵数组，第 i 格占 [i*12, i*12+12)
 */
export function packCellsInstanceMatrices(packed, model, origin) {
  const count = packed.length >> 1;
  const matrices = new Float32Array(count * 12);
  for (let i = 0, m = 0; i + 1 < packed.length; i += 2, m += 12) {
    writeCellInstanceMatrix(packed[i], packed[i + 1], model, origin, matrices, m);
  }
  return matrices;
}

/**
 * 由 ENU→ECEF 变换矩阵拆出 writeCellInstanceMatrix 需要的标架对象。
 *
 * 入参为 Matrix4 的 16 元列主序数组（Transforms.eastNorthUpToFixedFrame 的产物）：
 * 第 0/1/2 列分别是 east / north / up 轴，第 3 列是原点 ECEF 坐标。
 *
 * @param {ArrayLike<number>} matrix - 4×4 列主序矩阵数组，长度 ≥ 16
 * @returns {{x:number,y:number,z:number,ex:number,ey:number,ez:number,nx:number,ny:number,nz:number,ux:number,uy:number,uz:number}} 网格中心 ENU 标架
 */
export function enuFrameFromMatrix(matrix) {
  return {
    x: matrix[12],
    y: matrix[13],
    z: matrix[14],
    ex: matrix[0],
    ey: matrix[1],
    ez: matrix[2],
    nx: matrix[4],
    ny: matrix[5],
    nz: matrix[6],
    ux: matrix[8],
    uy: matrix[9],
    uz: matrix[10],
  };
}

/**
 * 创建「中心方环」填充器：从中心格起按 Chebyshev 距离 max(|dc|,|dr|) 逐环向外产出格清单。
 *
 * 越界格自动裁剪；最外环产完后 isDone() 转 true。填充顺序与相机无关，
 * 调用方负责用已写入集合去重（重播种时可能产出已写入的格）。
 *
 * 这是「亿级格也能秒开」的核心：首屏只画相机附近，其余按帧铺开，
 * 因此不需要等全量数据到位，也不受数据规模影响首帧时间。
 *
 * @param {number} centerCol - 种子列号，越界时内部夹到 [0, cols-1]
 * @param {number} centerRow - 种子行号，越界时内部夹到 [0, rows-1]
 * @param {number} cols - 逻辑网格列数，须 ≥ 1
 * @param {number} rows - 逻辑网格行数，须 ≥ 1
 * @returns {{nextBatch: (size:number)=>Int32Array, isDone: ()=>boolean}} nextBatch(size) 返回最多 size 格的交错清单 [col,row,...]（不足则返回剩余全部，可能为空数组）；isDone() 表示所有环是否已产出完毕
 */
export function createRingFill(centerCol, centerRow, cols, rows) {
  const cx = Math.min(Math.max(0, centerCol), cols - 1);
  const cy = Math.min(Math.max(0, centerRow), rows - 1);
  const rMax = Math.max(cx, cols - 1 - cx, cy, rows - 1 - cy);
  let r = 0;
  let queue = null; // 当前环拍平 [col,row,...]
  let qi = 0;

  /**
   * 拍平第 rr 环的全部格为交错数组 [col,row,...]，越界格自动丢弃。
   *
   * 环的走向：上边（含上两角）→ 右边 → 下边（含下两角）→ 左边，四角只计一次，
   * 保证相邻环之间不重不漏。
   *
   * @param {number} rr - 环半径（Chebyshev 距离），0 表示中心格本身
   * @returns {number[]} 该环的格清单，形如 [col,row,col,row,...]；整环越界时为空数组
   */
  function buildRing(rr) {
    const out = [];
    const c0 = cx - rr;
    const c1 = cx + rr;
    const r0 = cy - rr;
    const r1 = cy + rr;
    /**
     * 收集一个格到当前环的结果数组，越界格（列/行不在 [0, cols) / [0, rows) 内）直接丢弃。
     *
     * @param {number} c - 列号
     * @param {number} rw - 行号
     * @returns {void}
     */
    const push = (c, rw) => {
      if (c >= 0 && c < cols && rw >= 0 && rw < rows) out.push(c, rw);
    };
    if (rr === 0) {
      push(cx, cy);
      return out;
    }
    for (let c = c0; c <= c1; c += 1) push(c, r1); // 上边（含上两角）
    for (let rw = r1 - 1; rw >= r0 + 1; rw -= 1) push(c1, rw); // 右边（不含角，由上下边收）
    for (let c = c1; c >= c0; c -= 1) push(c, r0); // 下边（含下两角）
    for (let rw = r0 + 1; rw <= r1 - 1; rw += 1) push(c0, rw); // 左边（不含角，由上下边收）
    return out;
  }

  /**
   * 取最多 size 个格（交错数组），环耗尽时继续换下一环，直到所有环取完。
   *
   * 返回值顺序无关，可能含调用方已写入的格，由调用方用已写入集合兜底去重。
   *
   * @param {number} size - 期望取出的格数（上限，实际可能更少）
   * @returns {Int32Array} 交错格清单 [col,row,...]；全部环已取完时为空数组
   */
  function nextBatch(size) {
    const out = [];
    while (out.length < size * 2) {
      if (qi >= (queue ? queue.length : 0)) {
        if (r > rMax) break; // 全部环已耗尽
        queue = buildRing(r);
        qi = 0;
        r += 1;
      }
      out.push(queue[qi], queue[qi + 1]);
      qi += 2;
    }
    return new Int32Array(out);
  }

  /**
   * 判断是否所有环都已产出完毕。
   *
   * @returns {boolean} true = 已越过最外环且当前环也取空，填充器不会再有新格产出
   */
  function isDone() {
    return r > rMax && qi >= (queue ? queue.length : 0);
  }

  return { nextBatch, isDone };
}
