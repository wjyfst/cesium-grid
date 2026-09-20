/**
 * Viewer 测试替身。
 *
 * 网格图层会碰 viewer 的这些部分：scene.primitives（挂集合）、scene.canvas（事件处理器）、
 * scene.postRender（就绪补写）、scene.requestRenderMode / requestRender（按需渲染）、
 * scene.globe.ellipsoid（数学拾取）、camera.pickEllipsoid / positionCartographic（种子与拾取）、
 * isDestroyed / destroy（生命周期）。这里把它们都做成可断言的桩。
 */

import { vi } from 'vitest';

/**
 * 创建 Viewer 替身。
 *
 * @param {object} [options={}] - 配置
 * @param {boolean} [options.requestRenderMode=true] - 是否开启按需渲染
 * @param {{lon:number, lat:number}} [options.cameraLonLat] - 相机所在经纬度，决定填充种子
 * @param {(position: object) => object|null} [options.pickEllipsoid] - 自定义数学拾取结果；缺省按 cameraLonLat 反算
 * @returns {object} Viewer 替身（含 __postRender / __primitives 等测试探针）
 */
export function createMockViewer(options = {}) {
  const requestRenderMode = options.requestRenderMode !== false;
  const cameraLonLat = options.cameraLonLat || { lon: 116.391, lat: 39.907 };

  /** postRender 监听集合：测试可直接调用 __emitPostRender() 触发 */
  const postRenderListeners = new Set();

  const primitives = {
    items: [],
    add(item) {
      this.items.push(item);
      return item;
    },
    remove(item) {
      const i = this.items.indexOf(item);
      if (i < 0) return false;
      this.items.splice(i, 1);
      return true;
    },
    removeAll() {
      this.items.length = 0;
    },
  };

  const scene = {
    primitives,
    canvas: { width: 1920, height: 1080 },
    globe: { ellipsoid: { name: 'WGS84' } },
    requestRenderMode,
    requestRender: vi.fn(),
    postRender: {
      addEventListener(fn) {
        postRenderListeners.add(fn);
      },
      removeEventListener(fn) {
        postRenderListeners.delete(fn);
      },
    },
  };

  const viewer = {
    scene,
    camera: {
      positionCartographic: {
        longitude: (cameraLonLat.lon * Math.PI) / 180,
        latitude: (cameraLonLat.lat * Math.PI) / 180,
        height: 1000,
      },
      pickEllipsoid:
        options.pickEllipsoid ||
        ((position) => {
          if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
            return undefined;
          }
          // 把屏幕坐标线性映射回经纬度：格边长 0.01° 时，1 像素 ≈ 0.0001°，
          // 因此 canvas 中心 (960, 540) 命中相机所在格，其余像素落在相邻格上。
          const lon = cameraLonLat.lon + (position.x - 960) * 0.0001;
          const lat = cameraLonLat.lat - (position.y - 540) * 0.0001;
          return { x: 0, y: 0, z: 0, _lon: lon, _lat: lat, _height: 0 };
        }),
    },
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy: vi.fn(function destroy() {
      viewer.destroyed = true;
    }),
    /** 测试探针：触发全部 postRender 监听 */
    __emitPostRender() {
      for (const fn of [...postRenderListeners]) fn();
    },
    /** 测试探针：当前 postRender 监听数量 */
    get __postRenderCount() {
      return postRenderListeners.size;
    },
  };

  return viewer;
}
