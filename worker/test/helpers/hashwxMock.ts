/**
 * 全局测试替身注入：把 `src/utils/hashwx.ts` 整体换成本仓库的纯 JS 替身。
 *
 * 背景（详见 test/stubs/hashwx.ts 的说明与 vitest.config.mts 的注释）：
 * 生产代码用静态导入 `../../vendor/hashwx.wasm` 拿到已经编译好的 WebAssembly.Module
 * （workerd 禁止运行时编译 WASM），但 vitest-pool-workers 在本地无法解析 .wasm 模块。
 * 于是所有测试（包括只间接 import 到 verify.ts 的 API 测试，例如
 * test/api/comments.post.test.ts → src/index.ts → utils/verify.ts）都通过这个 setup file
 * 拿到替身，从而能加载整个应用模块图。
 *
 * 真实 .wasm 路径由 wrangler 运行时验证（`npx wrangler dev`），单元测试不覆盖。
 */
import { vi } from 'vitest';

vi.mock('../../src/utils/hashwx', () => import('../stubs/hashwx'));
