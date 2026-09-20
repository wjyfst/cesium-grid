/**
 * @Description: 独立立体网格的真实例化渲染层（默认渲染方案）。
 *   一份单位盒几何被所有格共享，每格只上传一个 3×4 变换矩阵（48 B）与一个 RGBA8 颜色（4 B），
 *   逐格变换在顶点着色器里完成。相比「每格烘焙一份完整几何」的 Primitive 方案：
 *   每格显存 1440 B → 52 B，draw call 由「每批 2 个」→「每块 1 个」，
 *   且不再有 createGeometry / combineGeometry 的异步几何构建，写入下一帧即可见。
 *
 *   设计约束（均对着 @cesium/engine 1.143 源码核实，改代码前请先读）：
 *   - 顶点数组的逐实例属性必须自带 vertexBuffer 并显式给 instanceDivisor：
 *     VertexArray.fromGeometry 的 values 分支不透传 instanceDivisor（Renderer/VertexArray.js:638-682），
 *     故此处直接 new VertexArray，逐实例缓冲自持引用以便增量 copyFromArrayView。
 *   - attribute index 0 不能有 instanceDivisor > 0（Renderer/VertexArray.js:83-91），
 *     故 position 占 0，实例属性从 2 起。
 *   - strideInBytes 不得超过 255（Renderer/VertexArray.js:59-64），矩阵 stride 为 48。
 *   - 共享顶点/索引缓冲必须置 vertexArrayDestroyable = false（Renderer/VertexArray.js:922-934）：
 *     VertexArray.destroy() 会连带销毁它引用的缓冲，而 Buffer.isDestroyed() 恒返回 false
 *     （Renderer/Buffer.js:444-446），无法靠「先销毁缓冲」规避二次销毁。
 *   - DrawCommand.boundingVolume 必须给世界坐标（Scene.js:2073-2083 不乘 modelMatrix），
 *     大平移交给 float64 的 modelMatrix，实例矩阵只放网格中心 ENU 局部量，float32 精度足够。
 *   - 拾取靠 command.pickId 自动派生（Scene.js:1765）：pickId 是 GLSL 表达式字符串，
 *     配合 uniform vec4 czm_pickColor 使用（同 TimeDynamicPointCloud.js:242-258）。
 *
 *   注意：本模块直接使用 Cesium 的渲染器层 API（Buffer / VertexArray / DrawCommand /
 *   ShaderProgram / RenderState / Context.createPickId），这些是 Cesium 内部接口，
 *   官方不保证跨大版本兼容，因此 peerDependencies 锁定了 cesium 的主版本区间。
 */

import * as Cesium from 'cesium';
import { enuFrameFromMatrix, writeCellInstanceMatrix } from './gridMath.js';

/** 每格实例矩阵的 float 数（3×vec4，第 4 行隐含 (0,0,0,1)） */
const MATRIX_FLOATS = 12;
/** 每格实例矩阵的字节数 */
const MATRIX_STRIDE = MATRIX_FLOATS * 4;
/** 每格实例颜色的字节数（RGBA8） */
const COLOR_STRIDE = 4;

/**
 * 顶点属性槽位。position 必须占 0（instanceDivisor > 0 的属性不能是 0 号），
 * 实例属性从 2 起；同一份表同时喂给 VertexArray 与 ShaderProgram.attributeLocations，
 * 两者不一致会导致着色器取到错误的属性。
 */
const ATTRIBUTE_LOCATIONS = {
  position: 0,
  st: 1,
  a_instanceRow0: 2,
  a_instanceRow1: 3,
  a_instanceRow2: 4,
  a_instanceColor: 5,
};

/** 块的默认边长（格数） */
const DEFAULT_CHUNK_SIZE = 128;
/** 块边长下限：再小则 draw call 与 PickId 数量失控 */
const MIN_CHUNK_SIZE = 8;
/** 块边长上限：容量需装进 handle 的整数编码，且单块缓冲不宜超过约 4 MB */
const MAX_CHUNK_SIZE = 1024;

/**
 * 顶点着色器：按官方 3D Tiles 实例化布局把 3×4 矩阵拼成 mat4，再乘单位盒顶点。
 *
 * 与 Shaders/Model/InstancingStageCommon.glsl 的 getInstancingTransform 逐字同构：
 * mat4(...) 是列主序，四列分别取 row0/row1/row2 的同名分量，第 4 行隐含 (0,0,0,1)。
 * 大平移由 czm_modelViewProjection 里的 modelMatrix（float64）承担，此处只做局部变换。
 */
