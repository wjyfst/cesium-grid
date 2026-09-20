/**
 * @Description: 亿级独立立体网格图层（GPU 实例化、从相机中心向外分批填充、已写入常驻）。
 *   逻辑网格 cols×rows（默认 1000×1000 = 100 万格，可按需要开到亿级）。初始取一次相机中心为种子，
 *   按"方环"由中心向外逐层填充（每帧 pumpSize 格，按实测耗时自适应），全部覆盖后停止；
 *   填充过程与相机运动无关（相机只决定起点；refresh() 可手动以当前相机中心重播种）。
 *   已写入场景的格子一直保留（平移/拉远不卸载），仅在图层 dispose 时移除。
 *
 *   实例化约定（Cesium 官方 Sandcastle "Instancing" 同款）：填充 / 框线各一份
 *   BoxGeometry 描述对象（fromDimensions 产物），每格一个 GeometryInstance
 *   （独立 id / 颜色 / modelMatrix），由 Primitive 按实例各自生成几何。
 *   严禁把 createGeometry() 的顶点缓冲产物在多实例间共享——那份缓冲会被按实例
 *   原地变换：同批格错位叠网（"第二层格线"）、scene.pick 只剩最后几个实例。
 *
 *   矩阵计算：每批 (col,row) 清单交给 Worker 打包 modelMatrix（transfer 零拷贝），
 *   主线程保持流水线预取（PREFETCH_BATCHES 个批在途）；Worker 不可用时回退主线程计算。
 *   传输粒度与消费粒度解耦：model.batchSize 是单条消息的格数（只影响通信开销与预取内存），
 *   每帧写入量 pumpSize 由 tunePumpSize 按实测同步耗时自适应（预算 options.pumpBudgetMs）——
 *   每帧格数顶到预算上限，Primitive 数 = 每批 1 个填充（+ 可选 1 个线框）× 总格数 / pumpSize，
 *   每帧格数越大则 Primitive 越少、draw call 越省。
 *   格线方案三选一：edgeShader=true → 自定义 Appearance 在盒面内描边（每批只 1 个 Primitive，
 *   每格 24 顶点）；edgeShader=false + outline=true → 另建线框 Primitive（每批 2 个，每格 48 顶点）；
 *   outline=false → 不画格线。详见 createCellEdgeAppearance 与 buildCellEdgeFragmentShader。
 *   拾取：默认按屏幕坐标反算经纬度直接取格（pickCellByMath，O(1)，无离屏拾取渲染）；
 *   options.mathPick=false 退回 GPU 拾取——scene.pick 快路径 → 未命中再
 *   drillPick(PICK_DRILL_LIMIT) 向下钻，命中判定用 GeometryInstance.id（`${col},${row}#fill|outline`）。
 *   换色：Primitive.getGeometryInstanceAttributes(id)（PerInstanceColorAppearance 批表）。
 *   诊断：stats / logStats() 汇总每帧写入量、addBatch 耗时、Primitive 数、拾取耗时、
 *   未就绪 Primitive 数（后者用于判断异步几何是否拖在填充后面）。
 *   选中态：命中格取本格 baseFillColor 只把 alpha 提到 1（不换色相，保留数据色）；再次点击同格还原预设透明度。
 *   hover 不参与着色（hoverCode 仅供 onMove 去重）：鼠标必停在格上才点得到，若 hover 也换色，
 *   第二次点击的「取消选中」会被 hover 色盖住、还原不回预设透明度。
 *
 *   几何创建：Primitive 走 asynchronous:true（options.asyncGeometry，默认开）——
 *   createGeometry（按实例建盒）与 combineGeometry（modelMatrix 顶点变换 + 合并）
 *   都由 Cesium 内部 Worker 承担（hardwareConcurrency-1 个 TaskProcessor），
 *   顶点变换与合并不再压主线程。
 *   代价与配套：批表要等 Primitive 首次 update（场景渲染）后才建立，ready 之前取
 *   实例属性会抛 DeveloperError；因此未就绪的换色先登记到 deferredColors，由
 *   scene.postRender 在 ready 后补写（Cesium 官方 ready 示例同款）。
 *   新写入格的初始色已随 GeometryInstance.attributes 烘焙进批表，无需再走一次换色，
 *   故 addBatch 内不再无条件 displayFill（原先那一次是纯冗余，还会为该 id 建
 *   accessor 描述符 + 闭包并常驻 _perInstanceAttributeCache）。
 *   置 options.asyncGeometry=false 可退回同步路径做性能对照。
 *
 *   渲染方案二选一（options.instancing，默认 true）：
 *   - true（默认，例化方案，见 instancedGridPrimitive.js）：一份单位盒几何被所有格共享，每格只传
 *     3×4 矩阵（48 B）+ RGBA8 颜色（4 B）= 52 B，逐格变换在顶点着色器完成；按 chunkSize 分块，
 *     每块一个 DrawCommand，增删格是 O(1) 缓冲写入，写入下一帧即渲染，无 ready 概念。
 *     该模式下 addBatch / deferredColors / readyCallbacks / heightQueue / Worker 均不参与，
 *     框线固定走盒面描边（描边色取本格填充色 RGB），故 setCellOutlineColor 只记录不单独存色。
 *   - false（Primitive 方案，需显式 instancing:false）：每格把 modelMatrix 烘焙进顶点，
 *     靠 combineGeometry 生成静态 VBO，每格约 1440 B 显存，每批 2 个 Primitive；
 *     几何构建异步，故有 ready 等待与延迟补写机制。
 *
 *   外部接入（天气网格等逐格数据着色场景）：
 *   options.layerType 标记 _layerType（外部鼠标事件 pick 识别）；
 *   options.getCellColor(col,row) 逐格颜色提供器——颜色文件由调用方读取归一化后
 *   传入，创建期逐格烘焙（首屏即数据色，无「基础色 + 事后换色」双写）；
 *   返回 {fillColor, outlineColor} 可让框线与本格同 RGB、透明度独立（天气网格用）。
 *   高度变化（setBottomHeight）原地重烘焙已写入格：按原批次分组逐帧重算
 *   modelMatrix、建新 Primitive 删旧（PrimitiveCollection 默认 destroyPrimitives=true，
 *   remove 即销毁旧批）；颜色 / hover / 选中状态不受影响，不从中心重新生长。
 */

import * as Cesium from 'cesium';
import { isViewerAlive, onViewerBeforeDestroy } from './viewerLifecycle.js';
import {
  createRingFill,
  independentGridCellCode,
  isValidLngLat,
  packCellsMatrices,
} from './gridMath.js';
import { createInstancedGridPrimitive } from './instancedGridPrimitive.js';
import { createGridWorker } from './workerFactory.js';
import {
  PICK_DRILL_LIMIT,
  PREFETCH_BATCHES,
  normalizeGridOptions,
  toColor,
  toOpaque,
} from './defaults.js';

const FILL_APPEARANCE = new Cesium.PerInstanceColorAppearance({
  flat: true,
  translucent: true,
  closed: true,
});
const OUTLINE_APPEARANCE = new Cesium.PerInstanceColorAppearance({
  flat: true,
  translucent: true,
});

const UNIT_BOX_DIMENSIONS = new Cesium.Cartesian3(1, 1, 1);

/**
 * 构造单位立方体的几何描述对象（1×1×1，以原点为中心）。
 *
 * 返回的是「描述对象」而不是 createGeometry() 的顶点缓冲产物：描述只读，可以被多个
 * GeometryInstance 共享，由 Primitive 按各自 modelMatrix 分别生成几何。
 * fromDimensions 抛错时回退到构造器写法。
 *
 * @param {import('cesium').VertexFormat} vertexFormat - 顶点格式：
 *   POSITION_AND_NORMAL 供逐实例色外观使用（flat 模式下着色器虽不读法线，但保持与官方一致）；
 *   POSITION_AND_ST 供格线外观使用——BoxGeometry 会为 6 个面各生成 [0,1]² 的 st 参数化，
 *   片元着色器据此在盒面内描边，从而省掉独立的线框 Primitive。
 * @returns {import('cesium').BoxGeometry} 单位立方体几何描述
 */
function buildUnitBoxDescription(vertexFormat) {
  try {
    const desc = Cesium.BoxGeometry.fromDimensions({
      dimensions: UNIT_BOX_DIMENSIONS,
      vertexFormat,
    });
    if (desc) return desc;
  } catch (error) {
    console.warn('[cesium-grid] BoxGeometry.fromDimensions 失败，退回构造器', error);
  }
  return new Cesium.BoxGeometry({
    minimum: new Cesium.Cartesian3(-0.5, -0.5, -0.5),
    maximum: new Cesium.Cartesian3(0.5, 0.5, 0.5),
    vertexFormat,
  });
}

/**
 * 构造单位立方体线框的几何描述对象（12 条棱，以原点为中心）。
 *
 * 与 buildUnitBoxDescription 同源同用法：返回可共享的只读描述，配合
 * PerInstanceColorAppearance 逐实例着色；fromDimensions 抛错时回退构造器写法。
 *
 * @returns {import('cesium').BoxOutlineGeometry} 单位立方体线框几何描述
 */
function buildUnitBoxOutlineDescription() {
  try {
    const desc = Cesium.BoxOutlineGeometry.fromDimensions({
      dimensions: UNIT_BOX_DIMENSIONS,
    });
    if (desc) return desc;
  } catch (error) {
    console.warn('[cesium-grid] BoxOutlineGeometry.fromDimensions 失败，退回构造器', error);
  }
  return new Cesium.BoxOutlineGeometry({
    minimum: new Cesium.Cartesian3(-0.5, -0.5, -0.5),
    maximum: new Cesium.Cartesian3(0.5, 0.5, 0.5),
  });
}

// 官方实例化写法：GeometryInstance 收几何描述对象，Primitive 按每实例 modelMatrix 各自生成。
// 多实例共享同一份描述是安全的（描述只读）；共享 createGeometry() 产物则会被原地改坏。
const UNIT_BOX_GEOMETRY = buildUnitBoxDescription(Cesium.PerInstanceColorAppearance.VERTEX_FORMAT);
const UNIT_BOX_OUTLINE_GEOMETRY = buildUnitBoxOutlineDescription();
// 格线外观专用：position + st（无 normal）。st 让片元能在盒面内描边，
// 于是不必再建独立的线框 Primitive——Primitive 数减半、每格顶点从 48 降到 24。
const UNIT_BOX_GEOMETRY_ST = buildUnitBoxDescription(Cesium.VertexFormat.POSITION_AND_ST);

/**
 * 格线外观的顶点着色器。
 *
 * 逐字取自 Cesium 官方 PerInstanceFlatColorAppearanceVS（flat 无光照路径），
 * 仅追加 `in vec2 st;` 与 `v_st` 透传。position3DHigh/Low 是 PrimitivePipeline
 * 对 position 做相对中心编码后的产物，必须由 czm_computePosition() 合并回模型坐标。
 *
 * 配套约束：使用本着色器时 Primitive 必须 compressVertices:false。否则 Cesium 的
 * modifyForEncodedNormals 会剥离 `in vec2 st;`、改写成 compressedAttributes 解压路径
 * （虽仍可工作，但源码与实际着色器不再一致，调试时容易误判）。
 */
const CELL_EDGE_VERTEX_SHADER = `in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in float batchId;
in vec2 st;

out vec4 v_color;
out vec2 v_st;

void main()
{
    vec4 p = czm_computePosition();

    v_color = color;
    v_st = st;

    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;

/**
 * 生成格线外观的片元着色器。
 *
 * 线宽与透明度以字面量内联进源码：Cesium 的 Primitive 没有公开的 uniformMap 入口，
 * 而这两个值都是图层级常量，内联后连 uniform 更新都省了。
 *
 * 描边原理：st 是 BoxGeometry 为每个面生成的 [0,1]² 参数化，`min(st, 1-st)` 即「到该面
 * 四边的归一化距离」。直接用归一化距离会让线宽随面尺寸失真——顶面约为 格边长²，而侧面是
 * 格边长 × 柱高，同一个归一化宽度在两种面上物理宽度差几十倍。故用 fwidth 把归一化距离
 * 换算成「每像素变化量」，线宽便在屏幕上恒定，不随面尺寸与相机缩放变粗变细。
 *
 * 颜色：描边与填充同取本格填充色 RGB，仅透明度不同（与天气网格既有的
 * 「填充/框线同 RGB、透明度各自独立」语义一致），因此无需第二个逐实例颜色属性。
 * 若调用方需要不同的框线色相，应改用 outline:true 的独立线框 Primitive 路径。
 *
 * @param {number} edgeAlpha - 描边透明度（0~1）
 * @param {number} edgeWidthPx - 描边线宽，单位：像素
 * @returns {string} GLSL 片元着色器源码
 */
function buildCellEdgeFragmentShader(edgeAlpha, edgeWidthPx) {
  return `in vec4 v_color;
