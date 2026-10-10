# 跨语言固定向量

本目录保存**三端必须逐字节一致**的协议向量。它们不是「示例数据」，而是防漂移的验收基准：
Node / Go / Worker 的测试都会**读取同一份文件并各自复算**，任何一端改了拼接顺序、分隔符、
base64url 填充或字段顺序，都会立刻在测试里暴露。

## 文件

### `verify-v2.json`

协议 v2 的全部签名与派生口径。由 `nodejs/scripts/gen-verify-vectors.ts` 生成。

| 字段 | 用途 |
| --- | --- |
| `ipHash` | `hex(SHA256("ip:" + secret + ":" + ip))[:16]` |
| `honeypot` | `"v_" + hex(SHA256("hp:" + secret + ":" + slug))[:10]` |
| `challengePayloadJson` / `prefix` / `sig` | 挑战载荷的**字段顺序**（`v / cid / iph / slug / iat`）与 `base64url(HMAC-SHA256(prefix, secret))`。`slug` 是被签名的，挑战因此绑定到该文章 —— 换文章兑换必须被拒（`slug mismatch`） |
| `hashwx.{c,d,n,count}` | 第一层挑战派生：`c = SHA256("hashwx:C:" + secret + ":" + cid)`，以及该难度下的子挑战参数 |
| `instrumentation.{seed,ops,regs}` | 第二层：程序派生种子、下发给客户端的程序、服务端影子模型推算出的期望寄存器 |
| `ticketPayloadJson` / `ticketBody` / `ticketSig` | 票据载荷的**字段顺序**与签名 |

### `instrumentation-v2.json`

第二层程序的解释器语义。由 `nodejs/scripts/gen-instr-vectors.ts` 生成。

服务端用「影子 DOM 模型」推算寄存器，前端用真实 DOM 执行同一段程序 —— 两个解释器必须逐位等价，
否则所有访客都会被判成「程序结果不匹配」。这份 fixture 的三个向量**覆盖全部 24 个操作码**，
Node 与前端测试分别复算：

- Node：`nodejs/test/utils.instrumentation.test.ts`
- 前端：`frontend/tests/instrumentation.test.js`

> `verify-v2.json` 的第一个 `cid` 与 `instrumentation-v2.json` 的第一个向量是同一个挑战，
> 两份 fixture 会互相印证（同一 `(secret, cid)` 必然得到同一程序）。

### `sanitize-v2.json`

文章标识（`post_slug`）的**净化与截断**口径。由 `nodejs/scripts/gen-sanitize-vectors.ts` 生成。

`post_slug` 会被签进挑战载荷，三端只要净化或截断口径有一点差异，就会出现「同一篇文章的挑战兑换自己的票据却被拒」
或「签出的票据永远兑不掉」的假失败。因此这份 fixture 覆盖：

- **净化规则**：script/style 块、事件处理器属性、`javascript:`/`vbscript:` 属性的三种引号形式、
  独立的 `javascript:`/`vbscript:` 文本、危险标签（含「普通文章标识必须是无操作路径」这类反例）。
- **截断边界**：`maxPostSlug` 的单位是 **Unicode 码点**，不是 UTF-16 码元、也不是字节。
  含 `199 个 ASCII + 1 个 emoji`（200 码点 / 201 码元）这类专门用来暴露口径差异的用例 ——
  按 UTF-16 码元切会切出孤立代理项，按字节切会把多字节字符切成非法 UTF-8。

三端各自复算并额外断言不变式（码点数不超上限、结果是合法 UTF-8 / 不含孤立代理项）。

> 严格来说这份 fixture 覆盖的是 Node / Go / Worker 的**服务端**净化的口径（前端不发 post_slug 的净化副本，它只把同一个原始 slug 同时发给两个端点）。

### `spam-v1.json`

评论**审核自动化（垃圾规则）**的判定口径。审核结果决定评论是「直接通过」还是「转入待审核」，
三端只要有一端算错（例如按字节而不是按码点数长度、把 `https://www.` 数成两个链接、
或把「阈值 0」理解成「一律拦截」），同一条评论就会在不同部署形态下得到不同状态。因此这份 fixture 覆盖：

- **关键词解析**：坏 JSON / 非数组 / 混入非字符串元素时的容错（fail-open），以及去空白、转小写；
- **数值配置**：非负整数才采用，超上限夹取，其余（负数、小数、带单位）退回默认值；`0` = 不启用该规则；
- **链接统计**：`http(s)://` 与裸 `www.` 的计数与去重、Markdown 链接、大小写不敏感；
- **规则判定**：正文 / 昵称 / 个人网址命中关键词、链接数（含个人网址字段计 1）、
  正文长度（按 **Unicode 码点**，`👍` 与 `𝄞` 都算一个字符）以及**规则优先级**（关键词 → 链接数 → 长度）；
- **后台设置校验**：四项阈值的合法区间与错误口径（三端返回同样的 400 文案）。

三端各自复算：Node `nodejs/test/vectors.spam-v1.test.ts`、Go `go/internal/pkg/utils/spam_vectors_test.go`、
Worker `worker/test/unit/vectors.spam-v1.test.ts`。

> 「同 IP 时间窗内重复内容」需要数据库查询，无法在纯函数向量里覆盖，
> 由三端的接口/单元测试各自验证（`test/api.comments.test.ts`、`comment_test.go`、`test/api/comments.post.test.ts`）。

## 重新生成

**只有在有意修改协议时才需要重新生成**，并且必须同步更新所有语言的测试与 `doc/api.md`：

```bash
cd nodejs
npx ts-node scripts/gen-instr-vectors.ts
npx ts-node scripts/gen-verify-vectors.ts
npx ts-node scripts/gen-sanitize-vectors.ts
```

脚本会打印全部生成值，便于人工核对。生成口径刻意在脚本里**独立复算**（而不是调用实现内部的私有函数），
这样 fixture 同时也是一次对实现口径的独立复核。

## 注意

- 这些文件是**测试专用**产物，不参与运行时；发布压缩包里不包含 `doc/`，因此从发布包解出的单个后端目录跑测试时会找不到 fixture（测试前请使用完整仓库）。
- 修改 fixture 而不修改对应实现，会让测试失败 —— 这是设计意图，不要为了「让测试变绿」而降低断言强度。
