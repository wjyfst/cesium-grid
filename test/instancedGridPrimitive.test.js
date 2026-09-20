/**
 * 例化渲染层（instancedGridPrimitive）测试。
 *
 * 这一层直接和 Cesium 渲染器打交道（Buffer / VertexArray / DrawCommand / ShaderProgram），
 * 是整包最「靠近硬件」的部分。测试目标不是复刻 GPU 行为，而是把三条**只能靠代码契约保证**的
 * 不变量固定下来——它们在真实浏览器里出错时都表现为「画面不对/卡顿」，极难反查：
 *
 * 1. 每块只下发 1 个 DrawCommand，且 instanceCount 等于该块已写入格数（不是容量）；
 * 2. 共享顶点/索引缓冲必须 vertexArrayDestroyable = false，否则 VertexArray.destroy() 会连带
 *    销毁它们，多块共用时第二块起就会渲染失败；
 * 3. destroy() 必须把逐块缓冲与共享 GPU 资源全部释放，且幂等（Cesium 的 isDestroyed() 恒为
 *    false，不能依赖它做二次保护）。
 */

import { describe, expect, it, vi } from 'vitest';
import { createCesiumMock } from './helpers/mockCesium.js';

const cesiumMock = createCesiumMock();
vi.mock('cesium', () => cesiumMock);

const { createInstancedGridPrimitive } = await import('../src/index.js');

const MODEL = {
  originLon: 116.0,
  originLat: 39.0,
  cols: 10,
  rows: 10,
  cellSize: 0.01,
  bottomHeight: 30,
  gridHeight: 180,
};

/**
 * 造一个最小的 frameState：本层只用到 context 与 commandList。
 *
 * @returns {{context: object, commandList: Array<object>}} 帧状态替身
 */
function createFrameState() {
  return {
    context: {
      createPickId: vi.fn(() => ({ color: [0, 0, 0, 0], destroy: vi.fn() })),
    },
    commandList: [],
  };
}

/**
 * 构造一个例化渲染对象并写入全部格。
 *
 * 注意 chunkSize 下限是 8（MIN_CHUNK_SIZE），传更小的值会被夹取——
 * 10×10 网格配 chunkSize 8 恰好是 2×2 = 4 块。
 *
 * @param {object} [options={}] - 覆盖 createInstancedGridPrimitive 的配置
 * @returns {{primitive: object, frameState: object}} 渲染对象与帧状态
 */
function createFilled(options = {}) {
  const primitive = createInstancedGridPrimitive({ model: MODEL, chunkSize: 8, ...options });
  const packed = [];
  for (let col = 0; col < MODEL.cols; col += 1) {
    for (let row = 0; row < MODEL.rows; row += 1) packed.push(col, row);
  }
  primitive.writePackedCells(
    new Int32Array(packed),
    () => new cesiumMock.Color(0.2, 0.4, 0.6, 0.5),
  );
  const frameState = createFrameState();
  return { primitive, frameState };
}

/** 10×10 网格在 chunkSize=8 下的块数 */
const CHUNKS = 4;

describe('createInstancedGridPrimitive 构造', () => {
  it('按 chunkSize 分块，容量为 cols × rows，每格 52 字节', () => {
    const primitive = createInstancedGridPrimitive({ model: MODEL, chunkSize: 8 });
    const stats = primitive.getStats();
    // 10×10、块边长 8 → 2×2 = 4 块（末列末行各差 2 格，不满）
    expect(stats.chunks).toBe(CHUNKS);
    expect(stats.chunkSize).toBe(8);
    expect(stats.capacity).toBe(100);
    expect(stats.bytesPerInstance).toBe(52);
    expect(stats.writtenCells).toBe(0);
    expect(stats.allocatedChunks).toBe(0); // 延迟分配：未写入不该占内存
  });

  it('chunkSize 被夹到 [8, 1024]', () => {
    expect(createInstancedGridPrimitive({ model: MODEL, chunkSize: 1 }).getStats().chunkSize).toBe(
      8,
    );
    expect(
      createInstancedGridPrimitive({ model: MODEL, chunkSize: 99999 }).getStats().chunkSize,
    ).toBe(1024);
  });

  it('写入前不分配 CPU 缓冲（按需分配，避免大网格构造即爆内存）', () => {
    const primitive = createInstancedGridPrimitive({ model: MODEL, chunkSize: 8 });
    expect(primitive.getStats().allocatedBytes).toBe(0);
    primitive.writePackedCells(new Int32Array([0, 0]), null);
    const stats = primitive.getStats();
    expect(stats.allocatedChunks).toBe(1);
    expect(stats.allocatedBytes).toBeGreaterThan(0);
  });
});

