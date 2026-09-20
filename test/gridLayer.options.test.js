/**
 * 图层选项校验与防御性行为测试。
 *
 * 这一组用例锁定的都是「调用方写错参数时会发生什么」：本包的设计约定是
 * **永远能建起来 + 打一条可定位的 warn**，而不是抛错或静默把网格画到别处。
 * 这些约定是可用性的一部分，因此用测试固定下来。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCesiumMock } from './helpers/mockCesium.js';
import { createMockViewer } from './helpers/mockViewer.js';
import { flushAllRaf } from './helpers/raf.js';

const cesiumMock = createCesiumMock();
vi.mock('cesium', () => cesiumMock);

const {
  createGridLayer,
  createInstancedGridLayer,
  createPrimitiveGridLayer,
  normalizeGridOptions,
} = await import('../src/index.js');

/** 建层用的最小参数：2×2 网格，保证一帧就能填完 */
const BASE = { originLon: 116.0, originLat: 39.0, cols: 2, rows: 2, cellSize: 0.01 };

let warnSpy;
let infoSpy;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  infoSpy.mockRestore();
});

describe('normalizeGridOptions', () => {
  it('全部缺省时给出文档化的默认值', () => {
    const { model, render, pump } = normalizeGridOptions();
    expect(model.originLon).toBe(114.5);
    expect(model.originLat).toBe(23.5);
    expect(model.cols).toBe(1000);
    expect(model.rows).toBe(1000);
    expect(model.cellSize).toBe(0.01);
    expect(model.bottomHeight).toBe(30);
    expect(model.gridHeight).toBe(180);
    expect(model.batchSize).toBe(4000);
    expect(render.instancing).toBe(true);
    expect(render.edgeShader).toBe(true);
    expect(render.mathPick).toBe(true);
    expect(render.chunkSize).toBe(128);
    expect(pump.budgetMs).toBe(4);
    expect(pump.min).toBe(256);
  });

  it('默认值无告警（未传任何字段不该刷屏）', () => {
    const { warnings } = normalizeGridOptions();
    expect(warnings).toEqual([]);
  });

  it('非对象入参按空对象处理并告警', () => {
    const { warnings, model } = normalizeGridOptions('nonsense');
    expect(model.cols).toBe(1000);
    expect(warnings.join()).toContain('options 必须是对象');
  });

  it('非法 originLon / originLat 回退默认并告警', () => {
    const { model, warnings } = normalizeGridOptions({ originLon: NaN, originLat: 'abc' });
    expect(model.originLon).toBe(114.5);
    expect(model.originLat).toBe(23.5);
    expect(warnings.join()).toContain('originLon 非法');
    expect(warnings.join()).toContain('originLat 非法');
  });

  it('字符串数字被接受（来自 URL / input 的值不该被判非法）', () => {
    const { model, warnings } = normalizeGridOptions({ originLon: '116.5', cellSize: '0.02' });
    expect(model.originLon).toBe(116.5);
    expect(model.cellSize).toBe(0.02);
    expect(warnings).toEqual([]);
  });

  it('cols / rows 向下取整且至少为 1', () => {
    expect(normalizeGridOptions({ cols: 0, rows: -5 }).model.cols).toBe(1);
    expect(normalizeGridOptions({ cols: 0, rows: -5 }).model.rows).toBe(1);
    expect(normalizeGridOptions({ cols: 12.9, rows: 3.2 }).model.cols).toBe(12);
    expect(normalizeGridOptions({ cols: 12.9, rows: 3.2 }).model.rows).toBe(3);
  });

  it('cellSize <= 0 回退默认并告警', () => {
    const { model, warnings } = normalizeGridOptions({ cellSize: 0 });
    expect(model.cellSize).toBe(0.01);
    expect(warnings.join()).toContain('cellSize 必须大于 0');
  });

  it('负 bottomHeight / 非正 gridHeight 回退默认并告警', () => {
    const { model, warnings } = normalizeGridOptions({ bottomHeight: -10, gridHeight: 0 });
    expect(model.bottomHeight).toBe(30);
    expect(model.gridHeight).toBe(180);
    expect(warnings.join()).toContain('bottomHeight 不能为负');
    expect(warnings.join()).toContain('gridHeight 必须大于 0');
  });

  it('pumpSize 被夹到 [pumpMin, pumpMax]', () => {
    const low = normalizeGridOptions({ pumpMin: 100, pumpMax: 200, pumpSize: 5 }).pump;
    expect(low.initial).toBe(100);
    const high = normalizeGridOptions({ pumpMin: 100, pumpMax: 200, pumpSize: 9999 }).pump;
    expect(high.initial).toBe(200);
  });

  it('chunkSize 夹到 [8, 1024] 并告警', () => {
    const small = normalizeGridOptions({ chunkSize: 1 });
    expect(small.render.chunkSize).toBe(8);
    expect(small.warnings.join()).toContain('chunkSize 超出');
    expect(normalizeGridOptions({ chunkSize: 99999 }).render.chunkSize).toBe(1024);
    expect(normalizeGridOptions({ chunkSize: 64 }).render.chunkSize).toBe(64);
  });

  it('edgeAlpha 夹到 [0, 1]，edgeWidthPx 必须为正', () => {
    const over = normalizeGridOptions({ edgeAlpha: 5, edgeWidthPx: -1 });
    expect(over.render.edgeAlpha).toBe(1);
    expect(over.render.edgeWidthPx).toBe(1.2);
    expect(over.warnings.join()).toContain('edgeAlpha 超出');
    expect(normalizeGridOptions({ edgeAlpha: -3 }).render.edgeAlpha).toBe(0);
  });

  it('edgeShader 优先于 outline：两者同时给时只走盒面描边', () => {
    expect(normalizeGridOptions({ edgeShader: true, outline: true }).render.outlineEnabled).toBe(
      false,
    );
    expect(normalizeGridOptions({ edgeShader: false, outline: true }).render.outlineEnabled).toBe(
      true,
    );
    expect(normalizeGridOptions({ edgeShader: false, outline: false }).render.outlineEnabled).toBe(
      false,
    );
  });

  it('颜色支持 CSS 串与 Color 实例，且返回副本（不污染入参）', () => {
    const original = new cesiumMock.Color(0.1, 0.2, 0.3, 1);
    const { model } = normalizeGridOptions({ fillColor: original, outlineColor: '#FF0000' });
    expect(model.fillColor).not.toBe(original);
    expect(model.fillColor.red).toBeCloseTo(0.1, 9);
    expect(model.outlineColor.red).toBeCloseTo(1, 9);
    model.fillColor.red = 0.9;
    expect(original.red).toBeCloseTo(0.1, 9);
  });

  it('无法解析的颜色串回退默认色', () => {
    const { model } = normalizeGridOptions({ fillColor: 'not-a-color' });
    expect(model.fillColor.red).toBeCloseTo(cesiumMock.Color.fromCssColorString('#27D9FF').red, 9);
  });

  it('layerType 非字符串时回退默认', () => {
    expect(normalizeGridOptions({ layerType: 42 }).render.layerType).toBe('independentGrid');
    expect(normalizeGridOptions({ layerType: '' }).render.layerType).toBe('independentGrid');
    expect(normalizeGridOptions({ layerType: 'weatherGrid' }).render.layerType).toBe('weatherGrid');
  });

  it('格数超过阈值时告警但不阻断', () => {
    // 阈值是 1e9，所以要超过它得用 40000×40000 = 1.6e9
    const { warnings, totalCells } = normalizeGridOptions({ cols: 40000, rows: 40000 });
    expect(totalCells).toBe(1.6e9);
    expect(warnings.join()).toContain('超过');
  });
});