const VERTEX_SHADER = `in vec3 position;
in vec2 st;
in vec4 a_instanceRow0;
in vec4 a_instanceRow1;
in vec4 a_instanceRow2;
in vec4 a_instanceColor;

out vec2 v_st;
out vec4 v_color;

void main()
{
    mat4 instanceTransform = mat4(
        a_instanceRow0.x, a_instanceRow1.x, a_instanceRow2.x, 0.0,
        a_instanceRow0.y, a_instanceRow1.y, a_instanceRow2.y, 0.0,
        a_instanceRow0.z, a_instanceRow1.z, a_instanceRow2.z, 0.0,
        a_instanceRow0.w, a_instanceRow1.w, a_instanceRow2.w, 1.0
    );

    v_st = st;
    v_color = a_instanceColor;

    gl_Position = czm_modelViewProjection * (instanceTransform * vec4(position, 1.0));
}
`;

/**
 * 生成片元着色器：按盒面 st 参数化描边 + 声明拾取色 uniform。
 *
 * st 是 BoxGeometry 给每个面的 [0,1]² 参数化（Core/BoxGeometry.js:455），
 * min(st, 1-st) 即到该面四边的归一化距离；线宽必须用 fwidth 换算成像素级，
 * 否则同一归一化宽度在顶面（≈格边长²）与侧面（格边长×柱高）上的物理宽度会差几十倍。
 *
 * czm_pickColor 在常规绘制里未被引用、会被编译器裁掉，仅在 Cesium 派生出的拾取着色器
 * 里被 out_FragColor 读取；这是官方 TimeDynamicPointCloud 的同款写法。
 *
 * @param {number} edgeAlpha - 描边透明度（0~1）
 * @param {number} edgeWidthPx - 描边线宽，单位：像素
 * @returns {string} 片元着色器源码
 */
function buildFragmentShader(edgeAlpha, edgeWidthPx) {
  return `uniform vec4 czm_pickColor;

in vec2 v_st;
in vec4 v_color;

void main()
{
    vec4 fill = v_color;
    vec2 edgeDist = min(v_st, 1.0 - v_st);
    vec2 w = max(fwidth(v_st) * ${edgeWidthPx.toFixed(3)}, vec2(1e-6));
    float line = 1.0 - min(smoothstep(vec2(0.0), w, edgeDist).x,
                           smoothstep(vec2(0.0), w, edgeDist).y);
    out_FragColor = mix(fill, vec4(fill.rgb, ${edgeAlpha.toFixed(4)}), line);
}
`;
}

/**
 * 单位盒的 CPU 侧几何数据（模块级缓存，与 WebGL 上下文无关，所有图层共用）。
 * @type {{position:Float32Array, st:Float32Array, indices:Uint16Array, vertexCount:number, indexCount:number}|null}
 */
let boxDataCache = null;

/**
 * 取单位盒的顶点/索引数据，首次调用时从 BoxGeometry 生成并转成 float32。
 *
 * BoxGeometry.createGeometry 产出的 position 是 Float64Array，WebGL 不接受，
 * 必须用 ComponentDatatype.createTypedArray 转成 Float32Array。
 *
 * @returns {{position:Float32Array, st:Float32Array, indices:Uint16Array, vertexCount:number, indexCount:number}|null} 几何数据；生成失败时为 null
 */
function getBoxData() {
  if (boxDataCache) return boxDataCache;
  const geometry = Cesium.BoxGeometry.createGeometry(
    Cesium.BoxGeometry.fromDimensions({
      dimensions: new Cesium.Cartesian3(1, 1, 1),
      vertexFormat: Cesium.VertexFormat.POSITION_AND_ST,
    }),
  );
  if (!geometry || !geometry.attributes.position || !geometry.attributes.st) return null;
  boxDataCache = {
    position: Cesium.ComponentDatatype.createTypedArray(
      Cesium.ComponentDatatype.FLOAT,
      geometry.attributes.position.values,
    ),
    st: Cesium.ComponentDatatype.createTypedArray(
      Cesium.ComponentDatatype.FLOAT,
      geometry.attributes.st.values,
    ),
    indices: geometry.indices,
    vertexCount: Cesium.Geometry.computeNumberOfVertices(geometry),
    indexCount: geometry.indices.length,
  };
  return boxDataCache;
}

/**
 * 把颜色规整成 RGBA8 四元组。
 *
 * @param {import('cesium').Color|null|undefined} color - 目标颜色；无效时返回全 0（完全透明）
 * @returns {Uint8Array} 长度为 4 的字节数组 [r,g,b,a]，取值 0~255
 */
function colorToBytes(color) {
  const out = new Uint8Array(COLOR_STRIDE);
  if (!color) return out;
  out[0] = Math.min(255, Math.max(0, Math.round((color.red ?? 0) * 255)));
  out[1] = Math.min(255, Math.max(0, Math.round((color.green ?? 0) * 255)));
  out[2] = Math.min(255, Math.max(0, Math.round((color.blue ?? 0) * 255)));
  out[3] = Math.min(255, Math.max(0, Math.round((color.alpha ?? 1) * 255)));
  return out;
}

