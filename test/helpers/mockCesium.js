/**
 * Cesium 的测试替身（vi.mock('cesium') 的工厂产物）。
 *
 * 目标不是复刻 Cesium，而是提供「足够真实到能跑通网格图层全部 JS 分支」的最小实现：
 * - Color 支持 clone / withAlpha / fromCssColorString（toColor / toOpaque 的真实语义）；
 * - Cartesian3 + Cartographic 支持 fromDegrees ↔ fromCartesian 往返（数学拾取路径要能算出 col/row）；
 * - Matrix4 是真 Float64Array 子类，fromArray / toArray / eastNorthUpToFixedFrame 与列主序约定一致
 *   （模型矩阵的数值正确性由 gridMath.test.js 用真实公式校验，这里只保证搬运不丢数据）；
 * - PrimitiveCollection / Primitive / GeometryInstance 记录入参，供断言检查；
 * - ScreenSpaceEventHandler 记录 action，供测试主动触发 LEFT_CLICK / MOUSE_MOVE；
 * - 渲染器层（Buffer / VertexArray / DrawCommand / ShaderProgram / RenderState）提供计数用的
 *   桩对象，使 instanced.update(frameState) 可以在 Node 下被真实调用并断言命令下发。
 *
 * 注意：这里刻意**不**校验参数合法性（真实 Cesium 会抛 DeveloperError），
 * 因为本包的可测性目标之一是「非法入参不炸」，替身若也抛错就测不出这条。
 */

import { vi } from 'vitest';

/** 解析 #RGB / #RRGGBB / #RRGGBBAA 形式的颜色串，失败返回 undefined。 */
function parseHexColor(input) {
  if (typeof input !== 'string') return undefined;
  let hex = input.trim();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (![3, 4, 6, 8].includes(hex.length)) return undefined;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  const expand = (s) => parseInt(s.length === 1 ? s + s : s, 16) / 255;
  if (hex.length === 3 || hex.length === 4) {
    const alpha = hex.length === 4 ? expand(hex[3]) : 1;
    return [expand(hex[0]), expand(hex[1]), expand(hex[2]), alpha];
  }
  const alpha = hex.length === 8 ? expand(hex[6] + hex[7]) : 1;
  return [expand(hex[0] + hex[1]), expand(hex[2] + hex[3]), expand(hex[4] + hex[5]), alpha];
}

/**
 * 创建一套 Cesium 测试替身。
 *
 * @returns {object} 形如 Cesium 模块命名空间的替身对象
 */
