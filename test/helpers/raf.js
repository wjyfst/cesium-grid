/**
 * 测试环境的 rAF 替身。
 *
 * Node 环境没有 requestAnimationFrame，而网格图层的填充主循环（pumpInstanced / pumpBatch）
 * 完全建立在 rAF 之上。这里把它替换成**手动驱动**的队列：测试可以精确控制「跑几帧」，
 * 从而对填充节奏、分帧限流、dispose 后的取消行为做确定性断言，而不是靠 sleep 等真实时间。
 */

/** 待执行的回调队列：{ id, callback } */
let queue = [];
let nextId = 1;

/**
 * 安装 rAF 替身到全局（幂等）。
 *
 * @returns {void}
 */
export function installRaf() {
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextId;
    nextId += 1;
    queue.push({ id, callback });
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    queue = queue.filter((entry) => entry.id !== id);
  };
  // 图层的鼠标移动节流用 window.setTimeout；Node 下没有 window，映射到全局即可
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
  }
}

/**
 * 执行当前排队的全部 rAF 回调（新排入的会在下一轮 flush 才执行，避免无限循环）。
 *
 * @param {number} [frames=1] - 最多推进多少轮
 * @returns {number} 实际执行的轮数
 */
export function flushRaf(frames = 1) {
  let ran = 0;
  for (let i = 0; i < frames; i += 1) {
    const batch = queue;
    queue = [];
    if (!batch.length) break;
    for (const entry of batch) entry.callback();
    ran += 1;
  }
  return ran;
}

/**
 * 反复推进 rAF 直到队列为空或达到上限（用于「把填充彻底跑完」）。
 *
 * @param {number} [maxFrames=200] - 安全上限，防止被测代码写出自续循环时测试挂死
 * @returns {number} 总执行轮数
 */
export function flushAllRaf(maxFrames = 200) {
  let total = 0;
  while (total < maxFrames) {
    if (!queue.length) break;
    flushRaf(1);
    total += 1;
  }
  return total;
}

/**
 * 清空队列（每个用例前后调用，避免用例间互相污染）。
 *
 * @returns {void}
 */
export function resetRaf() {
  queue = [];
  nextId = 1;
}

/**
 * 当前待执行的 rAF 回调数量。
 *
 * @returns {number} 队列长度
 */
export function pendingRafCount() {
  return queue.length;
}
