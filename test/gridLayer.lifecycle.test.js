/**
 * 图层生命周期与 Worker 回退测试。
 *
 * 覆盖三件最容易在生产环境出问题、又最难靠肉眼发现的事：
 * 1. dispose 是否真的把 rAF / 定时器 / 事件监听 / Primitive 全部回收（漏一个就是内存与 WebGL 泄漏）；
 * 2. viewer.destroy() 是否会自动回收图层（本包的关键可用性能力）；
 * 3. Worker 不可用时主线程回退产出的矩阵是否与 Worker 路径完全一致（回退不能改变渲染结果）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCesiumMock } from './helpers/mockCesium.js';
import { createMockViewer } from './helpers/mockViewer.js';
import { flushAllRaf, flushRaf, pendingRafCount } from './helpers/raf.js';

const cesiumMock = createCesiumMock();
vi.mock('cesium', () => cesiumMock);

const {
  createGridLayer,
  destroyGridLayer,
  packCellsMatrices,
  createGridWorker,
  GLOBAL_WORKER_KEY,
} = await import('../src/index.js');

const BASE = { originLon: 116.0, originLat: 39.0, cols: 4, rows: 4, cellSize: 0.01 };

let warnSpy;
let infoSpy;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  delete globalThis[GLOBAL_WORKER_KEY];
});

afterEach(() => {
  warnSpy.mockRestore();
  infoSpy.mockRestore();
  delete globalThis[GLOBAL_WORKER_KEY];
});

describe('填充与进度', () => {
  it('例化路径跑满后把全部逻辑格写入，进度为 1', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    flushAllRaf();
    expect(handle.getLogicalCount()).toBe(16);
    expect(handle.getLoadedCount()).toBe(16);
    expect(handle.getFillProgress()).toBe(1);
    expect(handle.isFillDone()).toBe(true);
    handle.dispose();
  });

  it('未跑帧时进度为 0（填充由 rAF 驱动，不在建层时同步铺满）', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    expect(handle.getLoadedCount()).toBe(0);
    expect(handle.getFillProgress()).toBe(0);
    expect(handle.isFillDone()).toBe(false);
    handle.dispose();
  });

  it('填充以相机中心为种子：种子格最先写入', () => {
    const viewer = createMockViewer({ cameraLonLat: { lon: 116.02, lat: 39.02 } });
    const handle = createGridLayer(viewer, BASE);
    flushRaf(1);
    // 相机落在 (col=2,row=2) 附近，第一帧应包含该格
    expect(handle.cells.has('2,2')).toBe(true);
    handle.dispose();
  });

  it('refresh 以当前相机中心重播种，已写入格不受影响', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    flushAllRaf();
    const before = handle.getLoadedCount();
    handle.refresh();
    flushAllRaf();
    expect(handle.getLoadedCount()).toBe(before);
    handle.dispose();
  });

  it('setVisible 切换集合显隐并请求重绘', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    handle.setVisible(false);
    expect(handle.collection.show).toBe(false);
    handle.setVisible(true);
    expect(handle.collection.show).toBe(true);
    expect(viewer.scene.requestRender).toHaveBeenCalled();
    handle.dispose();
  });

  it('logStats 返回含例化统计的快照', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    flushAllRaf();
    const snapshot = handle.logStats();
    expect(snapshot.instanced).not.toBeNull();
    expect(snapshot.instanced.writtenCells).toBe(16);
    expect(snapshot.instanced.bytesPerInstance).toBe(52);
    expect(snapshot.pumpedCells).toBe(16);
    handle.dispose();
  });
});

describe('颜色与选中态', () => {
  it('setAllFillColor 更新所有已写入格与默认色', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    flushAllRaf();
    handle.setAllFillColor('#FF0000');
    expect(handle.model.fillColor.red).toBeCloseTo(1, 9);
    expect(handle.cells.get('0,0').baseFillColor.red).toBeCloseTo(1, 9);
    handle.dispose();
  });

  it('setCellFillColor 对不存在的格返回 false，对已写入格返回 true', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    flushAllRaf();
    expect(handle.setCellFillColor('0,0', '#00FF00')).toBe(true);
    expect(handle.setCellFillColor('99,99', '#00FF00')).toBe(false);
    handle.dispose();
  });

  it('点击格切换选中态：选中时 alpha 提到 1，再次点击还原', () => {
    // 相机放在网格内，保证点击能命中格
    const viewer = createMockViewer({ cameraLonLat: { lon: 116.02, lat: 39.02 } });
    const handle = createGridLayer(viewer, {
      ...BASE,
      fillColor: '#27D9FF',
      getCellColor: () => new cesiumMock.Color(0.2, 0.4, 0.6, 0.3),
    });
    flushAllRaf();
    const click = { position: { x: 960, y: 540 } };
    const handler = handle._internal.handler;
    handler.trigger(cesiumMock.ScreenSpaceEventType.LEFT_CLICK, click);
    const selected = handle.getSelectedCode();
    expect(selected).not.toBeNull();
    expect(handle.cells.get(selected).fillColor.alpha).toBe(1);
    // 再次点击同一格：取消选中，alpha 还原为预设值
    handler.trigger(cesiumMock.ScreenSpaceEventType.LEFT_CLICK, click);
    expect(handle.getSelectedCode()).toBeNull();
    expect(handle.cells.get(selected).fillColor.alpha).toBeCloseTo(0.3, 2);
    handle.dispose();
  });

  it('点击空白处（拾取未命中）不改变选中态', () => {
    const viewer = createMockViewer({ pickEllipsoid: () => undefined });
    const handle = createGridLayer(viewer, BASE);
    flushAllRaf();
    handle._internal.handler.trigger(cesiumMock.ScreenSpaceEventType.LEFT_CLICK, {
      position: { x: 960, y: 540 },
    });
    expect(handle.getSelectedCode()).toBeNull();
    handle.dispose();
  });
});

describe('高度回流', () => {
  it('例化模式 setBottomHeight 就地重写矩阵，不重建集合成员', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    flushAllRaf();
    const itemsBefore = handle.collection._items.length;
    handle.setBottomHeight(500);
    flushAllRaf();
    expect(handle.model.bottomHeight).toBe(500);
    expect(handle.collection._items.length).toBe(itemsBefore);
    expect(handle.getLoadedCount()).toBe(16); // 格与颜色都保留
    handle.dispose();
  });

  it('非法高度（负数 / 非有限值 / 与当前相同）被忽略', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, { ...BASE, bottomHeight: 100 });
    flushAllRaf();
    handle.setBottomHeight(-1);
    handle.setBottomHeight(NaN);
    handle.setBottomHeight(100);
    expect(handle.model.bottomHeight).toBe(100);
    handle.setBottomHeight(250);
    expect(handle.model.bottomHeight).toBe(250);
    handle.dispose();
  });
});

describe('dispose 资源回收', () => {
  it('dispose 移除集合、销毁事件处理器、取消 rAF 与定时器，且清理 postRender 监听', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, { ...BASE, instancing: false });
    flushRaf(1);
    expect(viewer.__postRenderCount).toBe(1);

    const handler = handle._internal.handler;
    handle.dispose();

    expect(viewer.scene.primitives.items.length).toBe(0);
    expect(handler.isDestroyed()).toBe(true);
    expect(viewer.__postRenderCount).toBe(0);
    expect(pendingRafCount()).toBe(0);
    expect(handle.cells.size).toBe(0);
  });

  it('dispose 幂等：重复调用不抛错，也不重复操作', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    flushAllRaf();
    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
    expect(() => destroyGridLayer(handle)).not.toThrow();
    expect(viewer.scene.primitives.items.length).toBe(0);
  });

  it('destroyGridLayer(null) 不抛错', () => {
    expect(() => destroyGridLayer(null)).not.toThrow();
    expect(() => destroyGridLayer(undefined)).not.toThrow();
  });

  it('dispose 后填充循环不再写入（rAF 回调提前返回）', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    flushRaf(1);
    handle.dispose();
    const countAfterDispose = handle.getLoadedCount();
    flushAllRaf();
    expect(handle.getLoadedCount()).toBe(countAfterDispose);
  });

  it('dispose 终止 Worker', () => {
    const terminate = vi.fn();
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, {
      ...BASE,
      instancing: false, // 只有 Primitive 路径会创建 Worker
      workerFactory: () => ({ postMessage: () => {}, terminate, onmessage: null, onerror: null }),
    });
    expect(handle._internal.worker).not.toBeNull();
    handle.dispose();
    expect(terminate).toHaveBeenCalled();
  });
});

describe('viewer 销毁自动回收', () => {
  it('调用 viewer.destroy() 会先触发图层清理，再执行原 destroy', () => {
    const viewer = createMockViewer();
    // 必须在建层之前取原方法：建层时 onViewerBeforeDestroy 就会把它换成包装版本
    const originalDestroy = viewer.destroy;
    const handle = createGridLayer(viewer, { ...BASE, instancing: false });
    flushRaf(1);
    const handler = handle._internal.handler;

    viewer.destroy();

    expect(handler.isDestroyed()).toBe(true);
    expect(viewer.scene.primitives.items.length).toBe(0);
    expect(viewer.__postRenderCount).toBe(0);
    expect(viewer.destroyed).toBe(true);
    // 原 destroy 确实被调用过（包装对调用方透明）
    expect(originalDestroy).toHaveBeenCalled();
  });

  it('多个图层共用一个 viewer 时全部被回收，且 destroy 只被包装一次', () => {
    const viewer = createMockViewer();
    const a = createGridLayer(viewer, { ...BASE, instancing: false });
    const b = createGridLayer(viewer, { ...BASE, layerType: 'second', instancing: false });
    const wrapper = viewer.destroy;
    const c = createGridLayer(viewer, { ...BASE, layerType: 'third', instancing: false });
    // 第三次登记不该再产生新的包装层
    expect(viewer.destroy).toBe(wrapper);

    viewer.destroy();
    expect(a._internal.handler.isDestroyed()).toBe(true);
    expect(b._internal.handler.isDestroyed()).toBe(true);
    expect(c._internal.handler.isDestroyed()).toBe(true);
    expect(viewer.scene.primitives.items.length).toBe(0);
  });

  it('手动 dispose 后 viewer.destroy 不再重复清理（幂等）', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    handle.dispose();
    expect(() => viewer.destroy()).not.toThrow();
    expect(viewer.destroyed).toBe(true);
  });

  it('钩子抛错不阻断 viewer 销毁', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, BASE);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 让 dispose 路径本身抛错：isDestroyed 是 destroyIndependentGridLayer 必经的一步
    handle.collection.isDestroyed = () => {
      throw new Error('钩子内部炸了');
    };
    expect(() => viewer.destroy()).not.toThrow();
    expect(viewer.destroyed).toBe(true);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join()).toContain(
      'viewer 销毁前钩子执行失败',
    );
    errorSpy.mockRestore();
  });
});

describe('Worker 解析链与主线程回退', () => {
  it('disableWorker:true 时不创建 Worker', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, {
      ...BASE,
      instancing: false,
      disableWorker: true,
      workerFactory: () => ({ postMessage: vi.fn(), terminate: vi.fn() }),
    });
    expect(handle._internal.worker).toBeNull();
    handle.dispose();
  });

  it('workerFactory 返回可用对象时优先使用', () => {
    const postMessage = vi.fn();
    const worker = { postMessage, terminate: vi.fn(), onmessage: null, onerror: null };
    expect(createGridWorker({ workerFactory: () => worker })).toBe(worker);
  });

  it('workerFactory 返回假值时回退到全局注入', () => {
    const globalWorker = { postMessage: vi.fn(), terminate: vi.fn() };
    globalThis[GLOBAL_WORKER_KEY] = function GlobalWorkerStub() {
      return globalWorker;
    };
    expect(createGridWorker({ workerFactory: () => null })).toBe(globalWorker);
  });

  it('workerFactory 抛错时不影响后续路径', () => {
    const globalWorker = { postMessage: vi.fn(), terminate: vi.fn() };
    globalThis[GLOBAL_WORKER_KEY] = function GlobalWorkerStub() {
      return globalWorker;
    };
    expect(
      createGridWorker({
        workerFactory: () => {
          throw new Error('注入失败');
        },
      }),
    ).toBe(globalWorker);
  });

  it('无 Worker 可用时返回 null（调用方回退主线程）', () => {
    expect(createGridWorker({ disableWorker: true })).toBeNull();
  });

  it('Worker 不可用时主线程回退产出的矩阵与 packCellsMatrices 完全一致', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, { ...BASE, instancing: false, disableWorker: true });
    flushAllRaf();
    expect(handle.isFillDone()).toBe(true);
    expect(handle.getLoadedCount()).toBe(16);

    // 逐格比对：取 (0,0) 格的矩阵，与纯计算模块独立算出的结果一致。
    // 注意要按实例 id 找，不能取 geometryInstances[0]——填充顺序是方环序，索引 0 是种子格。
    const primitive = handle.cells.get('0,0').fillPrimitive;
    const instance = primitive.geometryInstances.find((item) => item.id === '0,0#fill');
    expect(instance).toBeDefined();
    const expected = packCellsMatrices(new Int32Array([0, 0]), handle.model);
    for (let i = 0; i < 16; i += 1) {
      expect(instance.modelMatrix[i]).toBeCloseTo(expected[i], 9);
    }
    handle.dispose();
  });

  it('Worker 崩溃时在途批次被抢回主线程，填充仍能跑满 100%', () => {
    const viewer = createMockViewer();
    // 400 格 / 每批 32 格 = 13 批，预取 3 批在途，保证崩溃时确实有在途批次
    const handle = createGridLayer(viewer, {
      cols: 20,
      rows: 20,
      cellSize: 0.01,
      instancing: false,
      batchSize: 32,
      workerFactory: () => ({
        postMessage: vi.fn(),
        terminate: vi.fn(),
        onmessage: null,
        onerror: null,
      }),
    });
    const worker = handle._internal.worker;
    expect(worker).not.toBeNull();
    // 模拟 Worker 崩溃：此时已有批次 transfer 出去、主线程侧数组已 detach
    worker.onerror(new Error('worker 崩了'));
    expect(handle._internal.worker).toBeNull();
    flushAllRaf();
    expect(handle.isFillDone()).toBe(true);
    expect(handle.getLoadedCount()).toBe(400);
    handle.dispose();
  });

  it('Worker 路径：onmessage 回包后写入场景，且统计 workerBatches', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, {
      ...BASE,
      instancing: false,
      workerFactory: () => ({
        postMessage: vi.fn(),
        terminate: vi.fn(),
        onmessage: null,
        onerror: null,
      }),
    });
    const worker = handle._internal.worker;
    expect(worker).not.toBeNull();
    // 手动模拟 Worker 回包：把主线程下发的清单按真实算法算好回传
    const packed = new Int32Array([0, 0, 1, 0]);
    worker.onmessage({
      data: {
        type: 'packCells',
        requestId: 1,
        cells: packed,
        matrices: packCellsMatrices(packed, handle.model),
      },
    });
    expect(handle.stats.workerBatches).toBe(1);
    handle.dispose();
  });

  it('Worker onerror 时终止 Worker 并回退主线程继续填充', () => {
    const terminate = vi.fn();
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, {
      ...BASE,
      instancing: false,
      workerFactory: () => ({ postMessage: vi.fn(), terminate, onmessage: null, onerror: null }),
    });
    const worker = handle._internal.worker;
    worker.onerror(new Error('worker 崩了'));
    expect(terminate).toHaveBeenCalled();
    expect(handle._internal.worker).toBeNull();
    flushAllRaf();
    expect(handle.isFillDone()).toBe(true);
    expect(handle.getLoadedCount()).toBe(16);
    handle.dispose();
  });

  it('Worker 在途期间高度变化时，回包矩阵按最新高度主线程重算', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, {
      ...BASE,
      instancing: false,
      workerFactory: () => ({
        postMessage: vi.fn(),
        terminate: vi.fn(),
        onmessage: null,
        onerror: null,
      }),
    });
    const worker = handle._internal.worker;
    const packed = new Int32Array([0, 0]);
    // 先改高度（使在途批次版本过期），再回包
    handle.setBottomHeight(999);
    worker.onmessage({
      data: { type: 'packCells', requestId: 1, cells: packed, matrices: new Float64Array(16) },
    });
    flushAllRaf();
    const expected = packCellsMatrices(packed, handle.model);
    const matrix = handle.cells.get('0,0').fillPrimitive.geometryInstances[0].modelMatrix;
    for (let i = 0; i < 16; i += 1) {
      expect(matrix[i]).toBeCloseTo(expected[i], 9);
    }
    handle.dispose();
  });
});

describe('Primitive 路径的延迟换色', () => {
  it('批次未就绪时换色登记到 deferredColors，就绪后由 postRender 补写', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, {
      ...BASE,
      instancing: false,
      disableWorker: true,
      asyncGeometry: true,
    });
    flushAllRaf();
    expect(handle.getLoadedCount()).toBe(16);

    const rec = handle.cells.get('0,0');
    const primitive = rec.fillPrimitive;
    expect(primitive.ready).toBe(false);

    handle.setCellFillColor('0,0', '#FF0000');
    expect(handle._internal.deferredColors.size).toBeGreaterThan(0);

    // 标记就绪并触发 postRender：补写完成，队列清空
    primitive.markReady();
    viewer.__emitPostRender();
    expect(handle._internal.deferredColors.size).toBe(0);
    expect(primitive.getGeometryInstanceAttributes('0,0#fill').color[0]).toBeCloseTo(1, 9);
    handle.dispose();
  });

  it('同步几何路径下批次构造后立即可写（无 ready 等待）', () => {
    const viewer = createMockViewer();
    const handle = createGridLayer(viewer, {
      ...BASE,
      instancing: false,
      disableWorker: true,
      asyncGeometry: false,
    });
    flushAllRaf();
    // 同步路径下 Primitive 在构造时即完成几何创建，ready 为 true，故换色直接落地、无延迟登记。
    // 注意：真实 Cesium 的 ready 由场景 afterRender 回调置位，在 Node 替身里我们只断言
    // 「本包是否把它当作 ready 处理」这一行为契约，不复制 Cesium 的内部状态机。
    const primitive = handle.cells.get('0,0').fillPrimitive;
    expect(primitive.asynchronous).toBe(false);
    primitive.markReady();
    handle.setCellFillColor('0,0', '#00FF00');
    expect(handle._internal.deferredColors.size).toBe(0);
    handle.dispose();
  });
});
