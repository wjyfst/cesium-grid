/**
 * 纯计算模块测试（真实实现，零 mock）。
 *
 * 这里校验的是**数值正确性**，不是「代码跑通了」：椭球半径公式、ENU 正交性、
 * 两种矩阵方案的等价性、方环填充的不重不漏，都是下游渲染正确性的地基，
 * 一旦回归会表现为「网格错位 / 有空格 / 重复格」这类很难肉眼定位的问题。
 */

import { describe, expect, it } from 'vitest';
import {
  createRingFill,
  enuFrameFromMatrix,
  independentGridCellCode,
  isValidLngLat,
  packCellsInstanceMatrices,
  packCellsMatrices,
  parseCellCode,
  writeCellFrame,
  writeCellInstanceMatrix,
  writeCellModelMatrix,
} from '../src/gridMath.js';

/** WGS84 常量（与实现独立写出，避免复制粘贴掩盖错误） */
const WGS84_A = 6378137.0;
const WGS84_E2 = 0.0066943799901413165;

const MODEL = {
  originLon: 116.0,
  originLat: 39.0,
  cols: 20,
  rows: 10,
  cellSize: 0.01,
  bottomHeight: 30,
  gridHeight: 180,
};

/**
 * 用独立公式算出的卯酉圈 / 子午圈曲率半径，作为 writeCellFrame 尺度的期望值。
 *
 * @param {number} lat - 纬度（度）
 * @returns {{N:number, M:number}} 两个曲率半径（米）
 */
function curvatureRadii(lat) {
  const latR = (lat * Math.PI) / 180;
  const sinLat2 = Math.sin(latR) ** 2;
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat2);
  const M = (WGS84_A * (1 - WGS84_E2)) / Math.pow(1 - WGS84_E2 * sinLat2, 1.5);
  return { N, M };
}

/**
 * 列主序 4×4 矩阵乘法（Cesium 约定：out = a × b）。
 *
 * @param {ArrayLike<number>} a - 左矩阵，列主序 16 元
 * @param {ArrayLike<number>} b - 右矩阵，列主序 16 元
 * @returns {Float64Array} 乘积
 */
function multiply(a, b) {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * 由 ENU 标架构造 ENU→ECEF 的 4×4 列主序矩阵。
 *
 * @param {object} frame - enuFrameFromMatrix 产物
 * @returns {Float64Array} 列主序矩阵
 */
function enuToEcefMatrix(frame) {
  return Float64Array.from([
    frame.ex,
    frame.ey,
    frame.ez,
    0,
    frame.nx,
    frame.ny,
    frame.nz,
    0,
    frame.ux,
    frame.uy,
    frame.uz,
    0,
    frame.x,
    frame.y,
    frame.z,
    1,
  ]);
}

/**
 * 把 3×4 行主序实例矩阵补成 4×4 列主序矩阵（第 4 行隐含 0,0,0,1）。
 *
 * @param {ArrayLike<number>} m12 - 12 元行主序矩阵
 * @returns {Float64Array} 列主序 16 元矩阵
 */
function instanceToColumnMajor(m12) {
  const out = new Float64Array(16);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[col * 4 + row] = m12[row * 4 + col];
    }
  }
  out[15] = 1;
  return out;
}

describe('independentGridCellCode / parseCellCode', () => {
  it('编码格式为 "col,row" 且可往返', () => {
    expect(independentGridCellCode(12, 34)).toBe('12,34');
    expect(independentGridCellCode(0, 0)).toBe('0,0');
    expect(parseCellCode('12,34')).toEqual({ col: 12, row: 34 });
    expect(parseCellCode('0,0')).toEqual({ col: 0, row: 0 });
  });

  it('负数编码可往返（行列号不限于正数，解析不做范围裁剪）', () => {
    expect(parseCellCode(independentGridCellCode(-3, -7))).toEqual({ col: -3, row: -7 });
  });

  it('非法编码返回 null，不抛错', () => {
    for (const bad of ['', '12', ',34', '12,', 'a,b', '1.5,2', null, undefined, 42, {}, '12;34']) {
      expect(parseCellCode(bad)).toBeNull();
    }
  });
});

