# HashWX vendored 资产（Cloudflare Worker）

本目录保存第一层工作量证明所用的 HashWX WebAssembly 模块。**该模块不是本项目编写的代码**，
其许可证与本项目（MIT）不同，请勿删除本目录下的许可证文本。

## 上游来源

| 项目 | 值 |
|---|---|
| 上游仓库 | https://github.com/tevador/hashwx |
| 上游版本 | v1.0.0（tag 指向 commit `74b567a31276a4c5d7cb232a5b7639467f49f961`） |
| 许可证 | **LGPL-3.0**（完整文本见 `hashwx-LICENSE.txt`） |
| 构件体积 | 12,541 字节 |
| 构件 sha256 | `b1a0dbb3ef444d3c7069e0a5e0a0273ffa4cf8fef62cbbe43761c02f7cd6aff5` |
| 构建方式 | 上游 Emscripten 构建，降级到 WebAssembly 1.0（MVP） |

四处（nodejs / go / worker / frontend）各保留一份**逐字节相同**的构件，sha256 必须与本表一致。

### 构件链说明

上游仓库与 v1.0.0 release **不提供预编译的 `hashwx.wasm`**，只提供 C 源码（`src/compiler_wasm.c` 等）。
本目录的二进制取自同为 WebAssembly 用途的 Cap 项目（`tiagozip/cap`，Apache-2.0）的
`core/vendor/hashwx.wasm`，其 `core/vendor/hashwx-COMMIT.txt` 固定的上游 commit 与本目录一致，
即该二进制同样构建自 tevador/hashwx v1.0.0。

因为本仓库没有 Emscripten 工具链、无法独立重建，所以**二进制真实性由已知答案测试（KAT）保证**，
而 Worker 侧无法在本地测试环境里跑这个 KAT（原因见下），因此它是**共用** Node 侧对同一份二进制的
KAT 结论：`nodejs/test/utils.hashwx.test.ts`。

## 在 Worker 里怎么用（与 Node 不同，这是被迫的）

**workerd 禁止运行时编译 WebAssembly**：`new WebAssembly.Module(bytes)` / `WebAssembly.compile()`
会抛 `CompileError: Wasm code generation disallowed by embedder`，所以 **Worker 不能用 Node 那种
base64 内联**，只能让 wrangler 在打包时按 `CompiledWasm` 规则静态导入：

```ts
import hashwxModule from '../../vendor/hashwx.wasm'; // 得到已编译好的 WebAssembly.Module
```

`src/utils/hashwx.ts` 于是直接 `new WebAssembly.Instance(hashwxModule, {})`，同样只用**解释模式**
（`hashwx_alloc(0)`）。**请不要把 `.wasm` 改回 base64 内联**，那在 workerd 上必然失败。

> 顺带一个好处：`.wasm` 保持为独立文件，比内联进 JS 更符合 LGPL 对「可替换」的要求。

### 为什么测试里要替身

`vitest-pool-workers` 在本地**无法解析 `.wasm` 模块**（相对 specifier 会被解析到
`node_modules/.pnpm/vite-node@.../node_modules/vite-node/` 下，报
`No such module ".../vite-node/vendor/hashwx.wasm?mf_vitest_force=CompiledWasm"`；
试过在 `vitest.config.mts` 里按完整 specifier 精确 alias、也试过换 bare specifier，均无效）。

因此测试用 `vi.mock` 把 `src/utils/hashwx.ts` 整体替换为纯 JS 替身
（`test/stubs/hashwx.ts`，由 `test/helpers/hashwxMock.ts` 经 `setupFiles` 注入）。
替身只替换「哈希原语」，导出面、种子派生公式与真实实现完全一致，所以 `verify.ts` 的协议测试
测的仍是真实协议逻辑。**改动 HashWX 接入方式时，请务必用 `npx wrangler dev` 做一次真实的端到端验证**，
这是唯一能覆盖真实 `.wasm` 路径的手段。

## 升级步骤

1. 替换本目录的 `hashwx.wasm` 与 `hashwx-COMMIT.txt`（四处同步替换，保持 sha256 一致）；
2. 更新本 README 的 sha256；
3. 跑 Node 侧的官方 KAT（`cd nodejs && npx vitest run test/utils.hashwx.test.ts`）；
4. 用 `npx wrangler dev` 走一次 `/api/verify/challenge` → `/api/verify/solution`，确认票据能拿到。

## 许可证注意事项

- HashWX 的 wasm 二进制以 **LGPL-3.0** 分发，由 wrangler 作为独立模块打包进 Worker 产物。
- tevador 官方提供的浏览器 glue `js/hashwx.js` 由作者声明为**公有领域**；Worker 端不使用它。
- 分发本项目产物（含 release 压缩包）时，必须同时保留 `hashwx-LICENSE.txt` 与本节说明。
