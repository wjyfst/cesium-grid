/**
 * 打包冒烟验证脚本（不依赖浏览器 / WebGL）。
 *
 * 用途：把「本包能否被真实打包器消费」这件事变成一条可重复执行的命令，覆盖两个最容易
 * 在发布后才暴露、且单测无法发现的问题：
 *
 * 1. **exports 映射**：`@wjyfst/cesium-grid` 与 `@wjyfst/cesium-grid/math` 能否被解析；
 * 2. **Worker 资源**：内置的 `new Worker(new URL('./gridMatrix.worker.js', import.meta.url))`
 *    能否被打包器静态识别并产出独立 chunk，且主 bundle 里确实引用了该 chunk。
 *
 * 为什么单测覆盖不到：vitest 里 `cesium` 被 mock 掉、`createGridWorker` 走注入分支，
 * 内置 worker 的打包路径完全不参与。这条路径一旦坏了，用户装完包会看到 worker 404，
 * 而功能会静默回退主线程（不报错、只是主线程卡）——很难定位。
 *
 * 实现方式：临时目录里生成一个最小 Vite 应用（用 file: 依赖指向本包），跑 `vite build`，
 * 然后断言产物里存在 worker chunk 与 `new Worker(...)` 引用。结束后清理临时目录。
 *
 * 用法：node scripts/verify-pack.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const smokeRoot = join(dirname(packageRoot), 'cesium-grid-smoke-verify');

/**
 * 构建产物中必须出现的标记（证明包代码真的进了产物，而不是被 tree-shake 掉）。
 *
 * 只挑**字符串字面量**：函数名会被压缩器重命名（`createGridLayer` → 短名），
 * 用函数名做断言会在压缩后误报失败。
 */
const REQUIRED_MARKERS = [
  'czm_pickColor', // 例化层片元着色器里的拾取 uniform
  'instanceTransform', // 例化层顶点着色器里的局部变量名（GLSL 不被压缩）
  'a_instanceRow0', // 实例属性名，同时出现在 VertexArray 与着色器里
  '[cesium-grid]', // 本包的日志前缀，证明 gridLayer 模块真的被打进来
  'getCellColor', // 逐格取色分支
];

/**
 * 执行一条命令，失败时抛出带输出的错误。
 *
 * @param {string} command - 可执行文件
 * @param {string[]} args - 参数
 * @param {string} cwd - 工作目录
 * @returns {string} 标准输出
 */
function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

/**
 * 断言条件成立，否则抛错。
 *
 * @param {boolean} condition - 条件
 * @param {string} message - 失败信息
 * @returns {void}
 */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

/**
 * 递归收集目录下全部文件路径。
 *
 * @param {string} dir - 目录
 * @returns {string[]} 文件绝对路径
 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** 生成最小 Vite 应用文件 */