describe('isValidLngLat', () => {
  it('接受合法经纬度（含字符串数字）', () => {
    expect(isValidLngLat(116.391, 39.907)).toBe(true);
    expect(isValidLngLat('116.391', '39.907')).toBe(true);
    expect(isValidLngLat(0, 0)).toBe(true);
    expect(isValidLngLat(-180, -90)).toBe(true);
    expect(isValidLngLat(180, 90)).toBe(true);
  });

  it('拒绝空值、NaN、Infinity 与越界', () => {
    for (const bad of [
      [null, 0],
      [0, null],
      [undefined, 0],
      [0, undefined],
      [NaN, 0],
      [0, NaN],
      [Infinity, 0],
      [0, -Infinity],
      [180.001, 0],
      [-180.001, 0],
      [0, 90.001],
      [0, -90.001],
      ['abc', 0],
      [{}, 0],
      [[], 0],
      [true, 0],
    ]) {
      expect(isValidLngLat(bad[0], bad[1])).toBe(false);
    }
  });
});

describe('writeCellFrame', () => {
  it('ENU 三轴互相正交且为单位向量', () => {
    const f = new Float64Array(15);
    writeCellFrame(3, 5, MODEL, f);
    const e = [f[3], f[4], f[5]];
    const n = [f[6], f[7], f[8]];
    const u = [f[9], f[10], f[11]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const axis of [e, n, u]) {
      expect(Math.hypot(...axis)).toBeCloseTo(1, 12);
    }
    expect(dot(e, n)).toBeCloseTo(0, 12);
    expect(dot(e, u)).toBeCloseTo(0, 12);
    expect(dot(n, u)).toBeCloseTo(0, 12);
  });

  it('尺度按卯酉圈 / 子午圈曲率半径换算，且高度等于柱高', () => {
    const f = new Float64Array(15);
    const col = 3;
    const row = 5;
    writeCellFrame(col, row, MODEL, f);
    const lat = MODEL.originLat + (row + 0.5) * MODEL.cellSize;
    const { N, M } = curvatureRadii(lat);
    const perDeg = (MODEL.cellSize * Math.PI) / 180;
    expect(f[12]).toBeCloseTo(perDeg * N * Math.abs(Math.cos((lat * Math.PI) / 180)), 6);
    expect(f[13]).toBeCloseTo(perDeg * M, 6);
    expect(f[14]).toBe(MODEL.gridHeight);
  });

  it('ECEF 位置的椭球半径与解析解一致（底面高度处）', () => {
    const f = new Float64Array(15);
    const col = 7;
    const row = 2;
    writeCellFrame(col, row, MODEL, f);
    const lon = MODEL.originLon + (col + 0.5) * MODEL.cellSize;
    const lat = MODEL.originLat + (row + 0.5) * MODEL.cellSize;
    const latR = (lat * Math.PI) / 180;
    const { N } = curvatureRadii(lat);
    // 椭球上该纬度处的 ECEF 半径：sqrt((N+h)²cos²lat + (N(1-e²)+h)²sin²lat)
    // 不能简写成 N + h —— 那只在高斯平均曲率半径的意义上成立，几何距离会差十几公里。
    const expectedRadius = Math.hypot(
      (N + MODEL.bottomHeight) * Math.cos(latR),
      (N * (1 - WGS84_E2) + MODEL.bottomHeight) * Math.sin(latR),
    );
    const actual = Math.hypot(f[0], f[1], f[2]);
    expect(actual).toBeCloseTo(expectedRadius, 6);
    // 经度方向可由 x/y 反解
    expect((Math.atan2(f[1], f[0]) * 180) / Math.PI).toBeCloseTo(lon, 9);
  });

  it('高纬处尺度不退化为 0（cosLat 下限 1e-6 生效）', () => {
    const f = new Float64Array(15);
    writeCellFrame(0, 0, { ...MODEL, originLat: 90 }, f);
    expect(f[12]).toBeGreaterThan(0);
    expect(Number.isFinite(f[12])).toBe(true);
  });
});