describe('writePackedCells', () => {
  it('返回与格清单一一对应的 handle，越界格为 -1', () => {
    const primitive = createInstancedGridPrimitive({ model: MODEL, chunkSize: 8 });
    // 第二格列号越界
    const handles = primitive.writePackedCells(new Int32Array([0, 0, 99, 0, 1, 1]), null);
    expect(handles.length).toBe(3);
    expect(handles[0]).toBeGreaterThanOrEqual(0);
    expect(handles[1]).toBe(-1);
    expect(handles[2]).toBeGreaterThanOrEqual(0);
  });

  it('重复写入同一格返回相同 handle，且不重复计入 writtenCells', () => {
    const primitive = createInstancedGridPrimitive({ model: MODEL, chunkSize: 8 });
    const first = primitive.writePackedCells(new Int32Array([2, 3]), null);
    const second = primitive.writePackedCells(new Int32Array([2, 3]), null);
    expect(second[0]).toBe(first[0]);
    expect(primitive.getStats().writtenCells).toBe(1);
  });

  it('onCell 回调带上 handle 与取到的颜色；越界格不触发回调', () => {
    const primitive = createInstancedGridPrimitive({ model: MODEL, chunkSize: 8 });
    const seen = [];
    const color = new cesiumMock.Color(1, 0, 0, 1);
    primitive.writePackedCells(
      new Int32Array([0, 0, 99, 99]),
      () => color,
      (col, row, handle, got) => seen.push({ col, row, handle, got }),
    );
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ col: 0, row: 0 });
    expect(seen[0].handle).toBeGreaterThanOrEqual(0);
    expect(seen[0].got).toBe(color);
  });

  it('destroy 后写入被忽略（返回全 -1）', () => {
    const primitive = createInstancedGridPrimitive({ model: MODEL, chunkSize: 8 });
    primitive.destroy();
    const handles = primitive.writePackedCells(new Int32Array([0, 0]), null);
    expect(handles[0]).toBe(-1);
  });
});

describe('update（每帧下发绘制命令）', () => {
  it('每块一个 DrawCommand，instanceCount 等于该块已写入格数', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    const stats = primitive.getStats();
    expect(frameState.commandList.length).toBe(CHUNKS);
    const totalInstances = frameState.commandList.reduce((sum, cmd) => sum + cmd.instanceCount, 0);
    expect(totalInstances).toBe(stats.writtenCells);
    expect(stats.writtenCells).toBe(100);
  });

  it('块内格数不满时 instanceCount 只算已写入量（不是容量）', () => {
    const primitive = createInstancedGridPrimitive({ model: MODEL, chunkSize: 8 });
    primitive.writePackedCells(new Int32Array([0, 0, 1, 0, 2, 0]), null);
    const frameState = createFrameState();
    primitive.update(frameState);
    expect(frameState.commandList.length).toBe(1);
    expect(frameState.commandList[0].instanceCount).toBe(3);
  });

  it('脏区间只上传一次，第二次 update 无新上传', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    const afterFirst = primitive.getStats().uploadBytes;
    expect(afterFirst).toBeGreaterThan(0);
    primitive.update(frameState);
    expect(primitive.getStats().uploadBytes).toBe(afterFirst);
  });

  it('show=false 时不下发命令', () => {
    const { primitive, frameState } = createFilled();
    primitive.show = false;
    primitive.update(frameState);
    expect(frameState.commandList.length).toBe(0);
  });

  it('destroy 后 update 不下发命令', () => {
    const { primitive, frameState } = createFilled();
    primitive.destroy();
    primitive.update(frameState);
    expect(frameState.commandList.length).toBe(0);
  });

  it('DrawCommand 使用世界坐标包围球与 float64 modelMatrix（大平移不在实例矩阵里）', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    const cmd = frameState.commandList[0];
    expect(cmd.boundingVolume.radius).toBeGreaterThan(0);
    expect(cmd.modelMatrix.length).toBe(16);
    expect(cmd.pickId).toBe('czm_pickColor');
    expect(cmd.count).toBeGreaterThan(0);
  });
});

