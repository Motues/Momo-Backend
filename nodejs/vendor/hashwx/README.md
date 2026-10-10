# HashWX vendored 资产

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

### 构件链说明

上游仓库与 v1.0.0 release **不提供预编译的 `hashwx.wasm`**，只提供 C 源码（`src/compiler_wasm.c` 等）。
本目录的二进制取自同为 WebAssembly 用途的 Cap 项目（`tiagozip/cap`，Apache-2.0）的
`core/vendor/hashwx.wasm`，其 `core/vendor/hashwx-COMMIT.txt` 固定的上游 commit 与本目录一致，
即该二进制同样构建自 tevador/hashwx v1.0.0。

因为本仓库没有 Emscripten 工具链、无法独立重建，所以**二进制真实性由已知答案测试（KAT）保证**，
而不是由构建过程保证，见下节。

## 真实性验证（KAT）

`nodejs/test/utils.hashwx.test.ts` 用上游 `src/tests.c` 中的官方测试向量校验本模块：

```
seed1 = "This is a test seed for hashwx"（补 NUL 到 32 字节）
seed2 = "Lorem ipsum dolor sit amet"（补 NUL 到 32 字节）

seed1 + counter=0                  -> 0x973684176f8ee362
seed1 + counter=123456             -> 0x401983bb07d69b07
seed2 + counter=123456             -> 0x4af38d834a9a8d3d
seed2 + counter=987654321123456789 -> 0x6a8a5514432e17a3
```

四个向量全部吻合才能说明这个二进制确实实现了官方算法。同时测试还会交叉校验
interpreted 与 compiled 两种模式的结果一致。

## 生成内联模块

`src/utils/hashwxWasm.ts` 由脚本生成，不要手工编辑：

```bash
node scripts/vendor-hashwx.js
```

脚本会校验二进制 sha256 与上表一致，然后写入 base64 常量。升级上游版本时必须同时更新
`hashwx-COMMIT.txt`、本 README 的 sha256 与 `src/utils/hashwxWasm.ts` 的头注释。

## 许可证注意事项

- HashWX 的 wasm 二进制以 **LGPL-3.0** 分发，本项目通过 base64 内联到 `src/utils/hashwxWasm.ts`。
- tevador 官方提供的浏览器 glue `js/hashwx.js` 由作者声明为**公有领域**，本项目按其机制自行实现，
  不引入额外许可义务。
- 分发本项目产物（含 release 压缩包）时，必须同时保留 `hashwx-LICENSE.txt` 与本节说明。
