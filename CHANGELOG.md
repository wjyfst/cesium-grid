# Changelog

本文件记录本包的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-18

首个版本。

### 新增

- **`src/index.js` 统一入口**：主入口（`createGridLayer` / `destroyGridLayer`）、纯计算、高级渲染层三层导出。
- **预设入口** `createInstancedGridLayer` / `createPrimitiveGridLayer`，把渲染方案的取舍显式化。
- **`src/index.d.ts` / `src/gridMath.d.ts`** 手写类型声明，覆盖全部对外 API。
- **`src/viewerLifecycle.js`**：viewer 生命周期工具，含 **`viewer.destroy` 包装**——消费者按
  Cesium 官方方式销毁 viewer 时图层自动回收，无需额外 API。缺了这层包装，消费者就得自己记住
  调用 `dispose`，漏调会造成 WebGL 上下文与事件监听泄漏（浏览器有 WebGL 上下文数量上限，
  泄漏会报 `Too many active WebGL contexts`）。
- **`src/workerFactory.js`**：四层 Worker 解析链（`workerFactory` → 全局注入 → 内置
  `new URL(...)` → 主线程回退），不依赖任何打包器专有语法，Vite / Webpack / Rspack / 原生 ESM
  下都能工作。
- **`src/defaults.js`**：选项归一化集中到一处（`normalizeGridOptions`），默认值只有一处定义，
  README 选项表不会与代码漂移。
- **`src/gridMath.js` 导出**：`parseCellCode`、`isValidLngLat`、`createRingFill`。
- **句柄方法**：`getCellByLngLat(lng, lat)`（按经纬度取已写入的格）、`getSelectedCode()`、
  `setVisible(visible)`、`dispose` 的别名 `destroyGridLayer`。
- **`cell` 对象含 `centerLon` / `centerLat`**。
- **测试**：110 个 vitest 用例，覆盖矩阵数学、方环填充、选项校验、生命周期、Worker 回退与崩溃
  恢复、例化层 draw call 与 GPU 资源所有权。
- **`@wjyfst/cesium-grid/math` 子路径**：只导出纯计算模块、不 import `cesium`，因此可以在裸 Node
  里直接使用（数据预处理、预计算矩阵）。主入口在裸 Node 下无法加载——Cesium 自身的 ESM 产物在
  Node 下解析失败，与本包无关。

### 修复

- **Worker 崩溃导致填充永久卡住**：`postMessage` 时 `packed.buffer` 被 transfer 给 Worker，
  主线程侧数组随即 detach 不可读；Worker 一旦报错，这批已从填充器消费掉的格就永久丢失，
  表现为「填充进度卡在某个百分比再也不动」且没有任何报错。现在在途批次会在主线程留一份副本，
  Worker 出错时把这些格抢回主线程计算。
- **格编码解析把 `"12,"` 解析成 `(12, 0)`**：`Number('')` 是 `0` 而不是 `NaN`，只做 `Number`
  转换的话非法编码会**静默命中一个完全无关的格**。现在显式挡掉空串段，非法编码返回 `null`。
- **例化路径重复下发同一格会撑大 `stats.writtenCells`**：重复格的颜色本就会重写（正确行为），
  但计数不应重复累加，否则诊断数据与实际已写入格数不符。

### 变更

- 格数告警阈值 `TOTAL_CELLS_WARN_THRESHOLD` 由 `1e8` 上调为 `1e9`：本包定位是亿级网格，
  阈值定在 1 亿会把正常用法标成异常。
- 模块内所有 `console` 日志前缀统一为 `[cesium-grid]`，与包名一致。
- 非法 `originLon` / `originLat` 由「静默回退默认值」改为「回退 + `console.warn`」——
  静默回退下写错经纬度只会看到网格跑到别处，很难定位。

### 兼容性

- `cesium` 为 peer dependency，区间 `>=1.110.0 <2.0.0`；开发与验证版本 `1.143.0`。
- 本包使用 Cesium 渲染器层内部 API（`Buffer` / `VertexArray` / `DrawCommand` /
  `ShaderProgram` / `RenderState` / `Context.createPickId`），升级 Cesium 大版本前请先跑通
  README 的手工验证清单。