function writeSmokeApp() {
  mkdirSync(join(smokeRoot, 'src'), { recursive: true });
  writeFileSync(
    join(smokeRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'cesium-grid-pack-verify',
        private: true,
        version: '0.0.0',
        type: 'module',
        dependencies: {
          '@wjyfst/cesium-grid': `file:${packageRoot.replace(/\\/g, '/')}`,
          cesium: '1.143.0',
        },
        devDependencies: { vite: '^7.1.0' },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(smokeRoot, 'index.html'),
    '<!doctype html><html><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>',
  );
  // 关键：在模块顶层就调用建层逻辑，否则打包器会把整个包 tree-shake 掉，
  // 构建虽然「成功」却什么都没验证。
  writeFileSync(
    join(smokeRoot, 'src', 'main.js'),
    `import * as Cesium from 'cesium';
import {
  createGridLayer,
  createPrimitiveGridLayer,
  destroyGridLayer,
  createGridWorker,
  parseCellCode,
  packCellsMatrices,
  createRingFill,
} from '@wjyfst/cesium-grid';
import { writeCellModelMatrix } from '@wjyfst/cesium-grid/math';

const MODEL = { originLon: 116, originLat: 39, cellSize: 0.01, bottomHeight: 0, gridHeight: 30 };
const fill = createRingFill(0, 0, 2, 2);
const packed = fill.nextBatch(8);
export const math = {
  code: parseCellCode('1,2'),
  matrices: packCellsMatrices(packed, MODEL).length,
  single: writeCellModelMatrix(0, 0, MODEL).length,
};
// 触发内置 worker 解析（会走 new Worker(new URL(...)) 分支）
export const worker = createGridWorker({});

export function bootstrap() {
  const viewer = new Cesium.Viewer('app', { animation: false, timeline: false, baseLayerPicker: false });
  viewer.scene.requestRenderMode = true;
  const handle = createGridLayer(viewer, {
    originLon: 115.8, originLat: 23.5, cols: 16, rows: 16, cellSize: 0.01,
    layerType: 'verify', getCellColor: () => null,
  });
  const legacy = createPrimitiveGridLayer(viewer, {
    originLon: 116, originLat: 39, cols: 8, rows: 8, cellSize: 0.01, mathPick: false,
  });
  handle.setCellFillColor('0,0', '#FFFFFF');
  handle.setBottomHeight(300);
  destroyGridLayer(legacy);
  destroyGridLayer(handle);
  return { handle, legacy };
}

try { bootstrap(); } catch (error) { console.error('[verify] bootstrap 失败', error); }
`,
  );
}

/** 主流程 */
function main() {
  if (existsSync(smokeRoot)) rmSync(smokeRoot, { recursive: true, force: true });
  writeSmokeApp();

  console.log(`[verify-pack] 临时应用：${smokeRoot}`);
  console.log('[verify-pack] npm install ...');
  run('npm', ['install', '--silent', '--no-audit', '--no-fund'], smokeRoot);

  console.log('[verify-pack] vite build ...');
  const buildOutput = run('npx', ['vite', 'build'], smokeRoot);

  const assetsDir = join(smokeRoot, 'dist', 'assets');
  const files = walk(assetsDir);
  /** 取文件名（walk 返回绝对路径，正则一律针对 basename 匹配） */
  const baseName = (file) => file.split(/[\\/]/).pop();
  const workerFile = files.find((file) => /^gridMatrix\.worker-.*\.js$/.test(baseName(file)));
  assert(!!workerFile, '构建产物里没有 gridMatrix.worker 独立 chunk（内置 Worker 未被识别）');

  const workerSource = readFileSync(workerFile, 'utf8');
  assert(
    workerSource.includes('cellSize') && workerSource.includes('bottomHeight'),
    'worker chunk 内容不像矩阵计算代码',
  );

  const mainFile = files.find((file) => /^index-.*\.js$/.test(baseName(file)));
  assert(!!mainFile, '构建产物里没有主 bundle');
  const mainSource = readFileSync(mainFile, 'utf8');

  assert(
    /new Worker\(new URL\("\/assets\/gridMatrix\.worker-[^"]+\.js",\s*import\.meta\.url\)/.test(
      mainSource,
    ),
    '主 bundle 里没有 new Worker(new URL(".../gridMatrix.worker-*.js", import.meta.url)) 引用',
  );
  for (const marker of REQUIRED_MARKERS) {
    assert(mainSource.includes(marker), `主 bundle 缺少标记 "${marker}"（可能被 tree-shake 掉了）`);
  }

  console.log('[verify-pack] 通过：');
  console.log('  - exports 映射：主入口 + /math 子路径均解析成功');
  console.log(`  - worker chunk：${baseName(workerFile)}（${workerSource.length} B）`);
  console.log(`  - 主 bundle：${baseName(mainFile)}（${mainSource.length} B）`);
  console.log(`  - 标记齐全：${REQUIRED_MARKERS.join(', ')}`);
  if (buildOutput.trim()) console.log(buildOutput.trim().split('\n').slice(-4).join('\n'));

  rmSync(smokeRoot, { recursive: true, force: true });
  console.log('[verify-pack] 临时目录已清理');
}

try {
  main();
} catch (error) {
  console.error(`[verify-pack] 失败：${error.message}`);
  console.error(`[verify-pack] 临时目录保留在 ${smokeRoot} 以便排查`);
  process.exitCode = 1;
}