in vec2 v_st;

void main()
{
    vec2 edgeDist = min(v_st, 1.0 - v_st);
    vec2 w = max(fwidth(v_st) * ${edgeWidthPx.toFixed(3)}, vec2(1e-6));
    vec2 g = smoothstep(vec2(0.0), w, edgeDist);
    float line = 1.0 - min(g.x, g.y);

    vec4 fill = czm_gammaCorrect(v_color);
    out_FragColor = mix(fill, vec4(fill.rgb, ${edgeAlpha.toFixed(4)}), line);
}
`;
}

/**
 * 创建「盒面描边」外观：flat + 半透明 + 背面剔除，与 FILL_APPEARANCE 完全同渲染状态，
 * 只把着色器换成带 st 描边的版本。
 *
 * 每个图层创建一个（着色器里内联了该图层的 edgeAlpha / edgeWidthPx，无法跨图层复用）；
 * 同一图层内所有批次共享同一个实例。
 *
 * @param {number} edgeAlpha - 描边透明度（0~1）
 * @param {number} edgeWidthPx - 描边线宽，单位：像素
 * @returns {import('cesium').PerInstanceColorAppearance} 可交给 Primitive 的外观实例
 */
function createCellEdgeAppearance(edgeAlpha, edgeWidthPx) {
  return new Cesium.PerInstanceColorAppearance({
    flat: true,
    translucent: true,
    closed: true,
    vertexShaderSource: CELL_EDGE_VERTEX_SHADER,
    fragmentShaderSource: buildCellEdgeFragmentShader(edgeAlpha, edgeWidthPx),
  });
}

/**
 * 从列主序矩阵数组的指定偏移处取出一份 Cesium.Matrix4。
 *
 * @param {Float64Array|number[]} matrices - 列主序矩阵数组，每 16 个元素为一组
 * @param {number} offset - 目标矩阵在数组中的起始下标（通常为 16 的整数倍）
 * @returns {import('cesium').Matrix4} 新建的矩阵实例（与源数组不共享内存）
 */
function matrixFromPacked(matrices, offset) {
  return Cesium.Matrix4.fromArray(matrices, offset, new Cesium.Matrix4());
}

/**
 * 创建单格填充用的 GeometryInstance（单位立方体描述 + 本格 modelMatrix + 本格颜色）。
 *
 * 实例 id 固定为 `${code}#fill`，是后续 pick 命中判定与批表换色的索引键。
 *
 * @param {string} code - 格编码（independentGridCellCode 的产物）
 * @param {import('cesium').Matrix4} matrix - 本格 modelMatrix
 * @param {import('cesium').Color} color - 本格填充色，随 attributes 烘焙进批表
 * @param {import('cesium').BoxGeometry} [geometry=UNIT_BOX_GEOMETRY] - 单位立方体几何描述：
 *   默认 POSITION_AND_NORMAL；格线外观走 UNIT_BOX_GEOMETRY_ST（POSITION_AND_ST），
 *   必须与所用 Appearance 的着色器声明一致，否则 debug 构建下 Primitive 会抛
 *   「Appearance/Geometry mismatch」。
 * @returns {import('cesium').GeometryInstance} 可交给 Primitive 的填充实例
 */
function createFillInstance(code, matrix, color, geometry = UNIT_BOX_GEOMETRY) {
  return new Cesium.GeometryInstance({
    id: `${code}#fill`,
    geometry,
    modelMatrix: matrix,
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
    },
  });
}

/**
 * 创建单格框线用的 GeometryInstance（单位立方体线框描述 + 本格 modelMatrix + 本格颜色）。
 *
 * 实例 id 固定为 `${code}#outline`；填充与框线是两批独立几何，各自单独 ready。
 *
 * @param {string} code - 格编码（independentGridCellCode 的产物）
 * @param {import('cesium').Matrix4} matrix - 本格 modelMatrix，须与同格填充实例一致
 * @param {import('cesium').Color} color - 本格框线色，透明度可独立于填充色
 * @returns {import('cesium').GeometryInstance} 可交给 Primitive 的框线实例
 */
function createOutlineInstance(code, matrix, color) {
  return new Cesium.GeometryInstance({
    id: `${code}#outline`,
    geometry: UNIT_BOX_OUTLINE_GEOMETRY,
    modelMatrix: matrix,
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
    },
  });
}

/**
 * 把内部格记录转成对外的格描述对象，供 onClick / onMove / pick 回调使用。
 *
 * 只暴露编码、行列号、经纬度包围盒与当前颜色，不外泄 Primitive 等内部引用；
 * 颜色字段是内部 Color 的引用（非副本），调用方不应就地修改。
 *
 * @param {{originLon:number, originLat:number, cellSize:number}} model - 网格模型参数，cellSize 单位为度
 * @param {{code:string, col:number, row:number, fillColor:import('cesium').Color, outlineColor:import('cesium').Color}} rec - 内部格记录
 * @returns {GridCell} 格描述对象，四个边界单位为度
 */
function describeCell(model, rec) {
  const west = model.originLon + rec.col * model.cellSize;
  const south = model.originLat + rec.row * model.cellSize;
  return {
    code: rec.code,
    col: rec.col,
    row: rec.row,
    west,
    south,
    east: west + model.cellSize,
    north: south + model.cellSize,
    centerLon: west + model.cellSize / 2,
    centerLat: south + model.cellSize / 2,
    fillColor: rec.fillColor,
    outlineColor: rec.outlineColor,
  };
}

/**
 * 读取相机所在位置对应的格坐标，作为填充种子（只在建层与 refresh() 时取一次）。
 *
 * 把相机位置转成经纬度后，按 originLon/originLat 与 cellSize 反算行列号。返回值可能
 * 落在网格范围之外，本函数不夹取（由 createRingFill 内部夹到合法区间）；读取失败时
 * 回退到网格中心格。
 *
 * @param {import('cesium').Viewer} viewer - Cesium Viewer
 * @param {{originLon:number, originLat:number, cellSize:number, cols:number, rows:number}} model - 网格模型参数，cellSize 单位为度
 * @returns {{col:number, row:number}} 种子格的行列号
 */
function readCameraCenterColRow(viewer, model) {
  try {
    const carto = viewer.camera.positionCartographic;
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const col = Math.floor((lon - model.originLon) / model.cellSize);
    const row = Math.floor((lat - model.originLat) / model.cellSize);
    if (Number.isFinite(col) && Number.isFinite(row)) return { col, row };
  } catch (error) {
    console.warn('[cesium-grid] 读取相机中心失败，回退网格中心', error);
  }
  return { col: Math.floor(model.cols / 2), row: Math.floor(model.rows / 2) };
}

/**
 * 把 0~1 的颜色分量转成 0~255 字节（非有限值按 0 处理）。
 *
 * @param {number|undefined} value - 颜色分量，取值 0~1
 * @returns {number} 字节值，取值 0~255
 */
function toByte(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value * 255)));
}

/**
 * 判断一个值是否是可用的屏幕坐标（Canvas 像素）。
 *
 * 拾取入口是公开 API，外部可能传入 undefined / null / 缺字段的对象，
 * Cesium 的 pickEllipsoid 会直接抛错，故在入口统一挡掉。
 *
 * @param {unknown} position - 待检查值
 * @returns {boolean} true = 含有限数字的 x / y
 */
function isScreenPosition(position) {
  return (
    !!position &&
    typeof position === 'object' &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y)
  );
}

/**
 * 创建例化模式下的紧凑格索引，替代 Primitive 路径的 Map<string, rec>。
 *
 * 例化路径不需要逐格 rec 对象：颜色住在 GPU 实例缓冲里，CPU 侧只需两样东西——
 * 「code → handle」映射，以及「基础填充色 / 框线色」镜像（供 describeCell 回读、选中态还原）。
 * 因此改用定长 TypedArray：每格 4 B 索引 + 4 B 填充色 + 4 B 框线色 = 12 B，
 * 300 万格约 36 MB；对照 Primitive 路径实测的 501 B/格（约 1.40 GB）降约 42 倍。
 *
 * get() / values() 返回「代理记录」：字段读写直接落到 TypedArray，字段集与 Primitive 路径的 rec
 * 完全一致，因此 displayFill / setFill / describeCell 等既有逻辑无需为两种存储各写一份。
 * 代理记录是**临时对象**（每次 get 都新建），不要跨调用持有。
 *
 * @param {object} options - 配置
 * @param {number} options.cols - 网格列数
 * @param {number} options.rows - 网格行数
 * @param {() => string|null} options.getSelectedCode - 读取当前选中格编码：显示色需据此区分（选中格 alpha 提到 1）
 * @returns {object} 紧凑格索引（提供 size / has / get / values / register / fillAll / fillAllOutline / clear）
 */
function createCompactCellStore({ cols, rows, getSelectedCode }) {
  const totalCells = cols * rows;
  /** 线性下标（col * rows + row）→ handle + 1；0 表示该格尚未写入 */
  const index = new Int32Array(totalCells);
  /** 逐格基础填充色 RGBA8（与「显示色」区分：选中格的显示色是 base 的 alpha 提到 1） */
  const baseFill = new Uint8Array(totalCells * 4);
  /** 逐格框线色 RGBA8；例化模式框线由盒面描边从填充色推导，此镜像仅供 describeCell 回读 */
  const outline = new Uint8Array(totalCells * 4);
  let count = 0;

  /**
   * 把格编码 `"12,34"` 解析成线性下标。
   *
   * 不引入 code → key 的 Map：那会把内存打回 Map 量级；hover（32ms 一次）与点击的调用频率
   * 远低于填充，解析开销可忽略。
   *
   * @param {string} code - 格编码
   * @returns {number} 线性下标；格式非法或越界时返回 -1
   */
  function keyOfCode(code) {
    if (typeof code !== 'string') return -1;
    const comma = code.indexOf(',');
    if (comma <= 0) return -1;
    const colText = code.slice(0, comma);
    const rowText = code.slice(comma + 1);
    // 空串必须显式挡掉：Number('') === 0，否则 "12," 会被当成 (12,0) 命中无关格
    if (!colText || !rowText) return -1;
    const col = Number(colText);
    const row = Number(rowText);
    if (!Number.isInteger(col) || !Number.isInteger(row)) return -1;
    if (col < 0 || col >= cols || row < 0 || row >= rows) return -1;
    return col * rows + row;
  }

  function readColorAt(bytes, offset, out) {
    out.red = bytes[offset] / 255;
    out.green = bytes[offset + 1] / 255;
    out.blue = bytes[offset + 2] / 255;
    out.alpha = bytes[offset + 3] / 255;
    return out;
  }

  function writeColorAt(bytes, offset, color) {
    bytes[offset] = toByte(color?.red);
    bytes[offset + 1] = toByte(color?.green);
    bytes[offset + 2] = toByte(color?.blue);
    bytes[offset + 3] = toByte(color?.alpha ?? 1);
  }

  function makeRec(key) {
    const col = Math.floor(key / rows);
    const row = key - col * rows;
    const code = independentGridCellCode(col, row);
    const offset = key * 4;
    const rec = {
      code,
      col,
      row,
      handle: index[key] - 1,
      fillPrimitive: null,
      outlinePrimitive: null,
    };
    Object.defineProperties(rec, {
      baseFillColor: {
        get: () => readColorAt(baseFill, offset, new Cesium.Color()),
        set: (value) => writeColorAt(baseFill, offset, value),
      },
      fillColor: {
        // 显示色：选中格把 alpha 提到 1（保留数据色相），否则即基础色
        get: () => {
          const c = readColorAt(baseFill, offset, new Cesium.Color());
          return code === getSelectedCode() ? toOpaque(c) : c;
        },
        // 派生字段：setFill 写入的是显示色，其源头始终是 baseFillColor，故此处忽略赋值
        set: () => {},
      },
      outlineColor: {
        get: () => readColorAt(outline, offset, new Cesium.Color()),
        set: (value) => writeColorAt(outline, offset, value),
      },
    });
    return rec;
  }

  return {
    get size() {
      return count;
    },
    has(code) {
      const key = keyOfCode(code);
      return key >= 0 && index[key] !== 0;
    },
    get(code) {
      const key = keyOfCode(code);
      if (key < 0 || index[key] === 0) return undefined;
      return makeRec(key);
    },
    *values() {
      for (let key = 0; key < totalCells; key += 1) {
        if (index[key] !== 0) yield makeRec(key);
      }
    },
    register(col, row, handle, fillColor, outlineColor) {
      const key = col * rows + row;
      if (index[key] !== 0) return false; // 重复格（重播种兜底）
      index[key] = handle + 1;
      count += 1;
      const offset = key * 4;
      writeColorAt(baseFill, offset, fillColor);
      writeColorAt(outline, offset, outlineColor);
      return true;
    },
    fillAll(color) {
      const r = toByte(color?.red);
      const g = toByte(color?.green);
      const b = toByte(color?.blue);
      const a = toByte(color?.alpha ?? 1);
      for (let key = 0; key < totalCells; key += 1) {
        if (index[key] === 0) continue;
        const offset = key * 4;
        baseFill[offset] = r;
        baseFill[offset + 1] = g;
        baseFill[offset + 2] = b;
        baseFill[offset + 3] = a;
      }
    },
    fillAllOutline(color) {
      const r = toByte(color?.red);
      const g = toByte(color?.green);
      const b = toByte(color?.blue);
      const a = toByte(color?.alpha ?? 1);
      for (let key = 0; key < totalCells; key += 1) {
        if (index[key] === 0) continue;
        const offset = key * 4;
        outline[offset] = r;
        outline[offset + 1] = g;
        outline[offset + 2] = b;
        outline[offset + 3] = a;
      }
    },
    clear() {
      index.fill(0);
      baseFill.fill(0);
      outline.fill(0);
      count = 0;
    },
  };
}