describe('共享与逐块 GPU 资源的所有权', () => {
  it('共享顶点/索引缓冲与逐块实例缓冲都置 vertexArrayDestroyable = false', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    // 共享缓冲通过 gpu 闭包持有，逐块缓冲可从 VertexArray 的 attributes 反查
    for (const cmd of frameState.commandList) {
      const buffers = new Set(
        cmd.vertexArray.attributes
          .map((attr) => attr.vertexBuffer)
          .filter((buffer) => buffer && buffer.vertexArrayDestroyable === false),
      );
      expect(buffers.size).toBeGreaterThan(0);
      for (const buffer of buffers) {
        expect(buffer.vertexArrayDestroyable).toBe(false);
      }
    }
  });

  it('多块共享同一份顶点/索引缓冲（不是每块一份）', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    const positionBuffers = new Set(
      frameState.commandList.map((cmd) => cmd.vertexArray.attributes[0].vertexBuffer),
    );
    const indexBuffers = new Set(frameState.commandList.map((cmd) => cmd.vertexArray.indexBuffer));
    expect(positionBuffers.size).toBe(1);
    expect(indexBuffers.size).toBe(1);
  });

  it('每块持有各自的实例矩阵与颜色缓冲', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    const matrixBuffers = new Set(
      frameState.commandList.map((cmd) => cmd.vertexArray.attributes[2].vertexBuffer),
    );
    expect(matrixBuffers.size).toBe(frameState.commandList.length);
  });
});

describe('setCellColor / setAllFillColor / setBottomHeight', () => {
  it('setCellColor 只标记该格的颜色脏区间', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    const before = primitive.getStats().uploadBytes;
    expect(primitive.setCellColor(0, new cesiumMock.Color(1, 0, 0, 1))).toBe(true);
    primitive.update(frameState);
    // 单格 4 字节
    expect(primitive.getStats().uploadBytes - before).toBe(4);
  });

  it('setCellColor 对非法 handle 返回 false', () => {
    const { primitive } = createFilled();
    expect(primitive.setCellColor(-1, new cesiumMock.Color(1, 0, 0, 1))).toBe(false);
    expect(primitive.setCellColor(999999, new cesiumMock.Color(1, 0, 0, 1))).toBe(false);
  });

  it('setAllFillColor 为每块各标记一段连续脏区间', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    const before = primitive.getStats().uploadBytes;
    primitive.setAllFillColor(new cesiumMock.Color(0, 1, 0, 1));
    primitive.update(frameState);
    expect(primitive.getStats().uploadBytes - before).toBe(100 * 4);
  });

  it('setBottomHeight 后由 update 限流重写矩阵，不阻塞单帧', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    primitive.setBottomHeight();
    // heightChunksPerFrame 默认 4 → 4 块一帧写完
    primitive.update(frameState);
    expect(primitive.getStats().heightRewriteFrames).toBe(1);
  });

  it('heightChunksPerFrame 可调，用来控制单帧重写量', () => {
    const { primitive, frameState } = createFilled({ heightChunksPerFrame: 1 });
    primitive.update(frameState);
    primitive.setBottomHeight();
    // 每帧 1 块 → 4 块需 4 帧
    primitive.update(frameState);
    expect(primitive.getStats().heightRewriteFrames).toBe(1);
    primitive.update(frameState);
    primitive.update(frameState);
    primitive.update(frameState);
    expect(primitive.getStats().heightRewriteFrames).toBe(4);
  });

  it('setBottomHeight 不改变已写入格数与命令数', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    const commands = frameState.commandList.length;
    const written = primitive.getStats().writtenCells;
    primitive.setBottomHeight();
    frameState.commandList.length = 0;
    primitive.update(frameState);
    expect(frameState.commandList.length).toBe(commands);
    expect(primitive.getStats().writtenCells).toBe(written);
  });
});

describe('destroy', () => {
  it('释放逐块缓冲与共享资源，且幂等', () => {
    const { primitive, frameState } = createFilled();
    primitive.update(frameState);
    const cmd = frameState.commandList[0];
    const chunkMatrixBuffer = cmd.vertexArray.attributes[2].vertexBuffer;

    primitive.destroy();
    expect(primitive.isDestroyed()).toBe(true);
    expect(chunkMatrixBuffer.destroy).toHaveBeenCalled();
    expect(() => primitive.destroy()).not.toThrow();
  });

  it('instanceCount 聚合全部块的已写入格数', () => {
    const { primitive } = createFilled();
    expect(primitive.instanceCount).toBe(100);
  });
});