/**
 * 创建独立立体网格的例化渲染对象。
 *
 * 返回的对象实现 update(frameState) / destroy() / isDestroyed()，可直接 add 进
 * viewer.scene.primitives；增删格是 O(1) 的缓冲写入，不再创建/销毁任何 Cesium 对象。
 *
 * @param {object} options - 配置
 * @param {{originLon:number, originLat:number, cols:number, rows:number, cellSize:number, bottomHeight:number, gridHeight:number}} options.model - 网格模型参数（按引用持有，setBottomHeight 会就地改 bottomHeight）
 * @param {number} [options.chunkSize=128] - 块边长（格数），同时决定 draw call 数与剔除/排序粒度
 * @param {string} [options.layerType='independentGrid'] - 写入 _layerType 供外部 scene.pick 识别
 * @param {number} [options.edgeAlpha=0.15] - 盒面描边透明度
 * @param {number} [options.edgeWidthPx=1.2] - 盒面描边线宽（像素）
 * @param {number} [options.heightChunksPerFrame=4] - 高度回流时每帧重写的块数（限流，避免 O(n) 阻塞主线程）
 * @returns {{update:Function, destroy:Function, isDestroyed:Function, writePackedCells:Function, setCellColor:Function, setAllFillColor:Function, setBottomHeight:Function, getStats:Function}} 例化渲染对象
 */