/**
 * 包装调用方提供的逐格取色器，把它的异常挡在渲染路径之外。
 *
 * 取色器是外部代码（通常要读颜色文件并做插值），一旦抛错就会中断整批 addBatch，
 * 表现为「网格铺到一半停了」，且异常发生在 rAF 里，堆栈很难定位到具体格。
 * 这里改为「记一次告警 + 该格回退图层默认色」，填充继续推进。
 *
 * @param {((col:number, row:number) => unknown)|undefined} provider - 调用方提供的取色器
 * @returns {((col:number, row:number) => unknown)|null} 安全的取色器；未提供时为 null
 */
function createSafeCellColorProvider(provider) {
  if (typeof provider !== 'function') return null;
  let warned = false;
  return (col, row) => {
    try {
      return provider(col, row);
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn(
          `[cesium-grid] getCellColor 抛错（首个失败格 col=${col}, row=${row}），` +
            `后续失败不再重复告警，该格回退图层默认色`,
          error,
        );
      }
      return null;
    }
  };
}

/**
 * 把外部回调（onClick / onMove）包一层异常保护。
 *
 * 回调异常会从 Cesium 的事件分发里抛出，可能中断同一帧的其它监听者；
 * 对业务侧而言「点了网格但页面报错」远不如「点了网格没反应 + 一条明确日志」好定位。
 *
 * @param {Function|undefined} callback - 外部回调
 * @param {string} name - 回调名（用于告警文案）
 * @returns {Function|null} 受保护的回调；未提供时为 null
 */
function guardCallback(callback, name) {
  if (typeof callback !== 'function') return null;
  return (...args) => {
    try {
      return callback(...args);
    } catch (error) {
      console.error(`[cesium-grid] ${name} 回调执行失败`, error);
      return undefined;
    }
  };
}

/**
 * 创建独立立体网格图层（GPU 实例化、以相机中心为种子向外分批填充）。
 *
 * 副作用：向 viewer.scene.primitives 添加一个 PrimitiveCollection，注册 LEFT_CLICK /
 * MOUSE_MOVE 交互与 scene.postRender 监听，并立即开始首帧填充。
 * 调用方不再使用时调用返回句柄的 dispose()；viewer 销毁时也会自动清理
 * （通过 onViewerBeforeDestroy 登记的钩子，无需额外调用）。
 *
 * 入参全部经过 normalizeGridOptions 校验：非法值一律「回退默认值 + console.warn」，
 * 不抛错，保证图层在任何情况下都能建起来。
 *
 * @param {import('cesium').Viewer} viewer - Cesium Viewer；不可用时返回 null
 * @param {object} [options={}] - 网格配置，详见 README 选项表
 * @returns {GridLayerHandle|null} 图层句柄；viewer 不可用时为 null
 */
