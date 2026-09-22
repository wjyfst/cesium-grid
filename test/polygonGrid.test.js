/**
 * 多边形面内网格生成器测试（真实实现，零 mock）。
 *
 * 这里校验的是**几何正确性**：bbox 对齐、中心点在面内过滤（外环含边线、洞含边线）、
 * 竖直堆叠层数与层模型、面内方环填充的不重不漏。一旦回归，表现为「面外格混入 /
 * 洞内格没剔 / 层高错」这类很难肉眼定位的问题，故全部用精确断言固定下来。
 */

import { describe, expect, it } from 'vitest';
import {
  createPolygonRingFill,
  generatePolygonGrid,
  isPointInPolygon,
  normalizePolygonGeometry,
  packCellsMatrices,
} from '../src/gridMath.js';

/**
 * 构造轴对齐矩形 Polygon（闭合环，经纬度为度）。
 *
 * @param {number} w - 西边界经度
 * @param {number} s - 南边界纬度
 * @param {number} e - 东边界经度
 * @param {number} n - 北边界纬度
 * @returns {object} GeoJSON Polygon
 */
function rectPolygon(w, s, e, n) {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

/**
 * 构造两个轴对齐矩形组成的 MultiPolygon。
 *
 * @param {[number, number, number, number]} a - 矩形 A [w, s, e, n]
 * @param {[number, number, number, number]} b - 矩形 B [w, s, e, n]
 * @returns {object} GeoJSON MultiPolygon
 */
function twoRects(a, b) {
  return {
    type: 'MultiPolygon',
    coordinates: [rectPolygon(...a).coordinates, rectPolygon(...b).coordinates],
  };
}

/**
 * 取完一个填充器的全部格，返回「col,row」集合与产出顺序。
 *
 * @param {object} fill - createPolygonRingFill 产物
 * @param {number} [size=3] - 每批格数
 * @returns {{seen: string[], keys: Set<string>}} 产出顺序与去重集合
 */
function drain(fill, size = 3) {
  const seen = [];
  const keys = new Set();
  let guard = 0;
  while (!fill.isDone() && guard < 1000) {
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

/**
 * 把 cells2d 交错数组转成 「col,row」 字符串集合，便于断言。
 *
 * @param {Int32Array} cells2d
 * @returns {Set<string>}
 */
function cellSet(cells2d) {
  const set = new Set();
  for (let i = 0; i + 1 < cells2d.length; i += 2) set.add(`${cells2d[i]},${cells2d[i + 1]}`);
  return set;
}

describe('bbox 对齐与中心点过滤', () => {
  it('bbox 边长恰好整除 cellSize 时，中心点全部在面内的矩形格全部保留', () => {
    const grid = generatePolygonGrid(rectPolygon(116.0, 39.0, 117.0, 39.5), { cellSize: 0.5 });
    expect(grid.originLon).toBeCloseTo(116.0, 9);
    expect(grid.originLat).toBeCloseTo(39.0, 9);
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(1);
    expect(grid.cellCount2d).toBe(2);
    expect([...grid.cells2d]).toEqual([0, 0, 1, 0]);
  });

  it('bbox 四角的面外格被剔除（菱形面只留中心在菱形内的格）', () => {
    // 菱形 |lon-116.5|/0.5 + |lat-39.25|/0.25 <= 1；bbox 116~117 × 39~39.5
    const diamond = {
      type: 'Polygon',
      coordinates: [
        [
          [116.5, 39.0],
          [117.0, 39.25],
          [116.5, 39.5],
          [116.0, 39.25],
          [116.5, 39.0],
        ],
      ],
    };
    const grid = generatePolygonGrid(diamond, { cellSize: 0.25 });
    expect(grid.cols).toBe(4);
    expect(grid.rows).toBe(2);
    // 四个 bbox 角格中心都在菱形外；只剩中间 2×2
    expect(grid.cellCount2d).toBe(4);
    expect([...grid.cells2d]).toEqual([1, 0, 2, 0, 1, 1, 2, 1]);
  });

  it('格中心恰好落在外环边上时算面内（保留）', () => {
    // 矩形西/东边界正好穿过 col 0 / col 2 的中心（116.375 / 116.875）
    const grid = generatePolygonGrid(rectPolygon(116.375, 39.0, 116.875, 39.5), { cellSize: 0.25 });
    expect(grid.cols).toBe(3);
    expect(grid.rows).toBe(2);
    expect(grid.cellCount2d).toBe(6);
    expect([...grid.cells2d]).toEqual([0, 0, 1, 0, 2, 0, 0, 1, 1, 1, 2, 1]);
  });

  it('负经度（西半球）bbox 对齐正确，floor/ceil 不漂移', () => {
    const grid = generatePolygonGrid(rectPolygon(-11.02, -5.5, -11.0, -5.49), { cellSize: 0.01 });
    expect(grid.originLon).toBeCloseTo(-11.02, 6);
    expect(grid.originLat).toBeCloseTo(-5.5, 6);
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(1);
    expect(grid.cellCount2d).toBe(2);
  });
});

describe('洞（hole）处理', () => {
  it('洞内与洞边上的格中心被剔除，洞外格保留', () => {
    const poly = {
      type: 'Polygon',
      coordinates: [
        [
          [116.0, 39.0],
          [117.0, 39.0],
          [117.0, 39.5],
          [116.0, 39.5],
          [116.0, 39.0],
        ],
        // 洞：其左右边正好穿过 col 2 的格中心（116.625）
        [
          [116.5, 39.125],
          [116.75, 39.125],
          [116.75, 39.375],
          [116.5, 39.375],
          [116.5, 39.125],
        ],
      ],
    };
    const grid = generatePolygonGrid(poly, { cellSize: 0.25 });
    expect(grid.cols).toBe(4);
    expect(grid.rows).toBe(2);
    expect(grid.cellCount2d).toBe(6);
    const set = cellSet(grid.cells2d);
    // 洞中心两格（中心落在洞边线上）必须被剔除
    expect(set.has('2,0')).toBe(false);
    expect(set.has('2,1')).toBe(false);
    // 其余六格保留
    for (const key of ['0,0', '1,0', '3,0', '0,1', '1,1', '3,1']) expect(set.has(key)).toBe(true);
    expect([...grid.cells2d]).toEqual([0, 0, 1, 0, 3, 0, 0, 1, 1, 1, 3, 1]);
  });

  it('isPointInPolygon 对洞边 / 外环边 / 洞中心 / 面外点的语义', () => {
    const { polygons } = normalizePolygonGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [116.0, 39.0],
          [117.0, 39.0],
          [117.0, 39.5],
          [116.0, 39.5],
          [116.0, 39.0],
        ],
        [
          [116.5, 39.125],
          [116.75, 39.125],
          [116.75, 39.375],
          [116.5, 39.375],
          [116.5, 39.125],
        ],
      ],
    });
    expect(isPointInPolygon(116.25, 39.25, polygons)).toBe(true); // 外环内、洞外
    expect(isPointInPolygon(116.625, 39.25, polygons)).toBe(false); // 洞中心
    expect(isPointInPolygon(116.625, 39.125, polygons)).toBe(false); // 洞边线（算洞内）
    expect(isPointInPolygon(116.0, 39.25, polygons)).toBe(true); // 外环边线（算面内）
    expect(isPointInPolygon(117.5, 39.25, polygons)).toBe(false); // 面外
  });
});

