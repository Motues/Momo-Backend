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
| `originHash` | 来源域名哈希：`hex(SHA256("org:" + secret + ":" + 来源))[:16]` |
| `challengePayloadJsonLocked` / `prefixLocked` / `sigLocked` | 开启来源域名绑定后的挑战载荷：`org` **追加在末尾**（`v / cid / iph / slug / iat / org`）。插在中间会让同一份挑战在两端得到不同 prefix |
| `hashwx.{c,d,n,count}` | 第一层挑战派生：`c = SHA256("hashwx:C:" + secret + ":" + cid)`，以及该难度下的子挑战参数 |
| `instrumentation.{seed,ops,regs}` | 第二层：程序派生种子、下发给客户端的程序、服务端影子模型推算出的期望寄存器 |
| `ticketPayloadJson` / `ticketBody` / `ticketSig` | 票据载荷的**字段顺序**与签名 |
| `ticketPayloadJsonLocked` / `ticketBodyLocked` / `ticketSigLocked` | 开启来源域名绑定后的票据载荷：同样是末尾追加 `org`（`v / iph / slug / iat / exp / jti / org`） |

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

### `origin-v1.json`

评论提交的**服务端来源校验**（`Origin` / `Referer` / `post_url`）口径。

背景：CORS 是浏览器机制，`allow_origin` 过去只决定要不要下发 `Access-Control-Allow-Origin`，
对「对方站点在自己的服务器上转发请求」完全无效 —— 对方照样落库，还会用后端配置的 SMTP 账号发信。
因此 `allow_origin` 非空且不含 `*` 时，写接口自己做一次来源校验。这份 fixture 覆盖：

- **归一化**：scheme 与主机大小写、尾斜杠、路径/查询串/片段、默认端口（`http:80` / `https:443`）、
  `userinfo` 丢弃、IPv6 字面量（`[::1]`），以及各类畸形输入（`Origin: null`、端口 `0`/前导零/越界、
  裸 IPv6、非 ASCII 主机名）的 fail-closed 结果；
- **白名单条目**：完整来源与裸主机名（忽略 scheme 与端口）两种写法，不支持通配符子域，
  条目解析失败即丢弃（全部非法时等价于「全部拒绝」）；
- **判定优先级**：白名单未启用（空配置 / `*`）→ `skip`；任一来源不可解析 → `deny:invalid_source`；
  无来源 → `deny:no_source`；任一来源不命中 → `deny:not_allowed`；全部命中 → `allow`；
- **真实场景**：浏览器直连（`Origin` 命中）、服务端转发（只有 `post_url`），
  以及「`post_url` 指向未授权站点」这种被滥用的形态；
- **`lock` 段**：`comment_verify_domain_enabled`（来源域名绑定）的判定口径，复用同一套解析与白名单规则，
  但有两处硬性差异 —— ① 白名单不可用（空 / 空白 / `*`）时不是 `skip` 而是 **`deny:no_whitelist`（fail-closed）**；
  ② 判定结果额外给出用于签进挑战/票据的**归一化来源** `origin`，**被拒时也尽量保留**
  （日志与认证记录靠它定位「哪个域名在尝试」）。覆盖：优先取 `Origin`、只有 `Referer`/`post_url` 时也能绑定、
  裸主机名条目绑定到含端口的完整来源、全部来源都必须命中、`Origin: null` 的 fail-closed、IPv6 字面量。

三端各自复算：Node `nodejs/test/vectors.origin-v1.test.ts`、Go `go/internal/pkg/utils/origin_vectors_test.go`、
Worker `worker/test/unit/vectors.origin-v1.test.ts`；接口层的「403 不落库、不发信」由
`nodejs/test/api.comments.test.ts`、`go/internal/handler/http/comment_test.go`、
`worker/test/api/comments.post.test.ts` 各自验证（Node/Worker 用假 SMTP 断言零发信）。

### `emoji-v2.json`

表情配置（`emoji_enabled` + `emoji_cdn_url`，格式见 [`doc/emoji.md`](../emoji.md)）的口径。
由 `scripts/gen-emoji-vectors.js` 生成（仓库根目录执行，纯 Node 脚本，不依赖 nodejs 的依赖）。

契约 v2 起，v1 的自定义表情包（`emoji_packs`）与公开接口 `GET /api/emoji` 已整体删除，
评论区只剩一个由管理员配置的 OwO 格式来源，因此这份 fixture 只钉死四处口径：

- **常量**（`defaults` / `limits`）：默认源 `https://open.motues.top/emoji/owo.json`、
  默认开关 `"true"`、`emoji_cdn_url` 长度上限 500 码点 —— 三端常量必须与 fixture 逐字相同；
- **写入路径校验**（`enabled` / `cdnUrl`）：`emoji_enabled` 归一化（`trim` + 转小写）后只允许
  `""` / `"true"` / `"false"`；`emoji_cdn_url` 空串合法，其余必须 `http(s)` 且不超过 500 **码点**
  （边界用例专门用 500 / 501 码点的长地址钉死单位，不是 UTF-16 码元、也不是字节）；
- **错误口径**：非法值一律 400 且不落库，三端返回同样的中文文案；
- **读取归一化**（`resolve`）：地址为空/只有空白 → 回落默认源；开关为空或无法识别 → fail-open 为启用；
  `FALSE` 这类历史脏值同样判为关闭；**关闭时地址照常下发**（面板不会丢掉配置）。

三端各自复算：Node `nodejs/test/vectors.emoji-v2.test.ts`、Go `go/internal/pkg/utils/emoji_vectors_test.go`、
Worker `worker/test/unit/vectors.emoji-v2.test.ts`；接口层（设置写入校验与归一化、`GET /api/comments`
下发两个字段、导出/导入往返）由 `nodejs/test/api.emoji.test.ts`、
`go/internal/handler/http/emoji_test.go`、`worker/test/api/admin.emoji.test.ts` 各自验证。
面板侧「保存前用浏览器拉取校验 OwO 格式」的护栏由 `dashboard/test/emojiUtils.test.js` 与
`dashboard/test/emojiSettings.test.js` 覆盖。

## 重新生成

**只有在有意修改协议时才需要重新生成**，并且必须同步更新所有语言的测试与 `doc/api.md`：

```bash
cd nodejs
npx ts-node scripts/gen-instr-vectors.ts
npx ts-node scripts/gen-verify-vectors.ts
npx ts-node scripts/gen-sanitize-vectors.ts
```

表情向量在仓库根目录生成（纯 Node 脚本，不依赖 nodejs 的依赖）：

```bash
node scripts/gen-emoji-vectors.js
```
脚本会打印全部生成值，便于人工核对。生成口径刻意在脚本里**独立复算**（而不是调用实现内部的私有函数），
这样 fixture 同时也是一次对实现口径的独立复核。

## 注意

- 这些文件是**测试专用**产物，不参与运行时；发布压缩包里不包含 `doc/`，因此从发布包解出的单个后端目录跑测试时会找不到 fixture（测试前请使用完整仓库）。
- 修改 fixture 而不修改对应实现，会让测试失败 —— 这是设计意图，不要为了「让测试变绿」而降低断言强度。
