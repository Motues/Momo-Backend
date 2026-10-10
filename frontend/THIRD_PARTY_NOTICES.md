# 第三方组件声明

本项目（`@motues/momo-comment`）以 MIT 许可证发布，但下列第三方组件以其它许可证分发。

## HashWX

| 项目 | 值 |
|---|---|
| 组件 | HashWX（`hashwx.wasm`） |
| 上游 | https://github.com/tevador/hashwx |
| 版本 | v1.0.0（commit `74b567a31276a4c5d7cb232a5b7639467f49f961`） |
| 许可证 | **LGPL-3.0** |
| 许可证全文 | [`vendor/hashwx/hashwx-LICENSE.txt`](./vendor/hashwx/hashwx-LICENSE.txt) |
| 构件 sha256 | `b1a0dbb3ef444d3c7069e0a5e0a0273ffa4cf8fef62cbbe43761c02f7cd6aff5` |
| 用途 | 评论人机验证的第一层工作量证明（Proof of Work） |

该组件是**未经修改的上游构建产物**，以 base64 形式内联在 `src/verify/hashwxWasm.ts`（进而进入
`dist/momo-comment.min.js`）。选材与验证细节见 [`vendor/hashwx/README.md`](./vendor/hashwx/README.md)：
上游不提供预编译产物，因此其真实性由上游 `src/tests.c` 的官方已知答案测试保证
（`tests/hashwx.test.js`）。

如需替换该组件，可自行构建 `hashwx.wasm` 后执行 `node scripts/vendor-hashwx.js` 重新生成内联模块；
构建与替换步骤见上述 README。