describe('createGridLayer 入参防御', () => {
  it('viewer 缺失 / 已销毁时返回 null 并告警，不抛错', () => {
    expect(createGridLayer(null, BASE)).toBeNull();
    expect(createGridLayer(undefined, BASE)).toBeNull();
    const destroyed = createMockViewer();
    destroyed.destroyed = true;
    expect(createGridLayer(destroyed, BASE)).toBeNull();
    expect(warnSpy.mock.calls.join()).toContain('viewer 不可用');
  });

  it('options 传非对象时不抛错，按默认值建层', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, null);
    expect(handle).not.toBeNull();
    expect(handle.model.cols).toBe(1000);
    handle.dispose();
  });

  it('getCellColor 抛错时该格回退默认色，填充不中断，且只告警一次', () => {
    const viewer = createMockViewer();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const handle = createGridLayer(viewer, {
      ...BASE,
      getCellColor: () => {
        calls += 1;
        throw new Error('颜色文件解析失败');
      },
    });
    expect(handle).not.toBeNull();
    flushAllRaf(); // 填充由 rAF 驱动，需推进帧才会真正取色
    expect(calls).toBeGreaterThan(0);
    const warnings = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warnings).toContain('getCellColor 抛错');
    // 4 格全部写入（说明异常没有中断 addBatch）
    expect(handle.getLoadedCount()).toBe(4);
    const occurrences = warnings.split('getCellColor 抛错').length - 1;
    expect(occurrences).toBe(1);
    handle.dispose();
    errorSpy.mockRestore();
  });

  it('getCellColor 返回 Color 时只改填充色；返回对象时填充/框线各取本格色', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, {
      ...BASE,
      getCellColor: (col, row) =>
        col === 0
          ? new cesiumMock.Color(1, 0, 0, 0.5)
          : { fillColor: '#00FF00', outlineColor: '#0000FF' },
    });
    flushAllRaf();
    const first = handle.cells.get('0,0');
    expect(first.fillColor.red).toBeCloseTo(1, 9);
    expect(first.outlineColor.red).toBeCloseTo(handle.model.outlineColor.red, 9); // 框线保持默认
    const other = handle.cells.get('1,0');
    expect(other.fillColor.green).toBeCloseTo(1, 9);
    expect(other.outlineColor.blue).toBeCloseTo(1, 9);
    handle.dispose();
  });

  it('onClick 抛错不冒泡到事件分发方', () => {
    // 相机放在网格内（BASE 是 2×2 网格，origin 116.0/39.0），保证点击能命中格；
    // 否则回调根本不会被调用，这条用例就测不到异常保护。
    const viewer = createMockViewer({ cameraLonLat: { lon: 116.005, lat: 39.005 } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = createGridLayer(viewer, {
      ...BASE,
      onClick: () => {
        throw new Error('业务回调炸了');
      },
    });
    flushAllRaf();
    const handler = handle._internal.handler;
    expect(() =>
      handler.trigger(cesiumMock.ScreenSpaceEventType.LEFT_CLICK, { position: { x: 960, y: 540 } }),
    ).not.toThrow();
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join()).toContain(
      'onClick 回调执行失败',
    );
    handle.dispose();
    errorSpy.mockRestore();
  });

  it('pick 收到非法屏幕坐标时返回 null，不抛错', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    for (const bad of [undefined, null, {}, { x: NaN, y: 0 }, { x: 0 }, 'nope', 42]) {
      expect(handle.pick(bad)).toBeNull();
    }
    handle.dispose();
  });

  it('getCellByLngLat 对非法经纬度与范围外坐标返回 null', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    flushAllRaf();
    expect(handle.getCellByLngLat(NaN, 39)).toBeNull();
    expect(handle.getCellByLngLat(0, 0)).toBeNull(); // 远在网格外
    const cell = handle.getCellByLngLat(116.005, 39.005);
    expect(cell).not.toBeNull();
    expect(cell).toMatchObject({ col: 0, row: 0, west: 116.0, south: 39.0 });
    expect(cell.east).toBeCloseTo(116.01, 9);
    expect(cell.centerLon).toBeCloseTo(116.005, 9);
    handle.dispose();
  });
});