describe('writeCellModelMatrix', () => {
  it('平移项沿 up 抬升半高，使盒底面落在 bottomHeight', () => {
    const out = new Float64Array(16);
    writeCellModelMatrix(2, 4, MODEL, out);
    const f = new Float64Array(15);
    writeCellFrame(2, 4, MODEL, f);
    const half = f[14] * 0.5;
    expect(out[12]).toBeCloseTo(f[0] + f[9] * half, 9);
    expect(out[13]).toBeCloseTo(f[1] + f[10] * half, 9);
    expect(out[14]).toBeCloseTo(f[2] + f[11] * half, 9);
    expect(out[15]).toBe(1);
  });

  it('第三列（z 轴）取 up × gridHeight，且矩阵第 4 行符合仿射约定', () => {
    const out = new Float64Array(16);
    writeCellModelMatrix(0, 0, MODEL, out);
    const f = new Float64Array(15);
    writeCellFrame(0, 0, MODEL, f);
    expect(out[8]).toBeCloseTo(f[9] * f[14], 9);
    expect(out[9]).toBeCloseTo(f[10] * f[14], 9);
    expect(out[10]).toBeCloseTo(f[11] * f[14], 9);
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(0);
    expect(out[11]).toBe(0);
  });

  it('支持 offset 写入，不覆盖相邻矩阵', () => {
    const buf = new Float64Array(32).fill(-1);
    writeCellModelMatrix(1, 1, MODEL, buf, 16);
    for (let i = 0; i < 16; i += 1) expect(buf[i]).toBe(-1);
    expect(buf[31]).toBe(1);
  });

  it('不传 out 时返回新数组（长度 16）', () => {
    const out = writeCellModelMatrix(0, 0, MODEL);
    expect(out).toBeInstanceOf(Float64Array);
    expect(out.length).toBe(16);
  });
});

describe('writeCellInstanceMatrix', () => {
  it('与 writeCellModelMatrix 数值等价：ENU→ECEF × instance === ecef', () => {
    const frame = {
      x: 0,
      y: 0,
      z: 0,
      ex: 1,
      ey: 0,
      ez: 0,
      nx: 0,
      ny: 1,
      nz: 0,
      ux: 0,
      uy: 0,
      uz: 1,
    };
    const m12 = new Float32Array(12);
    writeCellInstanceMatrix(3, 6, MODEL, frame, m12);
    const expected = new Float64Array(16);
    writeCellModelMatrix(3, 6, MODEL, expected);
    const actual = instanceToColumnMajor(m12);
    for (let i = 0; i < 16; i += 1) {
      // 实例矩阵是 float32，而平移项量级达 6.4e6 米：float32 在该量级的分辨率约 0.5 米，
      // 因此必须用相对误差比较，绝对容差在这里没有意义。
      const scale = Math.max(1, Math.abs(expected[i]));
      expect(Math.abs(actual[i] - expected[i]) / scale).toBeLessThan(1e-6);
    }
  });

  it('与任意非平凡网格中心标架组合仍满足等价关系（float32 容差内）', () => {
    // 网格中心标架取一个绕轴旋转过的正交基，验证换基公式本身正确
    const s = Math.SQRT1_2;
    const frame = {
      x: 100,
      y: 200,
      z: 300,
      ex: s,
      ey: s,
      ez: 0,
      nx: -s,
      ny: s,
      nz: 0,
      ux: 0,
      uy: 0,
      uz: 1,
    };
    const col = 2;
    const row = 3;
    const m12 = new Float32Array(12);
    writeCellInstanceMatrix(col, row, MODEL, frame, m12);
    const ecef = new Float64Array(16);
    writeCellModelMatrix(col, row, MODEL, ecef);
    const product = multiply(enuToEcefMatrix(frame), instanceToColumnMajor(m12));
    for (let i = 0; i < 16; i += 1) {
      // 相对误差比较：ECEF 量级为 6.4e6，绝对容差没有意义
      const scale = Math.max(1, Math.abs(ecef[i]));
      expect(Math.abs(product[i] - ecef[i]) / scale).toBeLessThan(1e-6);
    }
  });
});