describe('MultiPolygon 与 Feature 包装', () => {
  it('MultiPolygon 产出各多边形面内格的并集，中间空隙不产格', () => {
    const grid = generatePolygonGrid(
      twoRects([116.0, 39.0, 116.25, 39.25], [116.75, 39.0, 117.0, 39.25]),
      {
        cellSize: 0.25,
      },
    );
    expect(grid.cols).toBe(4);
    expect(grid.rows).toBe(1);
    expect(grid.cellCount2d).toBe(2);
    expect([...grid.cells2d]).toEqual([0, 0, 3, 0]);
  });

  it('Feature 包装可解析（properties 忽略），FeatureCollection 抛错', () => {
    const bare = rectPolygon(116.0, 39.0, 117.0, 39.5);
    const asFeature = generatePolygonGrid(
      { type: 'Feature', properties: { name: 'x' }, geometry: bare },
      { cellSize: 0.5 },
    );
    expect(asFeature.cellCount2d).toBe(generatePolygonGrid(bare, { cellSize: 0.5 }).cellCount2d);
    expect(() =>
      generatePolygonGrid({ type: 'FeatureCollection', features: [] }, { cellSize: 0.5 }),
    ).toThrow(TypeError);
  });

  it('未闭合环自动闭合后与已闭合环结果一致', () => {
    const closed = generatePolygonGrid(rectPolygon(116.0, 39.0, 117.0, 39.5), { cellSize: 0.5 });
    const unclosed = {
      type: 'Polygon',
      coordinates: [
        [
          [116.0, 39.0],
          [117.0, 39.0],
          [117.0, 39.5],
          [116.0, 39.5],
        ],
      ],
    };
    const grid = generatePolygonGrid(unclosed, { cellSize: 0.5 });
    expect(grid.cellCount2d).toBe(closed.cellCount2d);
    expect([...grid.cells2d]).toEqual([...closed.cells2d]);
  });

  it('不修改入参（含未闭合环的自动闭合）', () => {
    const poly = {
      type: 'Polygon',
      coordinates: [
        [
          [116.0, 39.0],
          [117.0, 39.0],
          [117.0, 39.5],
          [116.0, 39.5],
        ],
      ],
    };
    const before = JSON.stringify(poly);
    generatePolygonGrid(poly, { cellSize: 0.5 });
    expect(JSON.stringify(poly)).toBe(before);
  });
});

