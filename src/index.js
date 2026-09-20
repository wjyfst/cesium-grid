/**
 * @Description: @wjyfst/cesium-grid —— CesiumJS 亿级独立立体网格图层。
 *
 *   自带 Worker 解析链与防御性校验，不依赖调用方的路径别名或生命周期函数。
 *
 *   入口格式（三层，按使用频率排列）：
 *
 *   1) 主入口 —— 建/销一个网格图层
 *      import { createGridLayer, destroyGridLayer } from '@wjyfst/cesium-grid';
 *      const handle = createGridLayer(viewer, { originLon, originLat, cols, rows, cellSize });
 *      handle.setBottomHeight(300);   // 抬到 300m
 *      destroyGridLayer(handle);      // 或交给 viewer.destroy() 自动回收
 *
 *      预设入口（只是把渲染方案显式化，参数与主入口完全一致）：
 *      - createInstancedGridLayer：例化方案（默认，52 B/格，写入即渲染）
 *      - createPrimitiveGridLayer：Primitive 方案（1440 B/格，但支持独立框线色相与 GPU 拾取）
 *
 *   2) 纯计算 —— 不需要 WebGL / DOM，可在 Node、Worker 或数据预处理脚本里跑
 *      import { createRingFill, writeCellModelMatrix, parseCellCode } from '@wjyfst/cesium-grid';
 *
 *   3) 高级 —— 直接操作 GPU 实例缓冲的渲染层与生命周期工具
 *      import { createInstancedGridPrimitive, isViewerAlive } from '@wjyfst/cesium-grid';
 *
 *   注意：本包依赖 Cesium 渲染器层 API（Buffer / VertexArray / DrawCommand / ShaderProgram /
 *   RenderState / Context.createPickId），这些是 Cesium 内部接口，官方不保证跨大版本兼容。
 *   peerDependencies 因此锁定 `cesium >=1.110.0 <2.0.0`；升级 Cesium 大版本前请先跑通
 *   README「手工验证清单」里的浏览器端目视检查。
 */

// —— 主入口：图层构建与销毁 ——
export {
  createGridLayer,
  createInstancedGridLayer,
  createPrimitiveGridLayer,
  createIndependentGridLayer,
  destroyIndependentGridLayer,
} from './gridLayer.js';

/**
 * 释放网格图层（推荐入口名，等价于 destroyIndependentGridLayer）。
 *
 * 幂等；viewer 销毁时会自动触发，通常无需手动调用。
 */
export { destroyIndependentGridLayer as destroyGridLayer } from './gridLayer.js';

// —— 纯计算：无 Cesium 依赖，可在 Node / Worker 中直接使用 ——
export {
  independentGridCellCode,
  parseCellCode,
  isValidLngLat,
  writeCellFrame,
  writeCellModelMatrix,
  writeCellInstanceMatrix,
  packCellsMatrices,
  packCellsInstanceMatrices,
  enuFrameFromMatrix,
  createRingFill,
} from './gridMath.js';

// —— 高级：渲染层与生命周期工具 ——
export { createInstancedGridPrimitive } from './instancedGridPrimitive.js';
export {
  isViewerAlive,
  onViewerBeforeDestroy,
  flushViewerBeforeDestroy,
} from './viewerLifecycle.js';
export { createGridWorker, GLOBAL_WORKER_KEY } from './workerFactory.js';

// —— 选项默认值与归一化（自定义包装层时复用，保证默认值只有一处定义）——
export {
  normalizeGridOptions,
  toColor,
  toOpaque,
  DEFAULT_FILL,
  DEFAULT_OUTLINE,
  DEFAULT_GRID,
} from './defaults.js';
