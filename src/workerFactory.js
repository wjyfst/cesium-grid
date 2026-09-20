/**
 * @Description: Worker 解析链（包可用性的关键一环）。
 *
 *   作为 npm 包发布，Worker 的加载方式不能依赖任何打包器专有语法
 *   （例如 Vite 的 `?worker` 后缀，Webpack / Rspack / 原生 ESM 都无法解析）。
 *   这里按优先级尝试四条路径，全部失败则返回 null，由调用方退回主线程同步计算
 *   （功能完全一致，只是把每格矩阵计算搬回主线程）：
 *
 *   1. options.workerFactory —— 调用方注入，返回 Worker 实例；返回假值/抛错则继续下探。
 *      需要自定义 worker 加载策略（CDN、内联 blob、共享 Worker）时用这个。
 *   2. globalThis.__CESIUM_GRID_WORKER__ —— 全局注入的构造器。
 *      Vite 项目可以自己 `import W from '@wjyfst/cesium-grid/src/gridMatrix.worker.js?worker'`
 *      后挂到全局。
 *   3. 内置默认：静态字面量的 `new Worker(new URL('./gridMatrix.worker.js', import.meta.url))`。
 *      new URL(..., import.meta.url) 是 Vite 与 Webpack 5 都能静态识别的标准写法，
 *      会被各自打包成独立 chunk 并改写为最终 URL。module worker 需要 Chrome 80+ /
 *      Firefox 114+ / Safari 15+；旧浏览器会走到第 4 步。
 *   4. 返回 null → 主线程回退。
 *
 *   注意：若消费方的打包器把本包纳入依赖预打包（Vite 的 optimizeDeps），
 *   import.meta.url 会指向预打包产物，导致 worker 资源 404。此时二选一：
 *   - vite.config.js 里 `optimizeDeps: { exclude: ['@wjyfst/cesium-grid'] }`；
 *   - 或用 workerFactory 显式注入。
 */

/** 全局注入槽位的属性名（供 Vite `?worker` 用法挂载） */
const GLOBAL_WORKER_KEY = '__CESIUM_GRID_WORKER__';

/**
 * 创建矩阵打包 Worker。
 *
 * 永不抛错：任何一步失败都只打一条 warn 并继续下探，最终返回 null 表示「无 Worker 可用」。
 *
 * @param {object} [options={}] - 配置
 * @param {boolean} [options.disableWorker=false] - true = 跳过全部路径，强制主线程计算（用于性能对照或规避 worker 环境问题）
 * @param {() => Worker|null|undefined} [options.workerFactory] - 自定义 Worker 工厂；返回值需实现 postMessage / terminate / onmessage / onerror
 * @returns {Worker|null} Worker 实例；不可用时为 null
 */
export function createGridWorker(options = {}) {
  if (options.disableWorker) return null;

  // 1. 调用方注入
  if (typeof options.workerFactory === 'function') {
    try {
      const injected = options.workerFactory();
      if (injected && typeof injected.postMessage === 'function') return injected;
      console.warn('[cesium-grid] workerFactory 未返回可用 Worker，继续尝试内置加载方式');
    } catch (error) {
      console.warn('[cesium-grid] workerFactory 执行失败，继续尝试内置加载方式', error);
    }
  }

  // 2. 全局注入（Vite `?worker` 用法）
  const globalCtor = globalThis[GLOBAL_WORKER_KEY];
  if (typeof globalCtor === 'function') {
    try {
      const injected = new globalCtor();
      if (injected && typeof injected.postMessage === 'function') return injected;
    } catch (error) {
      console.warn('[cesium-grid] 全局 Worker 构造器实例化失败，继续尝试内置加载方式', error);
    }
  }

  // 3. 内置默认：静态字面量，交给打包器识别并产出独立 worker chunk
  if (typeof Worker === 'function' && typeof URL === 'function') {
    try {
      return new Worker(new URL('./gridMatrix.worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      console.warn(
        '[cesium-grid] 内置 Worker 创建失败，回退主线程计算（可用 workerFactory 注入或 disableWorker:true 消除本告警）',
        error,
      );
    }
  }

  // 4. 回退
  return null;
}

export { GLOBAL_WORKER_KEY };
