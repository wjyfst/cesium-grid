import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    // Cesium 的真实模块在 Node 下会触碰 DOM / WebGL，故 gridLayer 系列测试一律 vi.mock('cesium')；
    // 纯计算测试（gridMath）使用真实模块，不 mock。
    restoreMocks: true,
  },
});