describe('竖直堆叠层', () => {
  it('layers=3：层数、cells3d 布局与 layerModels 底高全部正确', () => {
    const grid = generatePolygonGrid(rectPolygon(116.0, 39.0, 117.0, 39.5), {
      cellSize: 0.5,
      layers: 3,
      bottomHeight: 10,
      gridHeight: 20,
    });
    expect(grid.layers).toBe(3);
    expect(grid.cellCount2d).toBe(2);
    expect(grid.cellCount3d).toBe(6);
    expect(grid.cells3d.length).toBe(18);

    // 外层 layer 升序，内层 (col,row) 顺序与 cells2d 相同
    const n = grid.cellCount2d;
    for (let k = 0; k < grid.layers; k += 1) {
      for (let i = 0; i < n; i += 1) {
        const base = k * n * 3 + i * 3;
        expect(grid.cells3d[base]).toBe(grid.cells2d[i * 2]);
        expect(grid.cells3d[base + 1]).toBe(grid.cells2d[i * 2 + 1]);
        expect(grid.cells3d[base + 2]).toBe(k);
      }
    }

    // 层模型：第 k 层底高 = 10 + k × 20，几何参数与网格一致
    expect(grid.layerModels.map((m) => m.bottomHeight)).toEqual([10, 30, 50]);
    for (const m of grid.layerModels) {
      expect(m.originLon).toBe(grid.originLon);
      expect(m.originLat).toBe(grid.originLat);
      expect(m.cellSize).toBe(grid.cellSize);
      expect(m.gridHeight).toBe(20);
    }

    // 每层 cells2d + 该层模型可直接喂现有矩阵打包
    const matrices = packCellsMatrices(grid.cells2d, grid.layerModels[0]);
    expect(matrices.length).toBe(grid.cellCount2d * 16);
  });

  it('layers 向下取整（2.9 → 2），layers 缺省为 1', () => {
    const poly = rectPolygon(116.0, 39.0, 117.0, 39.5);
    const floored = generatePolygonGrid(poly, { cellSize: 0.5, layers: 2.9 });
    expect(floored.layers).toBe(2);
    expect(floored.cellCount3d).toBe(floored.cellCount2d * 2);
    const defaultLayers = generatePolygonGrid(poly, { cellSize: 0.5 });
    expect(defaultLayers.layers).toBe(1);
  });
});

describe('非法输入一律抛错（不静默回退）', () => {
  const poly = rectPolygon(116.0, 39.0, 117.0, 39.5);

  it('cellSize 非法：0 / 负数 / 非数字串', () => {
    for (const bad of [0, -0.1, 'abc']) {
      expect(() => generatePolygonGrid(poly, { cellSize: bad })).toThrow(RangeError);
    }
  });

  it('layers 非法：0 / 0.5 / 负数 / 非数字', () => {
    for (const bad of [0, 0.5, -2, 'x']) {
      expect(() => generatePolygonGrid(poly, { cellSize: 0.5, layers: bad })).toThrow(RangeError);
    }
  });

  it('bottomHeight 为负、gridHeight 非正', () => {
    expect(() => generatePolygonGrid(poly, { cellSize: 0.5, bottomHeight: -1 })).toThrow(
      RangeError,
    );
    expect(() => generatePolygonGrid(poly, { cellSize: 0.5, gridHeight: 0 })).toThrow(RangeError);
  });

  it('几何非法：类型不支持 / 空坐标 / 非法经纬度点 / 点数不足', () => {
    for (const bad of [null, {}, { type: 'Polygon', coordinates: [] }]) {
      expect(() => generatePolygonGrid(bad, { cellSize: 0.5 })).toThrow(TypeError);
    }
    // 经度越界点
    const badPoint = {
      type: 'Polygon',
      coordinates: [
        [
          [200, 39.0],
          [201, 39.0],
          [201, 39.5],
          [200, 39.5],
          [200, 39.0],
        ],
      ],
    };
    expect(() => generatePolygonGrid(badPoint, { cellSize: 0.5 })).toThrow(TypeError);
    // 缺纬度分量
    const missingLat = {
      type: 'Polygon',
      coordinates: [[[116.0], [117.0, 39.0], [117.0, 39.5], [116.0, 39.5], [116.0, 39.0]]],
    };
    expect(() => generatePolygonGrid(missingLat, { cellSize: 0.5 })).toThrow(TypeError);
    // 外环仅 2 个点
    const twoPoints = {
      type: 'Polygon',
      coordinates: [
        [
          [116.0, 39.0],
          [117.0, 39.5],
          [116.0, 39.0],
        ],
      ],
    };
    expect(() => generatePolygonGrid(twoPoints, { cellSize: 0.5 })).toThrow(TypeError);
    // 闭合后仅 2 个不同点（三点但首尾相同且只有两个不同点）
    const degenerate = {
      type: 'Polygon',
      coordinates: [
        [
          [116.0, 39.0],
          [117.0, 39.5],
          [117.0, 39.5],
        ],
      ],
    };
    expect(() => generatePolygonGrid(degenerate, { cellSize: 0.5 })).toThrow(TypeError);
  });
});

