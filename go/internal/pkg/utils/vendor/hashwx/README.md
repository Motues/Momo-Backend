# HashWX vendored 资产（Go）

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

因为本仓库没有 Emscripten 工具链、无法独立重建，所以**二进制真实性由已知答案测试（KAT）保证**：
`internal/pkg/utils/hashwx_test.go` 用上游 `src/tests.c` 的官方测试向量校验本模块
（`seed1 = "This is a test seed for hashwx"` 等 4 个向量必须全部吻合）。

## 在 Go 里怎么用

`internal/pkg/utils/hashwx.go` 用 `//go:embed vendor/hashwx/hashwx.wasm` 嵌入本目录的二进制，
通过 **wazero**（纯 Go 的 WebAssembly 运行时，不依赖 CGO，不影响 `CGO_ENABLED=0` 构建）实例化，
并且只使用**解释模式**（`hashwx_alloc(0)`）—— 服务端每次校验只做一次哈希，解释模式省掉 JIT 开销。

### 为什么放在包目录下的 `vendor/` 而不是模块根

- `//go:embed` 只能引用包目录（含子目录）下的文件，不能跨到模块根；
- 而 Go 会把**模块根**的 `vendor/` 目录当作 vendor 模式开关（缺少 `vendor/modules.txt` 时会直接报
  `inconsistent vendoring`），所以不能放在 `go/vendor/`。

## 升级步骤

1. 替换本目录的 `hashwx.wasm` 与 `hashwx-COMMIT.txt`（四处同步替换，保持 sha256 一致）；
2. 更新本 README 的 sha256；
3. 跑 `go test ./internal/pkg/utils/ -run Hashwx -count=1`，确认官方 KAT 仍然全部吻合。

## 许可证注意事项

- HashWX 的 wasm 二进制以 **LGPL-3.0** 分发，本项目通过 `//go:embed` 嵌入到 Go 二进制中。
- tevador 官方提供的浏览器 glue `js/hashwx.js` 由作者声明为**公有领域**；Go 端不使用它。
- 分发本项目产物（含 release 压缩包与二进制）时，必须同时保留 `hashwx-LICENSE.txt` 与本节说明。
