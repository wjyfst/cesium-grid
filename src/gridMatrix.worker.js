/**
 * @Description: 独立立体网格 Worker：按主线程下发的 (col,row) 清单打包每格 modelMatrix，
 *   不碰 Cesium / WebGL。主线程保留清单副本随消息回传（transfer 零拷贝）。
 *
 *   以 module worker 形式加载（`new Worker(url, { type: 'module' })`），
 *   因此可以直接 import 纯计算模块，不需要打包器做额外内联处理。
 *   浏览器不支持 module worker 或资源解析失败时，主线程会回退到同步计算
 *   （见 workerFactory.js 与 gridLayer.js 的 ensurePacked 分支），功能不受影响。
 */
import { packCellsMatrices } from './gridMath.js';

/**
 * Worker 消息入口：接收主线程下发的格清单，逐格算出 modelMatrix 后回传。
 *
 * 只处理 `type === 'packCells'` 的消息，其余消息直接忽略。
 * 入站消息结构：`{ type:'packCells', requestId:number, cells:Int32Array, model:object }`；
 * 出站消息回带同一个 requestId 与 cells（主线程按高度版本重算时要复用清单），
 * 并把 cells.buffer、matrices.buffer 一并 transfer，避免结构化克隆复制大数组。
 *
 * @param {MessageEvent<{type:string, requestId:number, cells:Int32Array, model:object}>} event - 主线程发来的消息事件
 * @returns {void}
 */
self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.type !== 'packCells') return;
  const matrices = packCellsMatrices(data.cells, data.model);
  self.postMessage(
    {
      type: 'packCells',
      requestId: data.requestId,
      cells: data.cells,
      matrices,
    },
    [data.cells.buffer, matrices.buffer],
  );
};