describe('packCellsMatrices / packCellsInstanceMatrices', () => {
  const packed = new Int32Array([0, 0, 1, 2, 5, 7]);

  it('输出长度与逐格计算一致，且逐格内容相同', () => {
    const matrices = packCellsMatrices(packed, MODEL);
    expect(matrices.length).toBe(3 * 16);
    const single = new Float64Array(16);
    writeCellModelMatrix(1, 2, MODEL, single);
    for (let i = 0; i < 16; i += 1) expect(matrices[16 + i]).toBe(single[i]);
  });

  it('实例矩阵打包：长度 = 格数 × 12，Float32Array', () => {
    const origin = {
      x: 0,
      y: 0,
      z: 0,
      ex: 1,
      ey: 0,
      ez: 0,
      nx: 0,
      ny: 1,
      nz: 0,
      ux: 0,
      uy: 0,
      uz: 1,
    };
    const matrices = packCellsInstanceMatrices(packed, MODEL, origin);
    expect(matrices).toBeInstanceOf(Float32Array);
    expect(matrices.length).toBe(3 * 12);
  });

  it('空清单产出空数组（不抛错）', () => {
    expect(packCellsMatrices(new Int32Array(0), MODEL).length).toBe(0);
    expect(packCellsInstanceMatrices(new Int32Array(0), MODEL, {}).length).toBe(0);
  });
});

describe('enuFrameFromMatrix', () => {
  it('按列主序拆出原点与三轴', () => {
    const m = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
    const frame = enuFrameFromMatrix(m);
    expect(frame).toMatchObject({ x: 10, y: 20, z: 30, ex: 1, ny: 1, uz: 1 });
  });
});

describe('createRingFill', () => {
  /**
   * 取完一个填充器的全部格，返回「col,row」集合与产出顺序。
   *
   * @param {object} fill - createRingFill 产物
   * @param {number} [size=7] - 每批格数
   * @returns {{seen:string[], keys:Set<string>}} 产出顺序与去重集合
   */
  function drain(fill, size = 7) {
    const seen = [];
    const keys = new Set();
    let guard = 0;
    while (!fill.isDone() && guard < 10000) {
      const batch = fill.nextBatch(size);
      if (!batch.length) break;
      for (let i = 0; i + 1 < batch.length; i += 2) {
        const key = `${batch[i]},${batch[i + 1]}`;
        seen.push(key);
        keys.add(key);
      }
      guard += 1;
    }
    return { seen, keys };
  }

  it('不重不漏地覆盖整个逻辑网格', () => {
    const cols = 13;
    const rows = 9;
    const { seen, keys } = drain(createRingFill(6, 4, cols, rows));
    expect(keys.size).toBe(cols * rows);
    expect(seen.length).toBe(cols * rows); // 无重复
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) {
        expect(keys.has(`${c},${r}`)).toBe(true);
      }
    }
  });

  it('中心格第一个产出，且按 Chebyshev 距离单调向外', () => {
    const cols = 11;
    const rows = 11;
    const cx = 5;
    const cy = 5;
    const { seen } = drain(createRingFill(cx, cy, cols, rows), 1);
    expect(seen[0]).toBe(`${cx},${cy}`);
    let prev = 0;
    for (const key of seen) {
      const [c, r] = key.split(',').map(Number);
      const d = Math.max(Math.abs(c - cx), Math.abs(r - cy));
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it('种子越界时夹到合法区间（不产出越界格）', () => {
    const cols = 6;
    const rows = 4;
    for (const seed of [
      [-100, -100],
      [999, 999],
      [-1, 2],
      [3, 77],
    ]) {
      const { seen, keys } = drain(createRingFill(seed[0], seed[1], cols, rows));
      expect(keys.size).toBe(cols * rows);
      expect(seen.length).toBe(cols * rows);
      for (const key of seen) {
        const [c, r] = key.split(',').map(Number);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(cols);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(rows);
      }
    }
  });

  it('1×1 网格只产出一格后即结束', () => {
    const fill = createRingFill(0, 0, 1, 1);
    expect([...fill.nextBatch(10)]).toEqual([0, 0]);
    expect(fill.isDone()).toBe(true);
    expect(fill.nextBatch(10).length).toBe(0);
  });

  it('size 大于剩余格数时只返回剩余部分', () => {
    const fill = createRingFill(0, 0, 2, 2);
    const all = fill.nextBatch(1000);
    expect(all.length).toBe(8); // 4 格 × 2
    expect(fill.isDone()).toBe(true);
  });

  it('分批大小不影响覆盖结果', () => {
    const a = drain(createRingFill(4, 3, 12, 8), 1).keys;
    const b = drain(createRingFill(4, 3, 12, 8), 1000).keys;
    expect([...a].sort()).toEqual([...b].sort());
  });
});
