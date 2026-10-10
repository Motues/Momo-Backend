/**
 * wrangler 的 CompiledWasm 模块规则：`import module from './x.wasm'` 直接得到
 * 一个已编译的 WebAssembly.Module（而不是字节数组）。
 *
 * 之所以必须静态导入：workerd **禁止运行时编译 WASM**，
 * `new WebAssembly.Module(bytes)` / `WebAssembly.compile()` 会抛
 * `CompileError: Wasm code generation disallowed by embedder`；
 * 只有 wrangler 在构建期编译好的模块才能用 `new WebAssembly.Instance(module)` 实例化。
 *
 * 这里只补 TypeScript 的类型声明；实际的模块规则由 wrangler 提供。
 */
declare module "*.wasm" {
	const module: WebAssembly.Module;
	export default module;
}
