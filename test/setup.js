/**
 * vitest 全局初始化：安装 rAF / window 替身，并静音被测代码的预期内告警。
 *
 * 只做「环境补齐」，不做任何断言或 mock —— mock 一律放在各测试文件里显式声明，
 * 保证读一个测试文件就能知道它到底依赖了什么。
 */

import { beforeEach, afterEach } from 'vitest';
import { installRaf, resetRaf } from './helpers/raf.js';

installRaf();

beforeEach(() => {
  resetRaf();
});

afterEach(() => {
  resetRaf();
});
