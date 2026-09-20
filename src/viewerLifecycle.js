/**
 * @Description: Viewer 生命周期工具（无业务耦合，可被任意 Cesium 图层复用）。
 *   提供两件事：
 *   1. isViewerAlive：销毁后调用 Cesium API 会抛错，所有图层入口都要先过这一关；
 *   2. onViewerBeforeDestroy：图层把「释放自身资源」的回调登记到 viewer 上，
 *      由 viewer.destroy() 统一触发，避免调用方漏调 dispose 造成 WebGL 上下文与监听泄漏。
 *
 *   设计要点：**viewer.destroy 包装**——首次为某个 viewer 登记钩子时，
 *   把 viewer.destroy 换成「先 flush 全部钩子、再调用原 destroy」的版本，
 *   于是消费者只要按 Cesium 官方方式销毁 viewer，图层资源就会自动回收，无需额外 API。
 *   若不做这层包装，消费者就得自己记住调用 dispose，漏调即泄漏。
 *   包装以 WeakMap 记账，同一 viewer 只包一次；钩子清空后自动还原原方法。
 *
 *   HMR / 多标签页注意：viewer 不销毁会持续占用 WebGL 上下文（浏览器有数量上限，
 *   超限报 "Too many active WebGL contexts"），本模块正是为此提供兜底。
 */

/** @type {WeakMap<object, Set<Function>>} viewer → 销毁前钩子集合 */
const beforeDestroyHooks = new WeakMap();
/** @type {WeakMap<object, Function>} viewer → 被替换掉的原 destroy 方法 */
const originalDestroy = new WeakMap();

/**
 * Viewer 是否仍可安全调用 Cesium API。
 *
 * Cesium 的 Viewer.destroy() 之后继续调用任何 API 都会抛 DeveloperError，
 * 异步回调（Worker 回包、fetch 回来的建层逻辑、定时器）里必须先过这一关。
 *
 * @param {import('cesium').Viewer|null|undefined} viewer - 待检查的 Viewer
 * @returns {boolean} true = 存在且未销毁
 */
export function isViewerAlive(viewer) {
  return !!viewer && typeof viewer.isDestroyed === 'function' && !viewer.isDestroyed();
}

/**
 * 取出该 viewer 当前登记的全部钩子并清空注册表。
 *
 * 先清空再逐个执行：钩子内部若再次登记（例如图层重建）不会与本次执行互相干扰。
 *
 * @param {object} viewer - 目标 Viewer
 * @returns {Function[]} 钩子数组（已从注册表移除）；无登记时为空数组
 */
function drainHooks(viewer) {
  const hooks = beforeDestroyHooks.get(viewer);
  if (!hooks || !hooks.size) return [];
  beforeDestroyHooks.delete(viewer);
  return [...hooks];
}

/**
 * 用「先 flush 钩子、再调用原 destroy」的包装替换 viewer.destroy（同一 viewer 只替换一次）。
 *
 * 包装保持原方法的 this 绑定与返回值，因此对调用方完全透明。
 * 钩子执行中抛错只打日志，不阻断其余钩子与真正的 viewer 销毁。
 *
 * @param {import('cesium').Viewer} viewer - 目标 Viewer
 * @returns {void}
 */
function patchViewerDestroy(viewer) {
  if (originalDestroy.has(viewer)) return;
  const original = viewer.destroy;
  if (typeof original !== 'function') return;
  originalDestroy.set(viewer, original);
  viewer.destroy = function patchedDestroy(...args) {
    for (const fn of drainHooks(this)) {
      try {
        fn(this);
      } catch (error) {
        console.error('[cesium-grid] viewer 销毁前钩子执行失败', error);
      }
    }
    originalDestroy.delete(this);
    return original.apply(this, args);
  };
}

/**
 * 登记「viewer 销毁前」回调，返回取消登记的函数。
 *
 * 回调会在 viewer.destroy() 真正执行前同步调用，用于解绑监听、终止 Worker、
 * 销毁 ScreenSpaceEventHandler、移除 PrimitiveCollection 等。
 *
 * 幂等且安全：viewer 不可用或 fn 不是函数时返回空操作，不抛错。
 *
 * @param {import('cesium').Viewer} viewer - 目标 Viewer
 * @param {(viewer: import('cesium').Viewer) => void} fn - 销毁前回调，入参为 viewer 本身
 * @returns {() => void} 取消登记函数；重复调用无副作用
 */
export function onViewerBeforeDestroy(viewer, fn) {
  if (!isViewerAlive(viewer) || typeof fn !== 'function') return () => {};
  let set = beforeDestroyHooks.get(viewer);
  if (!set) {
    set = new Set();
    beforeDestroyHooks.set(viewer, set);
    patchViewerDestroy(viewer);
  }
  set.add(fn);
  return () => {
    const current = beforeDestroyHooks.get(viewer);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) {
      beforeDestroyHooks.delete(viewer);
      // 钩子清空：还原原 destroy，避免长期持有包装函数
      const original = originalDestroy.get(viewer);
      if (original) {
        viewer.destroy = original;
        originalDestroy.delete(viewer);
      }
    }
  };
}

/**
 * 手动触发某 viewer 的全部销毁前钩子（不销毁 viewer 本身）。
 *
 * 适用于「要复用同一个 viewer 但需要清空全部图层」的场景（如切换业务页面、
 * keep-alive 里重建图层集合）。正常销毁走 viewer.destroy() 即可，无需调用本函数。
 *
 * @param {import('cesium').Viewer} viewer - 目标 Viewer
 * @returns {number} 实际执行的钩子数量
 */
export function flushViewerBeforeDestroy(viewer) {
  const hooks = drainHooks(viewer);
  for (const fn of hooks) {
    try {
      fn(viewer);
    } catch (error) {
      console.error('[cesium-grid] viewer 销毁前钩子执行失败', error);
    }
  }
  return hooks.length;
}