export function createIndependentGridLayer(viewer, options = {}) {
  if (!isViewerAlive(viewer)) {
    console.warn('[cesium-grid] viewer 不可用（未传入或已销毁），未创建网格图层');
    return null;
  }

  // 非对象入参（null / 字符串 / 数字）在归一化里会被兜住，但下面还要直接读回调字段，
  // 故在这里统一收口成对象，保证任何入参都不会让建层抛错。
  const rawOptions = options && typeof options === 'object' ? options : {};

  const {
    model,
    render,
    pump,
    worker: workerOptions,
    warnings,
    totalCells,
  } = normalizeGridOptions(rawOptions);
  for (const message of warnings) console.warn(`[cesium-grid] ${message}`);

  const {
    mathPick,
    edgeShader,
    edgeAlpha,
    edgeWidthPx,
    outlineEnabled,
    asyncGeometry,
    instancing,
    chunkSize,
    heightChunksPerFrame,
    layerType,
  } = render;
  const pumpBudgetMs = pump.budgetMs;
  const pumpMin = pump.min;
  const pumpMax = pump.max;
  let pumpSize = pump.initial;

  // 填充几何 / 外观 / 顶点压缩开关都随格线方案切换：
  // 格线外观读 st，故几何必须带 st 且必须关掉 Cesium 的属性压缩改写（见 CELL_EDGE_VERTEX_SHADER）
  const fillGeometry = edgeShader ? UNIT_BOX_GEOMETRY_ST : UNIT_BOX_GEOMETRY;
  const fillAppearance = edgeShader
    ? createCellEdgeAppearance(edgeAlpha, edgeWidthPx)
    : FILL_APPEARANCE;
  const compressVertices = !edgeShader;
  const getCellColor = createSafeCellColorProvider(rawOptions.getCellColor);
  const onClick = guardCallback(rawOptions.onClick, 'onClick');
  const onMove = guardCallback(rawOptions.onMove, 'onMove');
  const workerModel = {
    originLon: model.originLon,
    originLat: model.originLat,
    cellSize: model.cellSize,
    bottomHeight: model.bottomHeight,
    gridHeight: model.gridHeight,
  };

  const collection = new Cesium.PrimitiveCollection();
  viewer.scene.primitives.add(collection);

  /**
   * 例化渲染对象（默认模式，instancing:false 时为 null）。它本身就是 PrimitiveCollection 的合法成员
   * （只要求实现 update(frameState)），加入后由 collection 负责每帧回调与释放。
   * 非空时下面所有 Primitive 相关分支（addBatch / 延迟补写 / 就绪回调 / 高度分组重建 / Worker）
   * 都不参与，填充直接写实例缓冲。
   * @type {object|null}
   */
  const instanced = instancing
    ? createInstancedGridPrimitive({
        model,
        chunkSize,
        layerType,
        edgeAlpha,
        edgeWidthPx,
        heightChunksPerFrame,
      })
    : null;
  if (instanced) collection.add(instanced);

  /**
   * 已写入格的索引。两种存储对外都提供 size / has / get / values / clear，故下游逻辑无需分支：
   * - 例化模式（instancing）：紧凑 TypedArray，12 B/格（3M 格约 36 MB）；
   * - Primitive 模式：Map<string, rec>，501 B/格（3M 格约 1.40 GB）。
   * @type {Map<string, object>|object}
   */
  const cells = instanced
    ? createCompactCellStore({
        cols: model.cols,
        rows: model.rows,
        getSelectedCode: () => selectedCode,
      })
    : new Map();
  /** 已拿到矩阵、等待写入的场景项 */
  const pending = [];
  /** 未就绪批次的待补写实例颜色：Primitive → (instanceId → Color) */
  const deferredColors = new Map();
  /** 一次性就绪回调：Primitive → [callback]（高度回流时旧批延后移除用） */
  const readyCallbacks = new Map();
  let fill = null;
  let rafId = 0;
  let moveTimer = 0;
  let hoverCode = null;
  let selectedCode = null;
  let disposed = false;
  let fillDone = false;
  let inFlightCount = 0;
  let nextMilestonePct = 10;
  /** 高度回流：版本号（setBottomHeight 每次 +1）、在途批次版本、重烘焙队列 */
  let heightVersion = 0;
  let inFlightVersions = [];
  /**
   * 在途批次的格清单副本。
   *
   * 必须留副本：postMessage 时 packed.buffer 已被 transfer 给 Worker，主线程侧数组随即
   * detach（长度归零、不可读）。若不留副本，Worker 一旦崩溃/被终止，这批已从 fill 消费掉
   * 的格就永远丢失——表现为「填充进度卡在某个百分比再也不动」，且没有任何报错。
   * 副本代价是每批 batchSize 个 int32（默认 4000 格 = 16 KB）× PREFETCH_BATCHES(3) ≈ 48 KB，
   * 用这点内存换「Worker 崩溃可恢复」是划算的。
   * @type {Int32Array[]}
   */
  let inFlightCells = [];
  let heightQueue = [];
  let heightRafId = 0;

  /**
   * 运行期诊断计数：全部为累计值，重播种（refresh）不清零，便于观察整段生命周期的真实开销。
   *
   * 用途是给 batchSize / pumpBudgetMs / 是否值得做真实例化等决策提供实测依据：
   * pumpCost* 反映主线程单帧压力，primitiveCount 反映 draw call 规模，
   * pickCost* 反映拾取渲染开销（drillPick 每多一层就多一遍全场景离屏渲染）。
   * 汇总入口是 logStats()。
   */
  const stats = {
    /** 有实际写入动作的帧数（每帧最多 +1） */
    pumpFrames: 0,
    /** 累计写入场景的格数（按 cells.size 增量计，重播种的重复格不计入） */
    pumpedCells: 0,
    /** 单帧实际写入格数峰值 */
    cellsPerFrameMax: 0,
    /** addBatch 同步耗时累计，单位：毫秒 */
    pumpCostTotalMs: 0,
    /** addBatch 同步耗时峰值，单位：毫秒 */
    pumpCostMaxMs: 0,
    /** addBatch 同步耗时超过 16.7ms（60fps 帧预算）的帧数 */
    pumpOverBudgetFrames: 0,
    /** 拾取次数（左键点击、移动节流、handle.pick 各计一次） */
    pickCount: 0,
    /** 拾取耗时累计，单位：毫秒 */
    pickCostTotalMs: 0,
    /** 拾取耗时峰值，单位：毫秒 */
    pickCostMaxMs: 0,
    /** Worker 回包批次数 */
    workerBatches: 0,
    /** collection 内 Primitive 总数（每次 addBatch 后刷新） */
    primitiveCount: 0,
    /** 当前生效的每帧写入格数（tunePumpSize 的自适应结果） */
    pumpSize: 0,
    /** 例化模式下每帧写入耗时累计，单位：毫秒（与 pumpCostTotalMs 同义，分开记便于对比两条路径） */
    instancedWriteTotalMs: 0,
    /** 例化模式下每帧写入耗时峰值，单位：毫秒 */
    instancedWriteMaxMs: 0,
  };
  stats.pumpSize = pumpSize;

  // 例化模式下矩阵由主线程直接算并写入实例缓冲（实测 0.010 µs/格），不需要 Worker 流水线
  let worker = instanced ? null : createGridWorker(workerOptions);
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  /**
   * 按格编码取内部格记录。
   *
   * @param {string} code - 格编码（independentGridCellCode 的产物）
   * @returns {object|null} 内部格记录；该格尚未写入时为 null
   */
  function cellRecord(code) {
    return cells.get(code) || null;
  }

  /**
   * 判断一次拾取结果是否命中本图层的格实例。
   *
   * 命中条件：primitive 的 _layerType 等于本图层标记，且实例 id 形如 `${code}#fill`
   * 或 `${code}#outline`。只认本图层，避免把其他图层的拾取结果误判为格。
   *
   * @param {object|undefined} picked - scene.pick / scene.drillPick 返回的单个结果项
   * @returns {object|null} 命中的内部格记录；未命中或 id 不合法时为 null
   */
  function matchGridPick(picked) {
    if (!picked || picked.primitive?._layerType !== layerType) return null;
    const id = picked.id;
    if (typeof id !== 'string') return null;
    const m = /^(.*)#(fill|outline)$/.exec(id);
    if (!m) return null;
    return cellRecord(m[1]);
  }

  /**
   * 按屏幕坐标反算网格格（不依赖 GPU 拾取渲染，O(1)）。
   *
   * 用 pickEllipsoid 取射线与椭球交点，转经纬度后按 cellSize 取整得 (col,row)，
   * 再查 cells 拿已写入记录——未写入的格返回 null，与 GPU 拾取行为一致（没有几何可点）。
   * 全程不产生离屏渲染，是默认拾取路径（options.mathPick !== false）。
   *
   * 已知偏差：反算只交椭球（h=0），忽略 bottomHeight / gridHeight。柱体越高、视角越斜，
   * 水平偏移越大（≈ 柱高 × tan(离天底角)）。30m 柱高在 0.01°（约 1.1km）格边长下不足 0.1 格，
   * 可忽略；柱高上千米或格边长很小时应改用 mathPick:false 走 GPU 拾取。
   *
   * @param {import('cesium').Cartesian2} windowPosition - 屏幕坐标（canvas 像素）
   * @returns {object|null} 命中的内部格记录；落在网格范围外、射线未命中椭球或该格尚未写入时为 null
   */
  function pickCellByMath(windowPosition) {
    const cartesian = viewer.camera.pickEllipsoid(windowPosition, viewer.scene.globe.ellipsoid);
    if (!cartesian) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return null;
    const col = Math.floor(
      (Cesium.Math.toDegrees(carto.longitude) - model.originLon) / model.cellSize,
    );
    const row = Math.floor(
      (Cesium.Math.toDegrees(carto.latitude) - model.originLat) / model.cellSize,
    );
    if (col < 0 || col >= model.cols || row < 0 || row >= model.rows) return null;
    return cells.get(independentGridCellCode(col, row)) || null;
  }

  /**
   * 按屏幕坐标用 GPU 拾取网格格（mathPick:false 时的回退路径）。
   *
   * 快路径用 scene.pick（1 遍拾取渲染）——格子叠在地形/底图之上，鼠标直接落在格上时
   * 一次就中；半透明叠层下若先拾到地形 / 边界 / 设备标记，再退回 drillPick 向下钻
   * PICK_DRILL_LIMIT 层。若无条件 drillPick(8)，等于最多 8 遍全场景离屏渲染
   * （每次鼠标移动都会被 32ms 节流触发），代价过高。
   *
   * @param {import('cesium').Cartesian2} windowPosition - 屏幕坐标（canvas 像素）
   * @returns {object|null} 命中的内部格记录；未命中时为 null
   */
  function pickCellByGpu(windowPosition) {
    // 例化模式下整层共用一个 pickId，scene.pick 只能拿到「命中了本图层」，
    // 拿不到实例 id，也就无法反查是哪一格——GPU 拾取路径在例化模式下不可用。
    if (instanced) return null;
    let hit = matchGridPick(viewer.scene.pick(windowPosition));
    if (hit) return hit;
    const picks = viewer.scene.drillPick(windowPosition, PICK_DRILL_LIMIT) || [];
    for (let i = 0; i < picks.length; i += 1) {
      hit = matchGridPick(picks[i]);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 拾取入口：按 mathPick 选择数学反算或 GPU 拾取，并把整段耗时累加进 stats.pickCost*。
   *
   * 左键点击、鼠标移动节流、handle.pick 都走这里，因此 stats 的拾取统计覆盖全部路径。
   * 屏幕坐标非法时直接返回 null，不把异常抛给调用方。
   *
   * @param {import('cesium').Cartesian2} windowPosition - 屏幕坐标（canvas 像素）
   * @returns {object|null} 命中的内部格记录；未命中时为 null
   */
  function pickAt(windowPosition) {
    if (!isScreenPosition(windowPosition)) return null;
    const t0 = performance.now();
    // 例化模式没有逐实例 id，只能走数学反算（此时 mathPick 选项被忽略）
    const hit =
      instanced || mathPick ? pickCellByMath(windowPosition) : pickCellByGpu(windowPosition);
    const costMs = performance.now() - t0;
    stats.pickCount += 1;
    stats.pickCostTotalMs += costMs;
    if (costMs > stats.pickCostMaxMs) stats.pickCostMaxMs = costMs;
    return hit;
  }

  /**
   * 请求重绘一帧。requestRenderMode 开启时 Cesium 不会自动逐帧渲染，
   * 批表颜色等改动必须显式请求才会显示；viewer 已销毁或未开该模式时静默跳过。
   *
   * @returns {void}
   */
  function requestRender() {
    if (isViewerAlive(viewer) && viewer.scene.requestRenderMode) {
      viewer.scene.requestRender();
    }
  }

  /**
   * 按实例 id 把颜色写进批表（PerInstanceColorAppearance 的 _batchTable，渲染时直读）。
   *
   * Primitive 首次 update 前 _batchTable 尚未建立，此时取实例属性会抛 DeveloperError
   * （Cesium 约定：ready 之后才能取）；因此未就绪的写入先登记到 deferred，由调用方在
   * postRender 时补写。本函数不触发重绘，调用方需自行 requestRender。
   *
   * @param {import('cesium').Primitive} primitive - 目标实例所属的 Primitive 批次
   * @param {string} instanceId - 实例 id，形如 `${code}#fill` / `${code}#outline`
   * @param {import('cesium').Color} color - 目标颜色，会被转成 ColorGeometryInstanceAttribute
   * @returns {boolean} true = 已即时写入批表；false = 已登记待补写，或因 primitive 已销毁 / 取属性失败而未能写入
   */
  function applyInstanceColor(primitive, instanceId, color) {
    if (!primitive || primitive.isDestroyed()) return false;
    if (!primitive.ready) {
      // 批次尚未 update（无 _batchTable）：登记待补写，避免 DeveloperError 刷屏
      let bucket = deferredColors.get(primitive);
      if (!bucket) {
        bucket = new Map();
        deferredColors.set(primitive, bucket);
      }
      bucket.set(instanceId, color);
      return false;
    }
    let attrs;
    try {
      attrs = primitive.getGeometryInstanceAttributes(instanceId);
    } catch (error) {
      console.warn('[cesium-grid] getGeometryInstanceAttributes 失败', error);
      return false;
    }
    if (!attrs) return false;
    attrs.color = Cesium.ColorGeometryInstanceAttribute.toValue(color);
    return true;
  }

  /**
   * 改单格填充色：同步内部记录并写入批表，然后请求重绘。
   *
   * 批表未就绪时不直接写，而是由 applyInstanceColor 登记到 deferredColors，
   * 待 postRender 补写，因此 rec.fillColor 可能先于画面生效。
   *
   * @param {object|null} rec - 内部格记录；为 null 时不做任何事
   * @param {string|import('cesium').Color} color - 目标填充色，无法识别时沿用当前色
   * @returns {boolean} true = 请求已受理（未就绪则延迟落地）；false = rec 为空
   */
  function setFill(rec, color) {
    if (!rec) return false;
    const next = toColor(color, rec.fillColor);
    rec.fillColor = next; // 先记目标色：批次未就绪时由 flushDeferredColors 补写落地
    if (instanced) {
      // 例化路径没有 ready 概念：写 4 字节到实例缓冲即生效，不存在延迟落地
      instanced.setCellColor(rec.handle, next);
      requestRender();
      return true;
    }
    applyInstanceColor(rec.fillPrimitive, `${rec.code}#fill`, next);
    requestRender();
    return true; // 语义 = 请求已受理（未就绪则延迟落地），不是"已写入批表"
  }

  /**
   * 改单格框线色：同步内部记录并写入批表，然后请求重绘。
   *
   * 与 setFill 同构，只是作用于框线 Primitive；框线色与填充色相互独立
   * （天气网格用同 RGB、不同 alpha 的搭配）。
   *
   * @param {object|null} rec - 内部格记录；为 null 时不做任何事
   * @param {string|import('cesium').Color} color - 目标框线色，无法识别时沿用当前色
   * @returns {boolean} true = 请求已受理（未就绪则延迟落地）；false = rec 为空
   */
  function setOutline(rec, color) {
    if (!rec) return false;
    const next = toColor(color, rec.outlineColor);
    rec.outlineColor = next;
    if (instanced) {
      // 例化模式的框线是盒面描边，颜色恒取本格填充色 RGB + 统一 edgeAlpha，
      // 没有独立的框线颜色通道；此处只更新内部记录，返回 true 表示已受理。
      return true;
    }
    applyInstanceColor(rec.outlinePrimitive, `${rec.code}#outline`, next);
    requestRender();
    return true; // 同 setFill：受理即 true，未就绪由补写落地
  }

  /**
   * 批表就绪后补写延迟登记的实例颜色（postRender 时机，Cesium 官方 ready 示例同款）。
   *
   * 已 ready 的批次补写后从队列移除；仍未 ready 的批次保留，下一帧继续尝试。
   * 本函数不递归触发渲染，只在确实写成功时请求一帧重绘。
   *
   * @returns {void}
   */
  function flushDeferredColors() {
    if (disposed || !deferredColors.size) return;
    let wrote = false;
    for (const [primitive, bucket] of deferredColors) {
      if (!primitive) {
        deferredColors.delete(primitive);
        continue;
      }
      if (!primitive.ready) continue;
      for (const [instanceId, color] of bucket) {
        if (applyInstanceColor(primitive, instanceId, color)) wrote = true;
      }
      deferredColors.delete(primitive);
    }
    if (wrote) requestRender();
  }

  /**
   * 注册一次性就绪回调：Primitive ready 后执行（由 postRender 轮询触发）。
   *
   * Cesium 的 Primitive 没有 readyPromise，官方示例就是 postRender + ready 轮询。
   * primitive 已就绪时同步执行回调，否则挂到 readyCallbacks 队列；同一 Primitive 可挂多个回调。
   *
   * @param {import('cesium').Primitive} primitive - 目标批次；为空或已就绪时立即执行回调
   * @param {() => void} callback - 就绪后执行的回调（如高度回流时移除旧批）
   * @returns {void}
   */
  function waitPrimitiveReady(primitive, callback) {
    if (!primitive || primitive.ready) {
      callback();
      return;
    }
    const list = readyCallbacks.get(primitive);
    if (list) list.push(callback);
    else readyCallbacks.set(primitive, [callback]);
  }

  /**
   * 执行所有已就绪 Primitive 的挂起回调，并把它们从队列中移除。
   *
   * 尚未就绪的批次保留在队列里等下一帧。当前唯一的使用者是高度回流：
   * 等新批 ready 后再删旧批，避免出现"旧批已删、新批未就绪"的空洞。
   *
   * @returns {void}
   */
  function flushReadyCallbacks() {
    if (!readyCallbacks.size) return;
    for (const [primitive, list] of readyCallbacks) {
      if (!primitive.ready) continue;
      readyCallbacks.delete(primitive);
      for (const callback of list) callback();
    }
  }

  /**
   * scene.postRender 统一入口：先补写延迟登记的实例颜色，再执行已就绪批次的挂起回调。
   *
   * 已释放时直接返回。本函数挂在 viewer.scene.postRender 上，由 dispose 负责移除。
   *
   * @returns {void}
   */
  function onScenePostRender() {
    if (disposed) return;
    flushDeferredColors();
    flushReadyCallbacks();
  }

  /**
   * 按当前选中状态刷新某格填充色（颜色状态机的唯一出口）。
   *
   * 选中 → 本格 baseFillColor 置 alpha=1；未选中 → 还原 baseFillColor（预设透明度）。
   * 注意：这里不再有 hover 分支。hoverCode 是鼠标位置状态，点第二次取消选中时鼠标必然
   * 还停在该格上，若 hover 参与着色就会把「取消选中」涂成 hover 提示色、还原不回预设透明度；
   * 且 hover 高亮本就未启用（handlerMove 里不调 displayFill），故 hover 不参与颜色决策。
   * 日后若要启用 hover 高亮：优先级 selected > hover > base，且取消选中必须走 baseFillColor。
   *
   * @param {object|null} rec - 目标格记录，读其 code 与 baseFillColor；为 null 时不做任何事
   * @returns {void}
   */
  function displayFill(rec) {
    if (!rec) return;
    if (rec.code === selectedCode) setFill(rec, toOpaque(rec.baseFillColor));
    else setFill(rec, rec.baseFillColor);
  }

  /**
   * 把一批待写项落进场景：逐格建填充/框线实例，各建一个 Primitive 加入集合，并登记进 cells。
   *
   * 每格初始色由 options.getCellColor 逐格求得，随 GeometryInstance.attributes 烘焙进批表，
   * 首屏即数据色，无需事后补一次换色。已在 cells 里的格会被跳过（重播种 / 重复下发兜底）；
   * 单位立方体描述创建失败时本批整体跳过并打 error。
   *
   * @param {Array<{code:string, col:number, row:number, matrix:import('cesium').Matrix4}>} items - 待写项清单，来自 pushPending
   * @returns {void}
   */
  function addBatch(items) {
    if (!items.length || disposed) return;
    if (!fillGeometry || (outlineEnabled && !UNIT_BOX_OUTLINE_GEOMETRY)) {
      console.error('[cesium-grid] 单位立方体几何描述创建失败，本批跳过');
      return;
    }
    const fillInstances = [];
    const outlineInstances = outlineEnabled ? [] : null;
    const batchRecs = [];
    for (const item of items) {
      if (cells.has(item.code)) continue; // 重播种/重复下发兜底
      const provided = getCellColor ? getCellColor(item.col, item.row) : null;
      let fillColor;
      let outlineColor;
      if (provided instanceof Cesium.Color) {
        // 返回 Color：仅逐格填充色，框线保持图层默认
        fillColor = provided.clone();
        outlineColor = model.outlineColor.clone();
      } else if (provided && provided.fillColor) {
        // 返回 {fillColor, outlineColor}：填充/框线同取本格颜色，透明度各自独立
        fillColor = toColor(provided.fillColor, model.fillColor);
        outlineColor = provided.outlineColor
          ? toColor(provided.outlineColor, model.outlineColor)
          : model.outlineColor.clone();
      } else {
        fillColor = model.fillColor.clone();
        outlineColor = model.outlineColor.clone();
      }
      fillInstances.push(createFillInstance(item.code, item.matrix, fillColor, fillGeometry));
      if (outlineInstances) {
        outlineInstances.push(createOutlineInstance(item.code, item.matrix, outlineColor));
      }
      batchRecs.push({
        code: item.code,
        col: item.col,
        row: item.row,
        fillColor,
        outlineColor,
        baseFillColor: fillColor.clone(),
      });
    }
    if (!fillInstances.length) return;

    // allowPicking 必须保持 true：图层自身拾取已改走 pickCellByMath（不依赖 GPU），
    // 但外部仍靠 scene.pick 拿 primitive._layerType 识别本图层（业务侧的左右键分支）。
    // 置 false 会让那些外部入口失效。
    const fillPrimitive = new Cesium.Primitive({
      geometryInstances: fillInstances,
      appearance: fillAppearance,
      asynchronous: asyncGeometry,
      allowPicking: true,
      releaseGeometryInstances: false,
      compressVertices,
    });
    fillPrimitive._layerType = layerType;
    collection.add(fillPrimitive);
    // outlineEnabled=false（含 edgeShader 模式）时整批不建线框 Primitive：
    // Primitive 数减半、每格少 24 个线框顶点；格线由填充外观在盒面内描边（edgeShader）
    // 或干脆不画（outline:false）。两种情况下 rec.outlinePrimitive 为 null，
    // applyInstanceColor / dropOldBatch 都已能安全处理 null。
    const outlinePrimitive = outlineEnabled
      ? new Cesium.Primitive({
          geometryInstances: outlineInstances,
          appearance: OUTLINE_APPEARANCE,
          asynchronous: asyncGeometry,
          allowPicking: true,
          releaseGeometryInstances: false,
        })
      : null;
    if (outlinePrimitive) {
      outlinePrimitive._layerType = layerType;
      collection.add(outlinePrimitive);
    }
    stats.primitiveCount = collection.length;

    for (const rec of batchRecs) {
      rec.fillPrimitive = fillPrimitive;
      rec.outlinePrimitive = outlinePrimitive;
      cells.set(rec.code, rec);
      // 不再 displayFill：初始色已随 GeometryInstance.attributes 烘焙进批表，首屏即数据色。
      // 新格也不可能处于 hover / 选中态——hoverCode / selectedCode 只会指向已在 cells 里的格，
      // 而本函数开头已用 cells.has 排除过。故此处无需任何换色（原来那一次是纯冗余写入）。
    }
  }

  /**
   * 把交错格清单与对应的矩阵数组转成待写项，追加到 pending 队列。
   *
   * @param {Int32Array} packed - 交错格清单 [col,row,col,row,...]，可能来自 Worker（已 transfer 回来）
   * @param {Float64Array} matrices - 与 packed 一一对应的列主序矩阵数组（格数 × 16）
   * @returns {void}
   */
  function pushPending(packed, matrices) {
    for (let i = 0, m = 0; i + 1 < packed.length; i += 2, m += 16) {
      pending.push({
        code: independentGridCellCode(packed[i], packed[i + 1]),
        col: packed[i],
        row: packed[i + 1],
        matrix: matrixFromPacked(matrices, m),
      });
    }
  }

  /**
   * 填充进度每跨过 10% 的整数刻度时打印一次日志（用 nextMilestonePct 记录下一个刻度）。
   *
   * 只打日志，不改任何状态；重播种时 nextMilestonePct 会被重新对齐到当前进度之上。
   *
   * @returns {void}
   */
  function logMilestone() {
    const pct = (cells.size / totalCells) * 100;
    if (pct >= nextMilestonePct) {
      console.info(`[cesium-grid] 已写入 ${cells.size}/${totalCells}（${Math.floor(pct)}%）`);
      nextMilestonePct += 10;
    }
  }

  /**
   * 打印一次运行期诊断汇总，并返回本次计数的快照（填充完成时自动调用，也可手动调 handle.logStats）。
   *
   * Primitive 路径下额外遍历一次 collection 统计「仍未就绪的 Primitive 数」：该值在填充完成后
   * 仍显著大于 0，说明异步几何构建（createGeometry / combineGeometry）拖在填充后面——此时继续
   * 加大每帧格数只会让未就绪队列更长，应优先降低每格顶点数。
   * 例化路径没有 ready 概念，改为汇总块数、每格字节与累计上传量（判断是否值得调 chunkSize）。
   * 遍历开销为 O(成员数)，只在汇总时发生，不影响填充路径。
   *
   * @returns {object} 计数快照：stats 全部字段 + notReadyPrimitives / primitiveLikeCount /
   *   avgPumpCostMs / avgPickCostMs / avgWriteCostMs，例化模式下另含 instanced（例化层统计）
   */
  function logStats() {
    let notReadyPrimitives = 0;
    let primitiveLikeCount = 0;
    if (!disposed && isViewerAlive(viewer)) {
      for (let i = 0; i < collection.length; i += 1) {
        const item = collection.get(i);
        // 例化对象没有 ready 概念，只统计 Primitive 类成员，避免把它误计成「未就绪」
        if (typeof item.ready !== 'boolean') continue;
        primitiveLikeCount += 1;
        if (!item.ready) notReadyPrimitives += 1;
      }
    }
    const avgPumpCostMs = stats.pumpFrames ? stats.pumpCostTotalMs / stats.pumpFrames : 0;
    const avgPickCostMs = stats.pickCount ? stats.pickCostTotalMs / stats.pickCount : 0;
    const avgWriteCostMs = stats.pumpFrames ? stats.instancedWriteTotalMs / stats.pumpFrames : 0;
    const instancedStats = instanced ? instanced.getStats() : null;
    const snapshot = {
      ...stats,
      notReadyPrimitives,
      primitiveLikeCount,
      avgPumpCostMs,
      avgPickCostMs,
      avgWriteCostMs,
      instanced: instancedStats,
    };
    const toMB = (bytes) => (bytes / 1048576).toFixed(1);
    const writeLine = instanced
      ? `例化写入 均值 ${avgWriteCostMs.toFixed(2)}ms / 峰值 ${stats.instancedWriteMaxMs.toFixed(2)}ms`
      : `addBatch 均值 ${avgPumpCostMs.toFixed(2)}ms / 峰值 ${stats.pumpCostMaxMs.toFixed(2)}ms`;
    const scaleLine = instancedStats
      ? `例化 ${instancedStats.chunks} 块（边长 ${instancedStats.chunkSize} 格）/ 每格 ${instancedStats.bytesPerInstance} B / ` +
        `已写 ${instancedStats.writtenCells} 格（矩阵 ${toMB(instancedStats.matrixBytes)}MB + 颜色 ${toMB(instancedStats.colorBytes)}MB），` +
        `累计上传 ${toMB(instancedStats.uploadBytes)}MB；`
      : `Primitive ${stats.primitiveCount} 个（未就绪 ${notReadyPrimitives}）；`;
    console.info(
      `[cesium-grid][stats] 写入 ${stats.pumpedCells}/${totalCells} 格 / ${stats.pumpFrames} 帧` +
        `（均值 ${Math.round(stats.pumpedCells / Math.max(1, stats.pumpFrames))} 格/帧，峰值 ${stats.cellsPerFrameMax}）；` +
        `${writeLine}（超 16.7ms 帧预算 ${stats.pumpOverBudgetFrames} 帧）；` +
        scaleLine +
        `拾取 ${stats.pickCount} 次，均值 ${avgPickCostMs.toFixed(2)}ms / 峰值 ${stats.pickCostMaxMs.toFixed(2)}ms；` +
        `Worker 批次 ${stats.workerBatches}`,
    );
    return snapshot;
  }

  /**
   * 按上一帧实测耗时调整每帧写入格数，使单批同步耗时贴近 pumpBudgetMs。
   *
   * 目标是顶到预算上限：每帧格数越大，Primitive 越少、draw call 与拾取渲染越省；
   * 但单批过大会让主线程超支。超支时按超出比例收缩（留 10% 余量），
   * 余量充足时单次最多涨 1.5 倍以避免振荡。调整结果同步到 stats.pumpSize 供观测。
   *
   * 注意：这里量到的只是 addBatch 的同步耗时（实例构造 + Primitive 构造）；
   * 几何构建是异步的（Cesium 内部 Worker），其吞吐需另看 logStats 的 notReadyPrimitives。
   *
   * @param {number} actual - 本帧实际写入格数，作为超支收缩的缩放基准
   * @param {number} costMs - 本帧 addBatch 的同步耗时，单位：毫秒
   * @returns {void}
   */
  function tunePumpSize(actual, costMs) {
    if (costMs > pumpBudgetMs) {
      pumpSize = Math.max(pumpMin, Math.floor(actual * (pumpBudgetMs / costMs) * 0.9));
    } else if (costMs < pumpBudgetMs * 0.5 && pumpSize < pumpMax) {
      pumpSize = Math.min(pumpMax, Math.ceil(pumpSize * 1.5));
    }
    stats.pumpSize = pumpSize;
  }

  /**
   * 填充主循环（rAF 回调）：每帧从 pending 取最多 pumpSize 项写入场景。
   *
   * pumpSize 由 tunePumpSize 按上一帧实测耗时自适应（初值 options.pumpSize），
   * 因此快机器自动写更多、慢机器自动写更少，铺满速度不再被固定格数钉死。
   * 写完再补一次 ensurePacked 维持流水线；只要 pending 仍有内容就继续排下一帧。
   * 当所有环已产完且 Worker 在途批次归零时，标记 fillDone 并打印完成日志与诊断汇总。
   * 本帧 addBatch 的同步耗时与实际写入格数会累加进 stats（不额外分配对象，不影响填充路径）。
   *
   * @returns {void}
   */
  function pumpBatch() {
    rafId = 0;
    if (disposed || !isViewerAlive(viewer)) return;
    const limit = Math.min(pumpSize, pending.length);
    if (limit > 0) {
      const items = pending.splice(0, limit);
      const cellsBefore = cells.size;
      const t0 = performance.now();
      addBatch(items);
      const costMs = performance.now() - t0;
      const written = cells.size - cellsBefore;
      stats.pumpFrames += 1;
      stats.pumpedCells += written;
      stats.pumpCostTotalMs += costMs;
      if (costMs > stats.pumpCostMaxMs) stats.pumpCostMaxMs = costMs;
      if (written > stats.cellsPerFrameMax) stats.cellsPerFrameMax = written;
      if (costMs > 16.7) stats.pumpOverBudgetFrames += 1;
      tunePumpSize(limit, costMs);
    }
    logMilestone();
    requestRender();
    if (pending.length) {
      rafId = requestAnimationFrame(pumpBatch);
      return;
    }
    ensurePacked();
    if (pending.length) {
      rafId = requestAnimationFrame(pumpBatch);
      return;
    }
    if (fill && fill.isDone() && inFlightCount === 0 && !fillDone) {
      fillDone = true;
      console.info(`[cesium-grid] 填充完成：${cells.size}/${totalCells} 格全部写入`);
      logStats();
    }
  }

  /**
   * 例化路径的取色提供器：把 options.getCellColor 的三种返回形态规整成一个填充色。
   *
   * 判定与 addBatch 保持一致：Color → 直接作填充色；{fillColor} → 取其 fillColor；
   * 其余（null / undefined）→ 图层默认填充色。例化模式的框线由盒面描边从填充色推导，
   * 故这里不产出 outlineColor。
   *
   * @param {number} col - 列号
   * @param {number} row - 行号
   * @returns {import('cesium').Color} 本格填充色（可能是图层默认色的引用）
   */
  function instancedCellColor(col, row) {
    if (!getCellColor) return model.fillColor;
    const provided = getCellColor(col, row);
    if (provided instanceof Cesium.Color) return provided;
    if (provided && provided.fillColor) return toColor(provided.fillColor, model.fillColor);
    return model.fillColor;
  }

  /**
   * 例化写入成功后的逐格登记：把「格 → 实例槽位」与颜色镜像记进紧凑格索引。
   *
   * 例化路径不记 Primitive 引用（换色直接写实例缓冲的槽位），只记 handle。
   * 重复格由 store.register 内部兜底跳过（重播种时同一格可能被再次下发）。
   *
   * @param {number} col - 列号
   * @param {number} row - 行号
   * @param {number} handle - 实例槽位句柄（writePackedCells 的产物）
   * @param {import('cesium').Color|null} color - 本格填充色；为 null 时取图层默认色
   * @returns {void}
   */
  function registerInstancedCell(col, row, handle, color) {
    const fillColor = color ? toColor(color, model.fillColor) : model.fillColor.clone();
    cells.register(col, row, handle, fillColor, model.outlineColor);
  }

  /**
   * 例化路径的填充主循环（rAF 回调）：按时间预算连续写入格，写完一帧再由 rAF 续排。
   *
   * 与 Primitive 路径的关键区别是「写入即生效」——没有 pending 队列、没有 Worker 在途批次、
   * 没有 Primitive 就绪等待，所以每帧写多少只受主线程耗时约束，不受几何构建吞吐约束。
   * 预算用满或所有环产完即让出主线程，保证不阻塞交互。
   *
   * @returns {void}
   */
  function pumpInstanced() {
    rafId = 0;
    if (disposed || !isViewerAlive(viewer) || !fill || !instanced) return;
    const cellsBefore = cells.size;
    const t0 = performance.now();
    while (!fillDone) {
      const packed = fill.nextBatch(model.batchSize);
      if (!packed.length) {
        fillDone = true;
        break;
      }
      instanced.writePackedCells(packed, instancedCellColor, registerInstancedCell);
      if (performance.now() - t0 >= pumpBudgetMs) break;
    }
    const costMs = performance.now() - t0;
    const written = cells.size - cellsBefore;
    stats.pumpFrames += 1;
    stats.pumpedCells += written;
    stats.instancedWriteTotalMs += costMs;
    if (costMs > stats.instancedWriteMaxMs) stats.instancedWriteMaxMs = costMs;
    if (written > stats.cellsPerFrameMax) stats.cellsPerFrameMax = written;
    if (costMs > 16.7) stats.pumpOverBudgetFrames += 1;
    logMilestone();
    requestRender();
    if (!fillDone) {
      rafId = requestAnimationFrame(pumpInstanced);
      return;
    }
    console.info(
      `[cesium-grid] 例化填充完成：${cells.size}/${totalCells} 格，共 ${stats.pumpFrames} 帧`,
    );
    logStats();
  }

  /**
   * 确保填充循环在跑：pending 有内容、且当前没有排队的 rAF 时才补排一帧。
   *
   * 幂等，可被多处（Worker 回包、主线程直算、重播种）重复调用而不会排出多个循环。
   *
   * @returns {void}
   */
  function ensurePump() {
    if (instanced) return; // 例化路径由 pumpInstanced 自驱动，不经过 pending 队列
    if (!disposed && !rafId && pending.length) {
      rafId = requestAnimationFrame(pumpBatch);
    }
  }

  /**
   * 维持填充流水线：Worker 在途批次数不足 PREFETCH_BATCHES 时继续下发下一批；
   * 无 Worker 时改为主线程直算（pending 已积累到 PREFETCH_BATCHES 批则先不补，避免堆积）。
   *
   * 两种分支都按 model.batchSize 切块（传输粒度），与每帧消费量 pumpSize 无关：
   * 预取上限保持 PREFETCH_BATCHES 批，确保消费端最多取到 pumpMax = batchSize 时仍有货。
   * 已释放或填充已完成时直接返回。Worker 分支把格清单 transfer 出去，
   * 因此转移后主线程不能再读该 buffer。
   *
   * @returns {void}
   */
  function ensurePacked() {
    if (instanced) return; // 例化路径不预取：矩阵由主线程直算并直接写入实例缓冲
    if (disposed || fillDone || !fill || !isViewerAlive(viewer)) return;
    if (worker) {
      while (inFlightCount < PREFETCH_BATCHES) {
        const packed = fill.nextBatch(model.batchSize);
        if (!packed.length) break;
        inFlightCount += 1;
        inFlightVersions.push(heightVersion);
        // 先留副本再 transfer：transfer 之后 packed 本身已不可读（见 inFlightCells 注释）
        inFlightCells.push(packed.slice());
        worker.postMessage(
          { type: 'packCells', requestId: inFlightCount, cells: packed, model: workerModel },
          [packed.buffer],
        );
      }
    } else if (pending.length < model.batchSize * PREFETCH_BATCHES) {
      const packed = fill.nextBatch(model.batchSize);
      if (packed.length) {
        pushPending(packed, packCellsMatrices(packed, model));
        ensurePump();
      }
    }
  }

  if (worker) {
    worker.onmessage = (event) => {
      const data = event.data;
      if (!data || data.type !== 'packCells' || disposed) return;
      stats.workerBatches += 1;
      inFlightCount = Math.max(0, inFlightCount - 1);
      const version = inFlightVersions.shift();
      inFlightCells.shift();
      let matrices = data.matrices;
      if (version !== heightVersion) {
        // 批次下发后高度已变：按最新高度主线程重算矩阵
        matrices = packCellsMatrices(data.cells, model);
      }
      pushPending(data.cells, matrices);
      ensurePacked();
      ensurePump();
    };
    worker.onerror = (error) => {
      console.warn('[cesium-grid] Worker 异常，回退主线程计算', error);
      try {
        worker.terminate();
      } catch (terminateError) {
        console.warn('[cesium-grid] Worker 终止失败（忽略）', terminateError);
      }
      worker = null;
      inFlightCount = 0;
      inFlightVersions = [];
      // 把在途批次抢回主线程：这些格已从 fill 消费掉，不回补就会永久缺失（填充永远到不了 100%）
      const orphans = inFlightCells;
      inFlightCells = [];
      for (const cells of orphans) {
        if (cells.length) pushPending(cells, packCellsMatrices(cells, model));
      }
      ensurePacked();
      ensurePump();
    };
  }

  /**
   * 以当前相机中心为种子重新规划填充顺序，并推进填充流水线。
   *
   * 建层时调用一次；此后填充与相机运动无关，只有 refresh() 会手动重播种。
   * 已写入的格不受影响（新种子产出的重复格由 cells.has 兜底跳过），
   * 进度里程碑会被重新对齐到当前进度之上。
   *
   * @returns {void}
   */
  function reseedFromCamera() {
    if (disposed) return;
    const center = readCameraCenterColRow(viewer, model);
    fill = createRingFill(center.col, center.row, model.cols, model.rows);
    fillDone = false;
    inFlightCount = 0; // 旧种子的在途消息仍会回来：onmessage 里 clamp 到 0，重复项由 cells.has 兜底
    inFlightVersions = [];
    inFlightCells = [];
    nextMilestonePct = Math.floor(((cells.size / totalCells) * 100) / 10 + 1) * 10;
    if (instanced) {
      const s = instanced.getStats();
      console.info(
        `[cesium-grid] 例化渲染 ${model.cols}×${model.rows} = ${totalCells} 格，种子 (col,row)=(${center.col},${center.row})，` +
          `分 ${s.chunks} 块（块边长 ${s.chunkSize} 格），每格 ${s.bytesPerInstance} B（3×vec4 矩阵 + RGBA8 颜色），` +
          `每帧预算 ${pumpBudgetMs}ms，拾取数学反算，格线盒面描边（alpha=${edgeAlpha}，${edgeWidthPx}px），` +
          `从中心向外填充，写入即渲染`,
      );
      if (!rafId) rafId = requestAnimationFrame(pumpInstanced);
      return;
    }
    console.info(
      `[cesium-grid] GPU 实例化 ${model.cols}×${model.rows} = ${totalCells} 格，种子 (col,row)=(${center.col},${center.row})，` +
        `每帧 ${pumpSize} 格（自适应，预算 ${pumpBudgetMs}ms，范围 ${pumpMin}~${pumpMax}）/ 传输块 ${model.batchSize}，` +
        `几何${asyncGeometry ? '异步（Worker）' : '同步（主线程）'}创建，拾取${mathPick ? '数学反算' : 'GPU pick'}，` +
        `格线${
          edgeShader
            ? `盒面描边（alpha=${edgeAlpha}，${edgeWidthPx}px，无独立线框 Primitive）`
            : outlineEnabled
              ? '独立线框 Primitive'
              : '关闭'
        }，` +
        `从中心向外填充，已写入常驻`,
    );
    ensurePacked();
    ensurePump();
  }

  /**
   * 高度回流的一帧：重烘焙 heightQueue 里的一组格。
   *
   * 按最新 bottomHeight 重算 modelMatrix，建新 Primitive 删旧（颜色 / hover / 选中状态保留，
   * PrimitiveCollection.remove 会自动销毁旧批）。异步几何时先挂新批、等新批 ready 再删旧批，
   * 避免出现"旧批已删、新批未就绪"的空洞；同步路径下直接删。队列还有剩余就继续排下一帧。
   *
   * @returns {void}
   */
  function rebuildHeightGroup() {
    heightRafId = 0;
    if (disposed || !isViewerAlive(viewer)) return;
    const recs = heightQueue.shift();
    if (!recs || !recs.length) return;
    const packed = new Int32Array(recs.length * 2);
    for (let i = 0; i < recs.length; i += 1) {
      packed[i * 2] = recs[i].col;
      packed[i * 2 + 1] = recs[i].row;
    }
    const matrices = packCellsMatrices(packed, model);
    const fillInstances = [];
    const outlineInstances = outlineEnabled ? [] : null;
    for (let i = 0; i < recs.length; i += 1) {
      const rec = recs[i];
      const m = matrixFromPacked(matrices, i * 16);
      fillInstances.push(createFillInstance(rec.code, m, rec.fillColor, fillGeometry));
      if (outlineInstances) {
        outlineInstances.push(createOutlineInstance(rec.code, m, rec.outlineColor));
      }
    }
    const fillPrimitive = new Cesium.Primitive({
      geometryInstances: fillInstances,
      appearance: fillAppearance,
      asynchronous: asyncGeometry,
      allowPicking: true,
      releaseGeometryInstances: false,
      compressVertices,
    });
    fillPrimitive._layerType = layerType;
    collection.add(fillPrimitive);
    const outlinePrimitive = outlineEnabled
      ? new Cesium.Primitive({
          geometryInstances: outlineInstances,
          appearance: OUTLINE_APPEARANCE,
          asynchronous: asyncGeometry,
          allowPicking: true,
          releaseGeometryInstances: false,
        })
      : null;
    if (outlinePrimitive) {
      outlinePrimitive._layerType = layerType;
      collection.add(outlinePrimitive);
    }
    // 移除旧批（同组 rec 共享同一对 fill/outline Primitive；remove 自动销毁）。
    // 异步几何要等 Worker 合并完才可见：先挂新批、旧批继续显示，新批 ready 后再删旧批，
    // 否则 z 切换过程中会出现"旧批已删、新批未就绪"的空洞（每组约 2~3 帧，填充期 Worker
    // 繁忙时更久）。同步路径下新批下一帧即可见，直接删。
    const oldFill = recs[0].fillPrimitive;
    const oldOutline = recs[0].outlinePrimitive;
    /**
     * 移除本组旧批（新批已就绪后调用）。
     *
     * 先清掉旧批在 deferredColors / readyCallbacks 里的残留登记：Primitive.isDestroyed()
     * 恒为 false，销毁后 _batchTable 已释放，残留登记会在后续帧再次抛错。
     *
     * @returns {void}
     */
    const dropOldBatch = () => {
      deferredColors.delete(oldFill);
      deferredColors.delete(oldOutline);
      readyCallbacks.delete(oldFill);
      readyCallbacks.delete(oldOutline);
      if (disposed || !isViewerAlive(viewer)) return;
      if (oldFill && collection.contains(oldFill)) collection.remove(oldFill);
      if (oldOutline && collection.contains(oldOutline)) collection.remove(oldOutline);
    };
    for (const rec of recs) {
      rec.fillPrimitive = fillPrimitive;
      rec.outlinePrimitive = outlinePrimitive;
    }
    // 填充与框线是两批独立几何，各自就绪时间不同；等两者都 ready 再删旧批，避免线框先缺一帧。
    // outlinePrimitive 为 null（未启线框）时 filter 会滤掉，只等填充批。
    const notReady = [fillPrimitive, outlinePrimitive].filter(
      (primitive) => primitive && !primitive.ready,
    );
    if (asyncGeometry && notReady.length) {
      let pendingReady = notReady.length;
      /**
       * 单个批次就绪的回调：填充与框线两批都就绪后，才真正移除旧批。
       *
       * 两者是独立几何、ready 时间不同，若各自就绪就删，会出现线框缺一帧的情况。
       *
       * @returns {void}
       */
      const onOneReady = () => {
        pendingReady -= 1;
        if (pendingReady === 0) dropOldBatch();
      };
      for (const primitive of notReady) waitPrimitiveReady(primitive, onOneReady);
    } else {
      dropOldBatch();
    }
    requestRender();
    if (heightQueue.length) heightRafId = requestAnimationFrame(rebuildHeightGroup);
  }

  /**
   * 原地修改底面高度（不整层重建）：
   * 未写入格自然用新高度（新批次 / 版本过期的在途批次会按新高度重算）；
   * 已写入格按原批次逐组重烘焙（每组一帧，保留颜色状态）。
   * 回流进行中再次调用会重新排队全部组，矩阵恒按最新高度计算。
   *
   * @param {number} newBottomHeight - 底面高度，单位：米（椭球基准）；非有限值、负数或与当前值相同时直接忽略
   * @returns {void}
   */
  function setBottomHeight(newBottomHeight) {
    if (disposed) return;
    const z = Number(newBottomHeight);
    if (!Number.isFinite(z) || z < 0 || z === model.bottomHeight) return;
    model.bottomHeight = z;
    workerModel.bottomHeight = z;
    heightVersion += 1;
    if (instanced) {
      // 例化路径：只重写实例矩阵的平移分量（分帧限流），不重建任何 Cesium 对象
      instanced.setBottomHeight(z);
      console.info(`[cesium-grid] 高度回流（例化）：bottomHeight → ${z}m，分帧重写实例矩阵`);
      requestRender();
      return;
    }
    if (!cells.size) return; // 尚无已写入格：新格自然用新高度
    const groups = new Map();
    for (const rec of cells.values()) {
      const key = rec.fillPrimitive;
      let g = groups.get(key);
      if (!g) {
        g = [];
        groups.set(key, g);
      }
      g.push(rec);
    }
    heightQueue = [...groups.values()];
    if (!heightRafId) heightRafId = requestAnimationFrame(rebuildHeightGroup);
    console.info(
      `[cesium-grid] 高度回流：bottomHeight → ${z}m，原地重烘焙 ${heightQueue.length} 批`,
    );
  }

  /**
   * 鼠标移动回调：32ms 节流拾取一次，把结果交给 options.onMove，并维护 hoverCode。
   *
   * hover 不参与着色（填充色统一由 displayFill 依 selectedCode 决定），hoverCode 只用于
   * 回调去重；节流期间（moveTimer 未清零）的移动事件直接丢弃，不做拾取。
   *
   * @param {object} movement - Cesium MOUSE_MOVE 事件对象，含 endPosition 屏幕坐标
   * @returns {void}
   */
  const handlerMove = (movement) => {
    if (disposed) return;
    if (moveTimer) return;
    moveTimer = window.setTimeout(() => {
      moveTimer = 0;
    }, 32);
    const rec = pickAt(movement.endPosition);
    const nextCode = rec?.code || null;
    if (nextCode === hoverCode) {
      onMove?.(rec ? describeCell(model, rec) : null, movement);
      return;
    }
    // 只维护 hoverCode（供 onMove 去重），不参与着色：hover 高亮未启用，
    // 填充色统一由 displayFill 依 selectedCode 决定（否则取消选中会被 hover 色盖住）。
    hoverCode = nextCode;
    onMove?.(rec ? describeCell(model, rec) : null, movement);
  };

  /**
   * 左键点击回调：命中格在「选中（本格色 alpha=1）」与「未选中（预设网格透明度）」之间切换。
   *
   * 点到另一格时旧格先还原、新格再选中；点到空白处不改状态。选中状态只影响填充色，
   * 框线不受影响。
   *
   * @param {object} click - Cesium LEFT_CLICK 事件对象，含 position 屏幕坐标
   * @returns {void}
   */
  const handlerClick = (click) => {
    if (disposed) return;
    const rec = pickAt(click.position);
    if (!rec) return;
    const prev = selectedCode ? cellRecord(selectedCode) : null;
    selectedCode = rec.code === selectedCode ? null : rec.code;
    if (prev) displayFill(prev); // 取消选中（prev === rec 时即还原本格）
    onClick?.(describeCell(model, rec), click);
    displayFill(rec);
  };
  handler.setInputAction(handlerClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(handlerMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  const handle = {
    viewer,
    collection,
    model,
    cells,
    /**
     * 已写入场景的格数（随填充推进单调增长，重播种不会减少）。
     * @returns {number} 已写入格数
     */
    getLoadedCount: () => cells.size,
    /**
     * 逻辑总格数，即 cols × rows（与是否已写入无关）。
     * @returns {number} 总格数
     */
    getLogicalCount: () => totalCells,
    /**
     * 填充进度。
     * @returns {number} 已写入格数 / 总格数，取值 0~1；totalCells 为 0 时返回 1
     */
    getFillProgress: () => (totalCells ? cells.size / totalCells : 1),
    /**
     * 是否已把全部逻辑格写入完毕（Primitive 路径需所有环产完且 Worker 在途批次归零；
     * 例化路径只需所有环产完）。
     * @returns {boolean} 填充完成返回 true
     */
    isFillDone: () => fillDone,
    /**
     * 当前选中的格编码；未选中时为 null。
     * @returns {string|null} 格编码，形如 `"12,34"`
     */
    getSelectedCode: () => selectedCode,
    stats,
    /**
     * 例化渲染对象（默认模式非空，instancing:false 时为 null），可直接读它的 getStats() 看块数与缓冲字节。
     * @type {object|null}
     */
    instanced,
    /**
     * 打印并返回一次运行期诊断汇总快照。
     *
     * 填充完成时会自动调用一次；也可随时手动调用（例如填完后静置一段时间，
     * 观察 primitiveCount / notReadyPrimitives 是否收敛）来评估调参效果。
     *
     * @returns {object} 计数快照：stats 全部字段 + notReadyPrimitives / avgPumpCostMs / avgPickCostMs
     */
    logStats,
    /**
     * 替换已写入格的填充色（同时更新 baseFillColor，选中态取消后仍还原成这个色）。
     *
     * @param {string} code - 格编码，形如 `"12,34"`
     * @param {string|import('cesium').Color} color - 目标填充色（CSS 颜色串或 Cesium.Color）
     * @returns {boolean} true = 已受理；false = 该格尚未写入
     */
    setCellFillColor(code, color) {
      const rec = cellRecord(code);
      if (!rec) return false;
      rec.baseFillColor = toColor(color, rec.baseFillColor);
      displayFill(rec);
      return true;
    },
    /**
     * 替换已写入格的框线色。
     *
     * @param {string} code - 格编码，形如 `"12,34"`
     * @param {string|import('cesium').Color} color - 目标框线色（CSS 颜色串或 Cesium.Color）
     * @returns {boolean} true = 已受理；false = 该格尚未写入
     */
    setCellOutlineColor(code, color) {
      return setOutline(cellRecord(code), color);
    },
    /**
     * 替换当前已写入全部格的填充色（未写入的格会沿用新的图层默认色）。
     *
     * @param {string|import('cesium').Color} color - 目标填充色（CSS 颜色串或 Cesium.Color）
     * @returns {void}
     */
    setAllFillColor(color) {
      model.fillColor = toColor(color, model.fillColor);
      if (instanced) {
        // 例化路径：GPU 侧每块颜色缓冲整段写一次；CPU 侧直接填颜色镜像数组，不逐格建对象
        instanced.setAllFillColor(model.fillColor);
        cells.fillAll(model.fillColor);
        // 批量写色会把选中格的 alpha=1 高亮一起覆盖掉，这里按选中态补回一次
        if (selectedCode) displayFill(cells.get(selectedCode) || null);
        requestRender();
        return;
      }
      for (const rec of cells.values()) {
        rec.baseFillColor = model.fillColor.clone();
        displayFill(rec);
      }
    },
    /**
     * 替换当前已写入全部格的框线色（未写入的格会沿用新的图层默认色）。
     *
     * @param {string|import('cesium').Color} color - 目标框线色（CSS 颜色串或 Cesium.Color）
     * @returns {void}
     */
    setAllOutlineColor(color) {
      model.outlineColor = toColor(color, model.outlineColor);
      if (instanced) {
        // 例化模式框线由盒面描边从填充色推导，没有独立颜色通道，只同步 CPU 侧镜像
        cells.fillAllOutline(model.outlineColor);
        return;
      }
      for (const rec of cells.values()) setOutline(rec, model.outlineColor);
    },
    /**
     * 按屏幕坐标拾取本图层的格。
     *
     * 与点击/移动回调走同一条拾取路径（数学反算，或 mathPick:false 时的 GPU 拾取），
     * 但只返回描述对象，不改选中状态、不触发回调。入参非法时返回 null。
     *
     * @param {import('cesium').Cartesian2} windowPosition - 屏幕坐标（canvas 像素）
     * @returns {GridCell|null} 命中的格描述；未命中本图层时为 null
     */
    pick(windowPosition) {
      const rec = pickAt(windowPosition);
      return rec ? describeCell(model, rec) : null;
    },
    /**
     * 按经纬度取已写入的格（数学反算，无需屏幕坐标与拾取渲染）。
     *
     * 适合「已知坐标点，想知道落在哪一格」的场景（数据反查、外部表格与网格联动）。
     * 经纬度非法、落在网格范围外、或该格尚未写入时返回 null。
     *
     * @param {number} lng - 经度，单位：度
     * @param {number} lat - 纬度，单位：度
     * @returns {GridCell|null} 格描述；未命中时为 null
     */
    getCellByLngLat(lng, lat) {
      if (!isValidLngLat(lng, lat)) return null;
      const col = Math.floor((Number(lng) - model.originLon) / model.cellSize);
      const row = Math.floor((Number(lat) - model.originLat) / model.cellSize);
      if (col < 0 || col >= model.cols || row < 0 || row >= model.rows) return null;
      const rec = cellRecord(independentGridCellCode(col, row));
      return rec ? describeCell(model, rec) : null;
    },
    /**
     * 显隐整个图层（等价于 handle.collection.show = value，语义更明确）。
     *
     * @param {boolean} visible - true = 显示
     * @returns {void}
     */
    setVisible(visible) {
      collection.show = !!visible;
      requestRender();
    },
    /**
     * 以当前相机中心为种子重新规划填充顺序（手动重播种；已写入格不受影响）。
     * @returns {void}
     */
    refresh: reseedFromCamera,
    /**
     * 原地修改底面高度（z 层切换）：已写入格按原批次逐帧重烘焙，
     * 颜色 / hover / 选中状态保留，不重拉颜色文件、不从中心重新生长。
     *
     * @param {number} newBottomHeight - 底面高度，单位：米（椭球基准）；非有限值、负数或与当前值相同时直接忽略
     * @returns {void}
     */
    setBottomHeight,
    /**
     * 释放本图层：终止 Worker、取消 rAF / 定时器、移除事件监听与 PrimitiveCollection。
     *
     * 幂等，重复调用无副作用；释放后句柄上的其他方法不应再被调用。
     * viewer 销毁时会自动调用，通常无需手动调用。
     *
     * @returns {void}
     */
    dispose: () => destroyIndependentGridLayer(handle),
    disposeViewerHook: null,
    _internal: {
      get disposed() {
        return disposed;
      },
      setDisposed() {
        disposed = true;
      },
      handler,
      get worker() {
        return worker;
      },
      get rafId() {
        return rafId;
      },
      set rafId(value) {
        rafId = value;
      },
      get moveTimer() {
        return moveTimer;
      },
      set moveTimer(value) {
        moveTimer = value;
      },
      get heightRafId() {
        return heightRafId;
      },
      set heightRafId(value) {
        heightRafId = value;
      },
      get heightQueue() {
        return heightQueue;
      },
      set heightQueue(value) {
        heightQueue = value;
      },
      flushDeferredColors,
      onScenePostRender,
      get deferredColors() {
        return deferredColors;
      },
      get readyCallbacks() {
        return readyCallbacks;
      },
    },
  };

  handle.disposeViewerHook = onViewerBeforeDestroy(viewer, () =>
    destroyIndependentGridLayer(handle),
  );
  // postRender 时机：批表就绪后补写延迟登记的实例颜色，并执行就绪回调（旧批延后移除）。
  // 例化路径没有批表、没有 ready 概念，无需这个钩子。
  if (!instanced) viewer.scene.postRender.addEventListener(onScenePostRender);
  // 初始取一次相机中心为种子，开始向外分批填充（此后与相机无关）
  reseedFromCamera();
  return handle;
}

/**
 * 移除独立立体网格并释放 Worker / 事件监听 / Primitive。
 *
 * 幂等：对已释放的句柄重复调用会直接返回。释放后 handle.cells 被清空，
 * 句柄上其余方法不应再被调用。
 *
 * @param {GridLayerHandle|null} handle - createIndependentGridLayer 的返回值；为 null 时不做任何事
 * @returns {void}
 */
export function destroyIndependentGridLayer(handle) {
  if (!handle || handle._internal.disposed) return;
  handle._internal.setDisposed();

  if (typeof handle.disposeViewerHook === 'function') {
    handle.disposeViewerHook();
    handle.disposeViewerHook = null;
  }

  const { viewer } = handle;
  const internal = handle._internal;
  if (internal.rafId) {
    cancelAnimationFrame(internal.rafId);
    internal.rafId = 0;
  }
  if (internal.moveTimer) {
    clearTimeout(internal.moveTimer);
    internal.moveTimer = 0;
  }
  if (internal.heightRafId) {
    cancelAnimationFrame(internal.heightRafId);
    internal.heightRafId = 0;
  }
  internal.heightQueue = [];
  if (internal.worker) {
    try {
      internal.worker.terminate();
    } catch (error) {
      console.warn('[cesium-grid] Worker 终止失败（忽略）', error);
    }
  }

  if (isViewerAlive(viewer)) {
    if (typeof internal.onScenePostRender === 'function') {
      viewer.scene.postRender.removeEventListener(internal.onScenePostRender);
    }
    if (handle.collection && !handle.collection.isDestroyed()) {
      viewer.scene.primitives.remove(handle.collection);
    }
    requestRenderFor(viewer);
  }
  if (internal.deferredColors) internal.deferredColors.clear();
  if (internal.readyCallbacks) internal.readyCallbacks.clear();

  if (internal.handler && !internal.handler.isDestroyed()) {
    internal.handler.destroy();
  }
  handle.cells.clear();
}

/**
 * 释放场景外的重绘请求：dispose 时 viewer 可能已不可用，故与图层内的 requestRender 分开。
 *
 * @param {import('cesium').Viewer} viewer - 目标 Viewer
 * @returns {void}
 */
function requestRenderFor(viewer) {
  if (isViewerAlive(viewer) && viewer.scene.requestRenderMode) {
    viewer.scene.requestRender();
  }
}

/**
 * 创建网格图层（推荐入口）。
 *
 * 与 createIndependentGridLayer 的关系：本函数是**面向使用者的正式入口**，
 * 行为完全一致（校验、默认值、渲染方案切换都在同一处），只是把名字收敛成语义更直接的
 * createGridLayer / destroyGridLayer，并允许通过 presets 覆写渲染方案：
 *
 * - 什么都不传：走默认方案（真实例化 + 盒面描边 + 数学反算拾取），适合绝大多数场景；
 * - `createGridLayer(viewer, opts)`：等价于默认方案；
 * - `createInstancedGridLayer(viewer, opts)`：显式声明走例化方案（与默认一致，用于自文档化）；
 * - `createPrimitiveGridLayer(viewer, opts)`：退回 Primitive 方案（每格烘焙 modelMatrix），
 *   适合需要逐格独立框线色相、或需要 GPU 拾取（mathPick:false）的场景。
 *
 * 调用方传入的显式选项**优先于**预设：预设只填「调用方没写」的字段。
 *
 * @param {import('cesium').Viewer} viewer - Cesium Viewer；不可用时返回 null
 * @param {object} [options={}] - 网格配置，详见 README 选项表
 * @param {object} [preset={}] - 预设方案（由下面三个入口传入），优先级低于 options
 * @returns {GridLayerHandle|null} 图层句柄；viewer 不可用时为 null
 */
export function createGridLayer(viewer, options = {}, preset = {}) {
  const merged = { ...preset, ...(options && typeof options === 'object' ? options : {}) };
  return createIndependentGridLayer(viewer, merged);
}

/**
 * 创建网格图层（显式例化方案预设）。
 *
 * 一份单位盒几何被所有格共享，每格只上传 3×4 矩阵（48 B）+ RGBA8 颜色（4 B）= 52 B，
 * 逐格变换在顶点着色器完成；写入下一帧即渲染，无几何构建与 ready 等待。
 * 这是默认方案，单独提供一个入口是为了让「我明确要例化路径」这件事在代码里可读。
 *
 * 限制：框线固定走盒面描边，描边色只能取本格填充色 RGB（无法独立设色相）；
 * 整层共用一个 pickId，故 mathPick 必须为 true（GPU 拾取拿不到实例 id）。
 *
 * @param {import('cesium').Viewer} viewer - Cesium Viewer
 * @param {object} [options={}] - 网格配置
 * @returns {GridLayerHandle|null} 图层句柄
 */
export function createInstancedGridLayer(viewer, options = {}) {
  return createGridLayer(viewer, options, { instancing: true, mathPick: true });
}

/**
 * 创建网格图层（Primitive 方案预设，显式降级路径）。
 *
 * 每格把 modelMatrix 烘焙进顶点，靠 combineGeometry 生成静态 VBO：每格约 1440 B 显存、
 * 每批 2 个 Primitive，几何构建异步（有 ready 等待与延迟补写）。代价明显，但换来两个能力：
 * 框线可用**独立色相**（outlineColor 生效），以及可走 **GPU 拾取**（mathPick:false）。
 *
 * 何时用：柱体很高或视角极斜、数学反算的椭球偏差不可接受时（见 pickCellByMath 注释）；
 * 或业务要求框线与填充不同色相时。
 *
 * @param {import('cesium').Viewer} viewer - Cesium Viewer
 * @param {object} [options={}] - 网格配置
 * @returns {GridLayerHandle|null} 图层句柄
 */
export function createPrimitiveGridLayer(viewer, options = {}) {
  return createGridLayer(viewer, options, {
    instancing: false,
    edgeShader: false,
    outline: true,
  });
}

/**
 * @typedef {object} GridCell
 * @property {string} code - 格编码，形如 `"12,34"`
 * @property {number} col - 列号（0 起）
 * @property {number} row - 行号（0 起）
 * @property {number} west - 西边界经度，单位：度
 * @property {number} south - 南边界纬度，单位：度
 * @property {number} east - 东边界经度，单位：度
 * @property {number} north - 北边界纬度，单位：度
 * @property {number} centerLon - 格中心经度，单位：度
 * @property {number} centerLat - 格中心纬度，单位：度
 * @property {import('cesium').Color} fillColor - 当前填充色
 * @property {import('cesium').Color} outlineColor - 当前框线色
 */

/**
 * @typedef {object} GridLayerHandle
 * @property {import('cesium').Viewer} viewer - 所属 Viewer
 * @property {import('cesium').PrimitiveCollection} collection - 承载全部批次的集合，dispose 时整体移除；其 show 属性可切换显隐
 * @property {object} model - 生效后的网格参数（默认值已填充，颜色字段为 Cesium.Color 实例）
 * @property {object} cells - 已写入格索引，提供 size / has / get / values / clear
 * @property {object|null} instanced - 例化渲染对象（默认模式非空，instancing:false 时为 null），其 getStats() 给块数与缓冲字节
 * @property {() => number} getLoadedCount - 已写入场景的格数
 * @property {() => number} getLogicalCount - 逻辑总格数 cols × rows
 * @property {() => number} getFillProgress - 填充进度，取值 0~1
 * @property {() => boolean} isFillDone - 是否已把全部逻辑格写入完毕
 * @property {() => string|null} getSelectedCode - 当前选中格编码
 * @property {object} stats - 运行期诊断计数（累计值，重播种不清零）
 * @property {() => object} logStats - 打印并返回一次诊断汇总快照
 * @property {(code: string, color: string|import('cesium').Color) => boolean} setCellFillColor - 改单格填充色并同步 baseFillColor；格不存在返回 false
 * @property {(code: string, color: string|import('cesium').Color) => boolean} setCellOutlineColor - 改单格框线色；格不存在返回 false
 * @property {(color: string|import('cesium').Color) => void} setAllFillColor - 改已写入全部格的填充色
 * @property {(color: string|import('cesium').Color) => void} setAllOutlineColor - 改已写入全部格的框线色
 * @property {(windowPosition: import('cesium').Cartesian2) => GridCell|null} pick - 按屏幕坐标拾取本图层格；未命中返回 null
 * @property {(lng: number, lat: number) => GridCell|null} getCellByLngLat - 按经纬度取已写入的格
 * @property {(visible: boolean) => void} setVisible - 显隐整个图层
 * @property {() => void} refresh - 以当前相机中心重播种填充顺序，已写入格不受影响
 * @property {(newBottomHeight: number) => void} setBottomHeight - 原地改底面高度（米），已写入格按原批次逐帧重烘焙
 * @property {() => void} dispose - 释放 Worker / 事件监听 / Primitive
 */