export function createCesiumMock() {
  class Color {
    constructor(red = 1, green = 1, blue = 1, alpha = 1) {
      this.red = red;
      this.green = green;
      this.blue = blue;
      this.alpha = alpha;
    }

    clone() {
      return new Color(this.red, this.green, this.blue, this.alpha);
    }

    withAlpha(alpha) {
      return new Color(this.red, this.green, this.blue, alpha);
    }

    static fromCssColorString(value) {
      const rgba = parseHexColor(value);
      if (!rgba) return undefined;
      return new Color(rgba[0], rgba[1], rgba[2], rgba[3]);
    }

    static fromBytes(r, g, b, a = 255) {
      return new Color(r / 255, g / 255, b / 255, a / 255);
    }
  }

  class Cartesian3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    static fromDegrees(lon, lat, height = 0) {
      const c = new Cartesian3(0, 0, height);
      c._lon = lon;
      c._lat = lat;
      c._height = height;
      return c;
    }

    static distance(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }
  }

  class Cartographic {
    constructor(longitude, latitude, height = 0) {
      this.longitude = longitude;
      this.latitude = latitude;
      this.height = height;
    }

    static fromCartesian(cartesian) {
      if (!cartesian || cartesian._lon === undefined) return undefined;
      return new Cartographic(
        (cartesian._lon * Math.PI) / 180,
        (cartesian._lat * Math.PI) / 180,
        cartesian._height || 0,
      );
    }
  }

  class Matrix4 extends Float64Array {
    constructor() {
      super(16);
    }

    static fromArray(array, offset = 0, result) {
      const out = result instanceof Matrix4 ? result : new Matrix4();
      for (let i = 0; i < 16; i += 1) out[i] = array[offset + i] ?? 0;
      return out;
    }

    static toArray(matrix, result) {
      const out = Array.isArray(result) ? result : new Array(16);
      for (let i = 0; i < 16; i += 1) out[i] = matrix[i] ?? 0;
      return out;
    }

    /** 极简 ENU→ECEF：单位正交基 + 原点放在第 3 列（与 Cesium 列主序约定一致）。 */
    static eastNorthUpToFixedFrame(origin) {
      const m = new Matrix4();
      m[0] = 1;
      m[5] = 1;
      m[10] = 1;
      m[15] = 1;
      m[12] = origin.x;
      m[13] = origin.y;
      m[14] = origin.z;
      return m;
    }
  }

  class BoundingSphere {
    constructor(center, radius) {
      this.center = center;
      this.radius = radius;
    }
  }

  class GeometryInstance {
    constructor(options = {}) {
      this.id = options.id;
      this.geometry = options.geometry;
      this.modelMatrix = options.modelMatrix;
      this.attributes = options.attributes;
    }
  }

  class PerInstanceColorAppearance {
    constructor(options = {}) {
      Object.assign(this, options);
    }
  }
  PerInstanceColorAppearance.VERTEX_FORMAT = { position: true, normal: true };

  class BoxGeometry {
    constructor(options = {}) {
      Object.assign(this, options);
    }

    static fromDimensions(options) {
      return new BoxGeometry(options);
    }

    static createGeometry() {
      const vertexCount = 24;
      return {
        attributes: {
          position: { values: new Float64Array(vertexCount * 3) },
          st: { values: new Float64Array(vertexCount * 2) },
        },
        indices: new Uint16Array(36),
      };
    }
  }

  class BoxOutlineGeometry {
    constructor(options = {}) {
      Object.assign(this, options);
    }

    static fromDimensions(options) {
      return new BoxOutlineGeometry(options);
    }
  }

  class Primitive {
    constructor(options = {}) {
      Object.assign(this, options);
      /** 与真实 Cesium 一致：首次 update 之前 ready 为 false */
      this.ready = false;
      this.destroyed = false;
      this._batchTable = new Map();
    }

    isDestroyed() {
      return this.destroyed;
    }

    getGeometryInstanceAttributes(id) {
      if (!this._batchTable.has(id)) this._batchTable.set(id, { color: null });
      return this._batchTable.get(id);
    }

    /** 测试用：把批次标记为已就绪（等价于场景渲染过一次） */
    markReady() {
      this.ready = true;
      return this;
    }
  }

  class PrimitiveCollection {
    constructor() {
      this._items = [];
      this.show = true;
      this.destroyed = false;
    }

    get length() {
      return this._items.length;
    }

    add(item) {
      this._items.push(item);
      return item;
    }

    remove(item) {
      const i = this._items.indexOf(item);
      if (i < 0) return false;
      this._items.splice(i, 1);
      return true;
    }

    contains(item) {
      return this._items.includes(item);
    }

    get(index) {
      return this._items[index];
    }

    removeAll() {
      this._items.length = 0;
    }

    isDestroyed() {
      return this.destroyed;
    }
  }

  class ScreenSpaceEventHandler {
    constructor(element) {
      this.element = element;
      this._actions = new Map();
      this.destroyed = false;
    }

    setInputAction(action, type) {
      this._actions.set(type, action);
    }

    removeInputAction(type) {
      this._actions.delete(type);
    }

    getInputAction(type) {
      return this._actions.get(type);
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      this.destroyed = true;
      this._actions.clear();
    }

    /** 测试用：主动触发已注册的输入动作 */
    trigger(type, event) {
      const action = this._actions.get(type);
      if (!action) throw new Error(`未注册的输入动作: ${type}`);
      return action(event);
    }
  }

  class VertexArray {
    constructor(options = {}) {
      Object.assign(this, options);
      this.destroyed = false;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  class DrawCommand {
    constructor(options = {}) {
      Object.assign(this, options);
    }
  }

  class BufferStub {
    constructor(options = {}) {
      Object.assign(this, options);
      this.copyFromArrayView = vi.fn();
      this.destroy = vi.fn();
      this.vertexArrayDestroyable = true;
    }
  }

  return {
    Color,
    Cartesian3,
    Cartographic,
    Matrix4,
    BoundingSphere,
    GeometryInstance,
    PerInstanceColorAppearance,
    BoxGeometry,
    BoxOutlineGeometry,
    Primitive,
    PrimitiveCollection,
    ScreenSpaceEventHandler,
    VertexArray,
    DrawCommand,
    Buffer: {
      createVertexBuffer: (options) => new BufferStub(options),
      createIndexBuffer: (options) => new BufferStub(options),
    },
    BufferUsage: { STATIC_DRAW: 'STATIC_DRAW', DYNAMIC_DRAW: 'DYNAMIC_DRAW' },
    IndexDatatype: { UNSIGNED_SHORT: 'UNSIGNED_SHORT' },
    BlendingState: { ALPHA_BLEND: 'ALPHA_BLEND' },
    CullFace: { BACK: 'BACK' },
    Pass: { TRANSLUCENT: 'TRANSLUCENT' },
    PrimitiveType: { TRIANGLES: 'TRIANGLES' },
    ComponentDatatype: {
      FLOAT: 'FLOAT',
      UNSIGNED_BYTE: 'UNSIGNED_BYTE',
      createTypedArray: (type, values) => new Float32Array(values),
    },
    Geometry: {
      computeNumberOfVertices: (geometry) => geometry.attributes.position.values.length / 3,
    },
    VertexFormat: { POSITION_AND_ST: { st: true }, POSITION_AND_NORMAL: { normal: true } },
    ScreenSpaceEventType: { LEFT_CLICK: 1, MOUSE_MOVE: 2 },
    Transforms: {
      eastNorthUpToFixedFrame: (origin) => Matrix4.eastNorthUpToFixedFrame(origin),
    },
    ColorGeometryInstanceAttribute: {
      fromColor: (color) => ({ color }),
      toValue: (color) => [color.red, color.green, color.blue, color.alpha],
    },
    ShaderProgram: {
      fromCache: (options) => ({ options, destroy: vi.fn() }),
    },
    RenderState: {
      fromCache: (options) => options,
    },
    Math: {
      toDegrees: (radians) => (radians * 180) / Math.PI,
      toRadians: (degrees) => (degrees * Math.PI) / 180,
    },
  };
}