describe('告警（不阻断）', () => {
  it('点数不足的洞被丢弃并告警，外环不受影响', () => {
    const poly = {
      type: 'Polygon',
      coordinates: [
        [
          [116.0, 39.0],
          [117.0, 39.0],
          [117.0, 39.25],
          [116.0, 39.25],
          [116.0, 39.0],
        ],
        [
          [116.5, 39.1],
          [116.6, 39.2],
        ], // 仅 2 点的洞 → 丢弃
      ],
    };
    const grid = generatePolygonGrid(poly, { cellSize: 0.25 });
    expect(grid.warnings.some((w) => w.includes('洞'))).toBe(true);
    // 与无洞结果一致：4 列 × 1 行全保留
    expect(grid.cellCount2d).toBe(4);
  });

  it('经度跨度 > 180° 时告警疑似跨日界线（仍继续计算）', () => {
    const crossing = {
      type: 'Polygon',
      coordinates: [
        [
          [179, -1],
          [179, 1],
          [-179, 1],
          [-179, -1],
          [179, -1],
        ],
      ],
    };
    const grid = generatePolygonGrid(crossing, { cellSize: 0.01 });
    expect(grid.warnings.some((w) => w.includes('日界线'))).toBe(true);
    expect(grid.cellCount2d).toBeGreaterThan(0);
  });
});

describe('createPolygonRingFill（面内方环填充）', () => {
  /** 带洞的 4×2 网格：面内 6 格（见「洞处理」用例） */
  function holeGrid() {
    return generatePolygonGrid(
      {
        type: 'Polygon',
        coordinates: [
          [
            [116.0, 39.0],
            [117.0, 39.0],
            [117.0, 39.5],
            [116.0, 39.5],
            [116.0, 39.0],
          ],
          [
            [116.5, 39.125],
            [116.75, 39.125],
            [116.75, 39.375],
            [116.5, 39.375],
            [116.5, 39.125],
          ],
        ],
      },
      { cellSize: 0.25 },
    );
  }

  const EXPECTED = new Set(['0,0', '1,0', '3,0', '0,1', '1,1', '3,1']);

  it('种子在面内：不重不漏铺满全部面内格，种子格最先产出', () => {
    const { seen, keys } = drain(createPolygonRingFill(holeGrid(), 1, 0), 3);
    expect(seen[0]).toBe('1,0');
    expect(keys.size).toBe(6);
    expect(seen.length).toBe(6);
    for (const key of keys) expect(EXPECTED.has(key)).toBe(true);
  });

  it('种子在洞内：换用 Chebyshev 最近的面内格（并列取更小 col，再更小 row）', () => {
    // 种子 (2,0) 在洞里；最近面内格并列四个，tie-break 应取 (1,0)
    const { seen, keys } = drain(createPolygonRingFill(holeGrid(), 2, 0), 1);
    expect(seen[0]).toBe('1,0');
    expect(keys.size).toBe(6);
    for (const key of keys) expect(EXPECTED.has(key)).toBe(true);
  });

  it('种子越界：夹到网格边缘后仍铺满（夹取点 (3,1) 在面内时它最先产出）', () => {
    const { seen, keys } = drain(createPolygonRingFill(holeGrid(), 99, 99), 1);
    expect(seen[0]).toBe('3,1');
    expect(keys.size).toBe(6);
    for (const key of keys) expect(EXPECTED.has(key)).toBe(true);
  });

  it('分批大小不影响覆盖结果', () => {
    const a = drain(createPolygonRingFill(holeGrid(), 1, 0), 1).keys;
    const b = drain(createPolygonRingFill(holeGrid(), 1, 0), 1000).keys;
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('面内无格：立即 isDone，nextBatch 返回空', () => {
    const tiny = generatePolygonGrid(rectPolygon(116.0, 39.0, 116.001, 39.001), { cellSize: 0.1 });
    expect(tiny.cellCount2d).toBe(0);
    const fill = createPolygonRingFill(tiny, 0, 0);
    expect(fill.isDone()).toBe(true);
    expect(fill.nextBatch(10).length).toBe(0);
  });
});