export function createInstancedGridPrimitive(options = {}) {
  const model = options.model;
  const chunkSize = Math.max(
    MIN_CHUNK_SIZE,
    Math.min(MAX_CHUNK_SIZE, Math.floor(options.chunkSize || DEFAULT_CHUNK_SIZE)),
  );
  const layerType = options.layerType || 'independentGrid';
  const edgeAlpha = Number.isFinite(options.edgeAlpha) ? options.edgeAlpha : 0.15;
  const edgeWidthPx = Number.isFinite(options.edgeWidthPx) ? options.edgeWidthPx : 1.2;
  const heightChunksPerFrame = Math.max(1, Math.floor(options.heightChunksPerFrame || 4));

  /** 网格中心 ENU 标架：原点取椭球面（高度 0），使标架与 bottomHeight 解耦、终生不变 */
  const centerLon = model.originLon + (model.cols * model.cellSize) / 2;
  const centerLat = model.originLat + (model.rows * model.cellSize) / 2;
  const originMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 0),
  );
  const originFrame = enuFrameFromMatrix(Cesium.Matrix4.toArray(originMatrix));

  /** 块列数 / 行数（末列末行可能不满） */
  const chunkCols = Math.ceil(model.cols / chunkSize);
  const chunkRows = Math.ceil(model.rows / chunkSize);
  /** handle 编码步长：handle = chunkIndex * handleStride + slot */
  const handleStride = chunkSize * chunkSize;

  /** @type {Array<object>} 全部块，按 [chunkRow][chunkCol] 展开为一维 */
  const chunks = [];
  /** @type {Array<Array<object>>} chunkCol/chunkRow → 块，供按格定位 */
  const chunkGrid = [];
  for (let cr = 0; cr < chunkRows; cr += 1) {
    const line = [];
    for (let cc = 0; cc < chunkCols; cc += 1) {
      const col0 = cc * chunkSize;
      const row0 = cr * chunkSize;
      const cols = Math.min(chunkSize, model.cols - col0);
      const rows = Math.min(chunkSize, model.rows - row0);
      const capacity = cols * rows;
      const chunk = {
        index: chunks.length,
        col0,
        row0,
        cols,
        rows,
        capacity,
        written: 0,
        /**
         * 以下三个 CPU 侧缓冲**延迟到本块首次写入时分配**（ensureChunkBuffers）：
         * 按满容量预分配会让 1 亿格在构造时就吃掉约 5.6 GB CPU 内存，
         * 而方环填充是渐进推进的，未触及的块不该付费。
         */
        /** 本块内 dense slot → 局部下标 + 1（0 表示未写入），用于去重与高度回流反查 */
        localSlot: null,
        /** 逐格 3×4 矩阵（行主序，12 float/格） */
        matrices: null,
        /** 逐格 RGBA8 颜色 */
        colors: null,
        matrixFrom: 0,
        matrixTo: 0,
        colorFrom: 0,
        colorTo: 0,
        needsGpu: false,
        heightDirty: false,
        matrixBuffer: null,
        colorBuffer: null,
        vertexArray: null,
        command: null,
        boundingSphere: null,
      };
      chunks.push(chunk);
      line.push(chunk);
    }
    chunkGrid.push(line);
  }

  let destroyed = false;
  let show = true;
  /** 首次 update 时建好的 GPU 资源 */
  let gpu = null;
  /** 高度回流游标：从上次中断的块继续 */
  let heightCursor = 0;

  const stats = {
    chunks: chunks.length,
    chunkSize,
    /** 逻辑容量（cols × rows），不等于已分配量 */
    capacity: chunks.reduce((sum, chunk) => sum + chunk.capacity, 0),
    /** 每格实例数据字节数（3×vec4 矩阵 + RGBA8 颜色） */
    bytesPerInstance: MATRIX_STRIDE + COLOR_STRIDE,
    /** 已分配 CPU 侧缓冲的块数（按需分配，随填充推进增长） */
    allocatedChunks: 0,
    /** 已分配的 CPU 侧缓冲字节数（矩阵 + 颜色 + 槽位索引） */
    allocatedBytes: 0,
    writtenCells: 0,
    matrixBytes: 0,
    colorBytes: 0,
    heightRewriteFrames: 0,
    uploadBytes: 0,
  };

  /**
   * 计算块的世界坐标包围球（ECEF）。
   *
   * DrawCommand.boundingVolume 必须给世界坐标——Scene 的可见性判定直接拿它做视锥/遮挡测试，
   * 不会乘 modelMatrix，所以这里要把经纬度角点换算到 ECEF。
   *
   * @param {object} chunk - 目标块
   * @returns {import('cesium').BoundingSphere} 覆盖该块全部格（含底面与顶面）的包围球
   */
  function computeBoundingSphere(chunk) {
    const west = model.originLon + chunk.col0 * model.cellSize;
    const east = model.originLon + (chunk.col0 + chunk.cols) * model.cellSize;
    const south = model.originLat + chunk.row0 * model.cellSize;
    const north = model.originLat + (chunk.row0 + chunk.rows) * model.cellSize;
    const top = model.bottomHeight + model.gridHeight;
    const center = Cesium.Cartesian3.fromDegrees(
      (west + east) / 2,
      (south + north) / 2,
      model.bottomHeight + model.gridHeight / 2,
    );
    let radius = 0;
    const lons = [west, east];
    const lats = [south, north];
    const heights = [model.bottomHeight, top];
    for (let i = 0; i < lons.length; i += 1) {
      for (let j = 0; j < lats.length; j += 1) {
        for (let k = 0; k < heights.length; k += 1) {
          const corner = Cesium.Cartesian3.fromDegrees(lons[i], lats[j], heights[k]);
          radius = Math.max(radius, Cesium.Cartesian3.distance(center, corner));
        }
      }
    }
    return new Cesium.BoundingSphere(center, radius);
  }

  /**
   * 创建所有块共用的 GPU 资源：单位盒顶点/索引缓冲、着色器程序、渲染状态、拾取 id。
   *
   * 共享缓冲必须置 vertexArrayDestroyable = false：VertexArray.destroy() 会连带销毁它引用的
   * 缓冲（Renderer/VertexArray.js:922-934），而 Buffer.isDestroyed() 恒为 false，无法二次保护。
   *
   * @param {import('cesium').Context} context - 渲染上下文，取自 frameState.context
   * @returns {boolean} true = 资源就绪；false = 单位盒几何生成失败，本帧不渲染
   */
  function ensureSharedGpu(context) {
    if (gpu) return true;
    const box = getBoxData();
    if (!box) {
      console.error('[cesium-grid] 单位盒几何生成失败，例化图层无法渲染');
      return false;
    }

    const positionBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: box.position,
      usage: Cesium.BufferUsage.STATIC_DRAW,
    });
    const stBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: box.st,
      usage: Cesium.BufferUsage.STATIC_DRAW,
    });
    const indexBuffer = Cesium.Buffer.createIndexBuffer({
      context,
      typedArray: box.indices,
      usage: Cesium.BufferUsage.STATIC_DRAW,
      indexDatatype: Cesium.IndexDatatype.UNSIGNED_SHORT,
    });
    // 共享缓冲禁止被 VertexArray.destroy() 连带销毁（多块共用同一份）
    positionBuffer.vertexArrayDestroyable = false;
    stBuffer.vertexArrayDestroyable = false;
    indexBuffer.vertexArrayDestroyable = false;

    const shaderProgram = Cesium.ShaderProgram.fromCache({
      context,
      vertexShaderSource: VERTEX_SHADER,
      fragmentShaderSource: buildFragmentShader(edgeAlpha, edgeWidthPx),
      attributeLocations: ATTRIBUTE_LOCATIONS,
    });

    const renderState = Cesium.RenderState.fromCache({
      depthTest: { enabled: true },
      depthMask: false,
      blending: Cesium.BlendingState.ALPHA_BLEND,
      cull: { enabled: true, face: Cesium.CullFace.BACK },
    });

    // 图层级拾取 id：外部只判 primitive._layerType，故整层共用一个即可。
    // pickId 是 GLSL 表达式字符串，由 Cesium 派生拾取着色器时内联（DerivedCommand.js:267-274），
    // 这里配合片元着色器里的 uniform vec4 czm_pickColor 使用。
    const pickId = context.createPickId({ primitive: self });
    gpu = {
      box,
      positionBuffer,
      stBuffer,
      indexBuffer,
      shaderProgram,
      renderState,
      pickId,
      uniformMap: { czm_pickColor: () => pickId.color },
    };
    return true;
  }

  /**
   * 创建单个块的 GPU 资源：实例矩阵/颜色缓冲、顶点数组、绘制命令。
   *
   * @param {object} chunk - 目标块
   * @param {import('cesium').Context} context - 渲染上下文
   * @returns {boolean} true = 就绪
   */
  function ensureChunkGpu(chunk, context) {
    if (chunk.vertexArray) {
      // needsGpu 是「本块有数据待渲染」的标记，会在每次写入时重新置位；
      // 资源已建时必须一并清掉，否则每帧都会为已建好的块白跑一次本函数。
      chunk.needsGpu = false;
      return true;
    }
    if (!gpu) return false;

    // 只按容量分配、不上传初始数据：实例缓冲靠后续增量 copyFromArrayView 填充
    chunk.matrixBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      sizeInBytes: chunk.capacity * MATRIX_STRIDE,
      usage: Cesium.BufferUsage.DYNAMIC_DRAW,
    });
    chunk.colorBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      sizeInBytes: chunk.capacity * COLOR_STRIDE,
      usage: Cesium.BufferUsage.DYNAMIC_DRAW,
    });
    // 缓冲所有权归本模块：VertexArray.destroy() 会连带销毁它引用的缓冲
    // （Renderer/VertexArray.js:922-939），而 Buffer.isDestroyed() 恒为 false
    // （Renderer/Buffer.js:444-446），一旦被连带销毁，后续显式 destroy 会二次释放报错。
    chunk.matrixBuffer.vertexArrayDestroyable = false;
    chunk.colorBuffer.vertexArrayDestroyable = false;

    chunk.vertexArray = new Cesium.VertexArray({
      context,
      indexBuffer: gpu.indexBuffer,
      attributes: [
        {
          index: ATTRIBUTE_LOCATIONS.position,
          vertexBuffer: gpu.positionBuffer,
          componentsPerAttribute: 3,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 0,
          strideInBytes: 0,
          instanceDivisor: 0,
        },
        {
          index: ATTRIBUTE_LOCATIONS.st,
          vertexBuffer: gpu.stBuffer,
          componentsPerAttribute: 2,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 0,
          strideInBytes: 0,
          instanceDivisor: 0,
        },
        // 3×4 矩阵按行拆成三个 vec4，共用一条 stride 48 的缓冲
        {
          index: ATTRIBUTE_LOCATIONS.a_instanceRow0,
          vertexBuffer: chunk.matrixBuffer,
          componentsPerAttribute: 4,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 0,
          strideInBytes: MATRIX_STRIDE,
          instanceDivisor: 1,
        },
        {
          index: ATTRIBUTE_LOCATIONS.a_instanceRow1,
          vertexBuffer: chunk.matrixBuffer,
          componentsPerAttribute: 4,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 16,
          strideInBytes: MATRIX_STRIDE,
          instanceDivisor: 1,
        },
        {
          index: ATTRIBUTE_LOCATIONS.a_instanceRow2,
          vertexBuffer: chunk.matrixBuffer,
          componentsPerAttribute: 4,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          normalize: false,
          offsetInBytes: 32,
          strideInBytes: MATRIX_STRIDE,
          instanceDivisor: 1,
        },
        {
          index: ATTRIBUTE_LOCATIONS.a_instanceColor,
          vertexBuffer: chunk.colorBuffer,
          componentsPerAttribute: 4,
          componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
          normalize: true,
          offsetInBytes: 0,
          strideInBytes: 0,
          instanceDivisor: 1,
        },
      ],
    });

    chunk.boundingSphere = computeBoundingSphere(chunk);
    chunk.command = new Cesium.DrawCommand({
      boundingVolume: chunk.boundingSphere,
      modelMatrix: originMatrix,
      vertexArray: chunk.vertexArray,
      shaderProgram: gpu.shaderProgram,
      renderState: gpu.renderState,
      uniformMap: gpu.uniformMap,
      pass: Cesium.Pass.TRANSLUCENT,
      count: gpu.box.indexCount,
      instanceCount: 0,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      owner: self,
      pickId: 'czm_pickColor',
      cull: true,
      occlude: true,
    });
    chunk.needsGpu = false;
    return true;
  }

  /**
   * 把 CPU 侧的脏区间推到 GPU。矩阵与颜色的脏区间各自独立合并。
   *
   * @param {object} chunk - 目标块
   * @returns {void}
   */
  function flushChunk(chunk) {
    if (chunk.matrixTo > chunk.matrixFrom) {
      const from = chunk.matrixFrom;
      const to = chunk.matrixTo;
      chunk.matrixBuffer.copyFromArrayView(
        chunk.matrices.subarray(from * MATRIX_FLOATS, to * MATRIX_FLOATS),
        from * MATRIX_STRIDE,
      );
      stats.uploadBytes += (to - from) * MATRIX_STRIDE;
      chunk.matrixFrom = 0;
      chunk.matrixTo = 0;
    }
    if (chunk.colorTo > chunk.colorFrom) {
      const from = chunk.colorFrom;
      const to = chunk.colorTo;
      chunk.colorBuffer.copyFromArrayView(
        chunk.colors.subarray(from * COLOR_STRIDE, to * COLOR_STRIDE),
        from * COLOR_STRIDE,
      );
      stats.uploadBytes += (to - from) * COLOR_STRIDE;
      chunk.colorFrom = 0;
      chunk.colorTo = 0;
    }
  }

  /**
   * 合并标记矩阵脏区间。
   *
   * @param {object} chunk - 目标块
   * @param {number} from - 起始实例下标（含）
   * @param {number} to - 结束实例下标（不含）
   * @returns {void}
   */
  function markMatrixDirty(chunk, from, to) {
    if (chunk.matrixTo <= chunk.matrixFrom) {
      chunk.matrixFrom = from;
      chunk.matrixTo = to;
      return;
    }
    if (from < chunk.matrixFrom) chunk.matrixFrom = from;
    if (to > chunk.matrixTo) chunk.matrixTo = to;
  }

  /**
   * 合并标记颜色脏区间。
   *
   * @param {object} chunk - 目标块
   * @param {number} from - 起始实例下标（含）
   * @param {number} to - 结束实例下标（不含）
   * @returns {void}
   */
  function markColorDirty(chunk, from, to) {
    if (chunk.colorTo <= chunk.colorFrom) {
      chunk.colorFrom = from;
      chunk.colorTo = to;
      return;
    }
    if (from < chunk.colorFrom) chunk.colorFrom = from;
    if (to > chunk.colorTo) chunk.colorTo = to;
  }

  /**
   * 确保块的 CPU 侧缓冲已分配（首次写入该块时调用）。
   *
   * @param {object} chunk - 目标块
   * @returns {void}
   */
  function ensureChunkBuffers(chunk) {
    if (chunk.matrices) return;
    chunk.localSlot = new Int32Array(chunk.capacity);
    chunk.matrices = new Float32Array(chunk.capacity * MATRIX_FLOATS);
    chunk.colors = new Uint8Array(chunk.capacity * COLOR_STRIDE);
    stats.allocatedChunks += 1;
    stats.allocatedBytes += chunk.capacity * (MATRIX_STRIDE + COLOR_STRIDE + 4);
  }

  /**
   * 在块内为指定局部坐标分配一个 dense slot。
   *
   * 格按方环顺序到达，与块内网格位置无关，故需要 localSlot 做「局部下标 → dense slot」映射：
   * instanceCount 只能绘制 [0, written) 的连续前缀，稀疏槽位无法直接渲染。
   *
   * @param {object} chunk - 目标块
   * @param {number} dc - 块内列偏移（0 起）
   * @param {number} dr - 块内行偏移（0 起）
   * @returns {number} dense slot；已存在则返回原 slot，容量已满返回 -1
   */
  function allocateSlot(chunk, dc, dr) {
    ensureChunkBuffers(chunk);
    const li = dr * chunk.cols + dc;
    const existing = chunk.localSlot[li];
    if (existing) return existing - 1;
    if (chunk.written >= chunk.capacity) return -1;
    const slot = chunk.written;
    chunk.written += 1;
    chunk.localSlot[li] = slot + 1;
    return slot;
  }

  /**
   * 写入一格的颜色字节。
   *
   * @param {object} chunk - 目标块
   * @param {number} slot - dense slot
   * @param {Uint8Array} bytes - RGBA8 四元组
   * @returns {void}
   */
  function writeColorAt(chunk, slot, bytes) {
    const o = slot * COLOR_STRIDE;
    chunk.colors[o] = bytes[0];
    chunk.colors[o + 1] = bytes[1];
    chunk.colors[o + 2] = bytes[2];
    chunk.colors[o + 3] = bytes[3];
  }

  /**
   * 批量写入格：算实例矩阵、取色、分配槽位，全部落到 CPU 侧缓冲并标记脏区间。
   *
   * 本函数不碰 GPU，也不创建任何 Cesium 对象；实际上传在 update(frameState) 里按脏区间做。
   * 取色提供器每格只调用一次，结果同时用于写颜色缓冲与 onCell 回调，调用方无需二次求值。
   *
   * @param {Int32Array} packed - 交错格清单，形如 [col,row,col,row,...]
   * @param {(col:number, row:number) => import('cesium').Color|null} [getColor] - 逐格取色；缺省为全透明
   * @param {(col:number, row:number, handle:number, color:import('cesium').Color|null) => void} [onCell] - 逐格成功写入后的回调，供调用方建内部记录；仅对 handle 有效（≥0）的格触发
   * @returns {Int32Array} 与格清单一一对应的 handle（chunkIndex * handleStride + slot）；越界或容量满为 -1
   */
  function writePackedCells(packed, getColor, onCell) {
    const count = packed.length >> 1;
    const handles = new Int32Array(count);
    handles.fill(-1);
    if (destroyed) return handles;
    let written = 0;
    for (let i = 0, m = 0; i + 1 < packed.length; i += 2, m += 1) {
      const col = packed[i];
      const row = packed[i + 1];
      if (col < 0 || col >= model.cols || row < 0 || row >= model.rows) continue;
      const chunk = chunkGrid[Math.floor(row / chunkSize)][Math.floor(col / chunkSize)];
      const writtenBefore = chunk.written;
      const slot = allocateSlot(chunk, col - chunk.col0, row - chunk.row0);
      if (slot < 0) continue;
      // written 未增长说明命中的是已有槽位（重复格）：颜色照写，但不再计入 writtenCells，
      // 否则 stats.writtenCells 会被重复下发撑大，与「已写入格数」的语义不符。
      const isNewCell = chunk.written > writtenBefore;
      writeCellInstanceMatrix(col, row, model, originFrame, chunk.matrices, slot * MATRIX_FLOATS);
      markMatrixDirty(chunk, slot, slot + 1);
      const color = getColor ? getColor(col, row) : null;
      writeColorAt(chunk, slot, colorToBytes(color));
      markColorDirty(chunk, slot, slot + 1);
      chunk.needsGpu = true;
      const handle = chunk.index * handleStride + slot;
      handles[m] = handle;
      if (isNewCell) written += 1;
      if (onCell) onCell(col, row, handle, color);
    }
    stats.writtenCells += written;
    stats.matrixBytes = stats.writtenCells * MATRIX_STRIDE;
    stats.colorBytes = stats.writtenCells * COLOR_STRIDE;
    return handles;
  }

  /**
   * 改单格颜色（O(1)，只上传 4 字节）。
   *
   * @param {number} handle - writePackedCells 返回的 handle
   * @param {import('cesium').Color} color - 目标颜色
   * @returns {boolean} true = 已受理；false = handle 非法或已释放
   */
  function setCellColor(handle, color) {
    if (destroyed || handle < 0) return false;
    const chunkIndex = Math.floor(handle / handleStride);
    const slot = handle - chunkIndex * handleStride;
    const chunk = chunks[chunkIndex];
    if (!chunk || slot >= chunk.written) return false;
    writeColorAt(chunk, slot, colorToBytes(color));
    markColorDirty(chunk, slot, slot + 1);
    return true;
  }

  /**
   * 改全部已写入格的颜色（O(已写入格数)，但只上传每块一段连续区间）。
   *
   * @param {import('cesium').Color} color - 目标颜色
   * @returns {void}
   */
  function setAllFillColor(color) {
    if (destroyed) return;
    const bytes = colorToBytes(color);
    for (const chunk of chunks) {
      if (!chunk.written) continue;
      for (let slot = 0; slot < chunk.written; slot += 1) writeColorAt(chunk, slot, bytes);
      markColorDirty(chunk, 0, chunk.written);
    }
  }

  /**
   * 重写单个块全部已写入格的实例矩阵（高度回流用）。
   *
   * 遍历 localSlot 反查「slot → 局部下标 → 格坐标」：localSlot 只在写入时置位，
   * 一次 O(容量) 扫描即可覆盖全部已写入格，无需额外维护 slot→(col,row) 的反查表。
   *
   * @param {object} chunk - 目标块
   * @returns {void}
   */
  function rewriteChunkMatrices(chunk) {
    const localSlot = chunk.localSlot;
    for (let li = 0; li < localSlot.length; li += 1) {
      const flag = localSlot[li];
      if (!flag) continue;
      const slot = flag - 1;
      const dr = Math.floor(li / chunk.cols);
      const dc = li - dr * chunk.cols;
      writeCellInstanceMatrix(
        chunk.col0 + dc,
        chunk.row0 + dr,
        model,
        originFrame,
        chunk.matrices,
        slot * MATRIX_FLOATS,
      );
    }
    if (chunk.written) markMatrixDirty(chunk, 0, chunk.written);
    chunk.boundingSphere = computeBoundingSphere(chunk);
    if (chunk.command) chunk.command.boundingVolume = chunk.boundingSphere;
  }

  /**
   * 标记底面高度已变：所有已写入块排队重写矩阵与包围球。
   *
   * 重写是 O(已写入格数)，故不在此同步执行，改由 update 每帧限流处理
   * heightChunksPerFrame 个块，避免 300 万格规模下阻塞主线程数秒。
   *
   * @returns {void}
   */
  function setBottomHeight() {
    if (destroyed) return;
    for (const chunk of chunks) {
      if (chunk.written) chunk.heightDirty = true;
    }
  }

  /**
   * 每帧限流处理高度回流队列。
   *
   * 用 scanned 上限约束扫描范围：游标回绕后必须能在扫满一圈时退出，
   * 否则「本帧处理的块数」递减但游标一直绕圈，会变成死循环。
   *
   * @returns {void}
   */
  function processHeightQueue() {
    let budget = heightChunksPerFrame;
    let scanned = 0;
    let processed = 0;
    while (budget > 0 && scanned < chunks.length) {
      if (heightCursor >= chunks.length) heightCursor = 0;
      const chunk = chunks[heightCursor];
      heightCursor += 1;
      scanned += 1;
      if (!chunk.heightDirty) continue;
      chunk.heightDirty = false;
      rewriteChunkMatrices(chunk);
      budget -= 1;
      processed += 1;
    }
    if (processed) stats.heightRewriteFrames += 1;
  }

  const self = {
    /** 图层类型标记，供外部 scene.pick(...).primitive._layerType 识别 */
    _layerType: layerType,

    /**
     * 每帧回调：建资源、推脏数据、下发绘制命令。
     *
     * @param {import('cesium').FrameState} frameState - Cesium 帧状态
     * @returns {void}
     */
    update(frameState) {
      if (destroyed || !show) return;
      if (!ensureSharedGpu(frameState.context)) return;
      for (const chunk of chunks) {
        if (chunk.needsGpu) ensureChunkGpu(chunk, frameState.context);
      }
      processHeightQueue();
      for (const chunk of chunks) {
        if (!chunk.written || !chunk.command) continue;
        flushChunk(chunk);
        chunk.command.instanceCount = chunk.written;
        frameState.commandList.push(chunk.command);
      }
    },

    /**
     * 释放全部 GPU 资源。幂等。
     *
     * 这里不用 Buffer / VertexArray / ShaderProgram 的 isDestroyed() 做二次保护——它们在
     * Cesium 1.143 里恒返回 false（Renderer/Buffer.js:444、VertexArray.js:918、
     * ShaderProgram.js:606），真正防重复释放的是本模块的 destroyed 标志。
     * 缓冲已全部置 vertexArrayDestroyable = false，因此可安全地在销毁 VertexArray 之后再显式销毁。
     *
     * @returns {void}
     */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const chunk of chunks) {
        if (chunk.vertexArray) chunk.vertexArray.destroy();
        if (chunk.matrixBuffer) chunk.matrixBuffer.destroy();
        if (chunk.colorBuffer) chunk.colorBuffer.destroy();
        chunk.vertexArray = null;
        chunk.matrixBuffer = null;
        chunk.colorBuffer = null;
        chunk.command = null;
      }
      if (gpu) {
        gpu.pickId.destroy();
        gpu.shaderProgram.destroy();
        gpu.positionBuffer.destroy();
        gpu.stBuffer.destroy();
        gpu.indexBuffer.destroy();
        gpu = null;
      }
    },

    /**
     * @returns {boolean} 是否已释放
     */
    isDestroyed() {
      return destroyed;
    },
  };

  Object.defineProperties(self, {
    show: {
      get: () => show,
      set: (value) => {
        show = value;
      },
    },
    instanceCount: {
      get: () => chunks.reduce((sum, chunk) => sum + chunk.written, 0),
    },
  });

  /**
   * @returns {object} 运行期统计快照（块数、已写入格数、缓冲字节、累计上传字节等）
   */
  self.getStats = () => ({ ...stats });

  self.writePackedCells = writePackedCells;
  self.setCellColor = setCellColor;
  self.setAllFillColor = setAllFillColor;
  self.setBottomHeight = setBottomHeight;

  return self;
}