describe('渲染方案预设', () => {
  it('默认入口走例化方案（instanced 非空）', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    expect(handle.instanced).not.toBeNull();
    expect(handle.instanced._layerType).toBe('independentGrid');
    handle.dispose();
  });

  it('createInstancedGridLayer 与默认一致', () => {
    const viewer = createMockViewer();
    const handle = createInstancedGridLayer(viewer, BASE);
    expect(handle.instanced).not.toBeNull();
    handle.dispose();
  });

  it('createPrimitiveGridLayer 退回 Primitive 方案（instanced 为 null，建独立线框）', () => {
    const viewer = createMockViewer();
    const handle = createPrimitiveGridLayer(viewer, { ...BASE, layerType: 'legacy' });
    expect(handle.instanced).toBeNull();
    flushAllRaf();
    // 填充 + 线框两批，挂在同一个 PrimitiveCollection 下
    const primitives = handle.collection._items;
    expect(primitives.length).toBe(2);
    expect(primitives[0]._layerType).toBe('legacy');
    expect(primitives[0].geometryInstances.length).toBe(4);
    expect(primitives[1].geometryInstances.length).toBe(4);
    handle.dispose();
  });

  it('预设可被显式选项覆盖（options 优先）', () => {
    const viewer = createMockViewer();
    const handle = createInstancedGridLayer(viewer, { ...BASE, instancing: false });
    expect(handle.instanced).toBeNull();
    handle.dispose();
  });

  it('layerType 传入后写入 _layerType（供外部 scene.pick 识别）', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, { ...BASE, layerType: 'weatherGrid' });
    expect(handle.instanced._layerType).toBe('weatherGrid');
    handle.dispose();
  });
});
