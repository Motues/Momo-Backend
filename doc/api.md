# API 接口定义

## API

| 方法 | 路由 | 功能 |
| --- | --- | --- |
| POST | `/api/comments` | 提交评论 |
| GET | `/api/comments` | 获取评论 |
| GET | `/api/verify-email/verify` | 验证邮箱（从邮件链接访问，返回 HTML 页面） |
| POST | `/api/verify/challenge` | 签发人机验证挑战（无感验证） |
| POST | `/api/verify/solution` | 提交人机验证答案并换取票据 |
| POST | `/admin/login` | 登录 |
| GET | `/admin/settings` | 获取系统设置 |
| PUT | `/admin/settings` | 更新系统设置 |
| POST | `/admin/settings/test-email` | 发送测试邮件 |
| PUT | `/admin/password` | 修改管理员凭据 |
| POST | `/admin/logout` | 登出（吊销当前 token） |
| GET | `/admin/comments/list` | 获取所有评论 |
| PUT | `/admin/comments/status` | 修改评论状态 |
| PUT | `/admin/comments/edit` | 修改评论内容 |
| GET | `/admin/stats/overview` | 统计概览 |
| GET | `/admin/verify/overview` | 认证记录统计概览（无感验证的签发/通过/失败） |
| GET | `/admin/verify/records` | 认证记录明细（分页 + 筛选） |
| GET | `/admin/stats/users` | 用户列表（支持按昵称/邮箱搜索） |
| GET | `/admin/stats/users/comments` | 用户的评论 |
| POST | `/admin/users/blacklist` | 将用户（按邮箱）加入黑名单 |
| DELETE | `/admin/users/blacklist` | 将用户（按邮箱）移出黑名单 |
| GET | `/admin/data/export/comments` | 导出评论数据 |
| GET | `/admin/data/export/settings` | 导出系统设置 |
| POST | `/admin/data/import/comments` | 导入评论数据 |
| POST | `/admin/data/import/settings` | 导入系统设置 |

**接口说明**

* 每次请求会返回一个状态码 `code`，请求成功为 200，业务错误为 400，认证错误为 401
* 每次登录的时候会返回一个 token，用于后续的 API 请求
* 管理员接口请求头格式：`Authorization: Bearer <token>`
* 错误处理：如果key无效，则返回状态码 `401 Unauthorized`
    ```json
    {
        "code": 401,
        "message": "Invalid token"
    }
    ```

**状态码**

常见状态码及含义如下：

| 状态码 | 说明 | 典型场景 |
| --- | --- | --- |
| 200 | 请求成功 | 操作成功 |
| 400 | 请求参数错误 | 缺少必填字段、格式不正确、字段超长、非法状态值、非法 IP/CIDR 等 |
| 401 | 未授权 | 未携带 Token 或 Token 失效 |
| 403 | 禁止访问 | IP 被封禁、IP/邮箱在黑名单中、登录失败次数过多 |
| 404 | 资源不存在 | 资源不存在场景 |
| 429 | 请求过于频繁 | 评论频率超过限制（同一 IP 60 秒一条，`admin_email` 不受限）、公开评论列表请求过于频繁 |
| 500 | 服务器内部错误 | 未捕获异常、数据库错误等 |

## 用户接口

### 提交评论（POST `/api/comments`）

**请求体**：
```json
{
  "post_slug": "/posts/my-article",
  "author": "张三",
  "email": "zhangsan@example.com",
  "url": "https://example.com",
  "content": "写得真好！",
  "parent_id": null,
  "post_url": "https://blog.example.com/posts/my-article",
  "post_title": "我的文章",
  "admin_key": "xxxx",
  "verify_ticket": "eyJ2IjoxLCJpcGgiOi..."
}
```

> `admin_key` 仅在管理员评论密钥开启且邮箱为管理员邮箱时需要；`verify_ticket` 仅在 `comment_verify_enabled` 为 `"true"` 时需要，由 `/api/verify/solution` 下发。

**响应（成功）**：
```json
{
  "code": 200,
  "message": "Comment submitted successfully"
}
```

**响应（失败）**：
```json
{
  "code": 400,
  "message": "Invalid request body"
}
```
```json
{
  "code": 400,
  "message": "Time limit exceeded"
}
```
```json
{
  "code": 403,
  "message": "Your IP has been blocked"
}
```
```json
{
  "code": 403,
  "message": "Your email has been blocked"
}
```
```json
{
  "code": 403,
  "message": "Invalid admin key"
}
```
```json
{
  "code": 403,
  "message": "Human verification failed or expired",
  "reason": "VERIFY_REQUIRED"
}
```

> 当 `comment_verify_enabled` 设为 `"true"` 时，必须携带有效的 `verify_ticket`，否则返回上面的 `VERIFY_REQUIRED`。
> 使用管理员评论密钥验证通过的博主评论不受此限制。

> **评论频率限制**：同一 IP 60 秒内只能提交一条评论，超出返回 `429`。
> **例外**：`email` 等于 `admin_email` 的评论（管理员本人）不受该 60 秒冷却限制。

> 当 `comment_auto_approve` 设为 `"false"` 时，评论提交后状态为 `"pending"`，需在管理后台审核通过后才会公开显示。

> **字段长度上限**（超出返回 `400`）：
> `content` ≤ 2000 字符、`author` ≤ 100、`email` ≤ 254、`url` ≤ 500、`post_slug` ≤ 200。
> 字段类型不是字符串时同样返回 `400`。

> **`url` 协议白名单**：仅接受 `http:`、`https:`、`mailto:` 以及不带协议的相对路径，
> 其他协议（`javascript:`、`vbscript:`、`data:` 等，含 `java\nscript:` 这类控制字符变体）
> 会被丢弃为空。后台编辑与数据导入路径同样执行该校验。

> **邮箱验证**：当 `email_verify_enabled` 设为 `"true"` 且 SMTP 已配置时：
> - 如果评论者的邮箱尚未验证，评论状态会被设为 `"pending"`
> - 系统会自动发送验证邮件到评论者邮箱
> - 验证通过后，所有来自该邮箱的待审核评论会自动变为 `"approved"`
> - 后续该邮箱的评论将正常发布（遵守 `comment_auto_approve` 设置）
> - 响应消息会变为 `"Comment submitted. Please verify your email to publish the comment."`

### 获取评论（GET `/api/comments`）

> 🔒 仅返回 `status = 'approved'` 的评论

**查询参数**：
- `post_slug`：博客文章唯一标识（必需）
- `page`：查询页数（默认 1）
- `limit`：每页的评论数量（默认 20，最大 50）
- `nested`：评论是否使用嵌套结果返回（默认 true）

> **限流**：同一 IP 每分钟最多请求 120 次，超出返回 `429`。
> 客户端 IP 的判定方式见各后端 README 中的 `TRUST_PROXY` 说明。
>
> **隐私**：响应中不包含评论者邮箱；`admin_email_hash` 仅在后台开启「博主评论密钥」
> （`admin_comment_key_enabled = "true"`）时才下发，否则为空字符串。

**响应（成功）**：
`GET /api/comments?post_slug=...&nested=false`

```json
{
  "code": 200,
  "message": "Comments fetched successfully",
  "data": {
    "comments": [
      {
        "id": 123,
        "author": "张三",
        "url": "https://example.com",
        "avatar": "https://example.com/avatar.png",
        "contentText": "写得真好！",
        "contentHtml": "<p>写得真好！</p>",
        "pubDate": "2025-10-23T10:00:00Z",
        "parentId": null,
        "isBlogger": false
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "totalPage": 1
    },
    "blogger_badge_enabled": "true",
    "blogger_badge_text": "博主",
    "placeholder_name": "输入昵称",
    "placeholder_email": "输入邮箱",
    "placeholder_content": "写下你的评论...",
    "placeholder_url": "https://",
    "admin_comment_key_configured": "false",
    "admin_email_hash": "xxxxx",
    "verify_enabled": "false",
    "verify_honeypot": "",
    "verify_version": "2"
  }
}
```

`GET /api/comments?post_slug=...&nested=true`

```json
{
  "code": 200,
  "message": "Comments fetched successfully",
  "data": {
    "comments": [
      {
        "id": 123,
        "author": "张三",
        "url": "https://example.com",
        "avatar": "https://example.com/avatar.png",
        "contentText": "写得真好！",
        "contentHtml": "<p>写得真好！</p>",
        "pubDate": "2025-10-23T10:00:00Z",
        "isBlogger": true,
        "replies": [
          {
            "id": 124,
            "author": "李四",
            "url": "https://example.com",
            "avatar": "https://example.com/avatar.png",
            "contentText": "同意",
            "contentHtml": "<p>同意</p>",
            "pubDate": "2025-10-23T11:00:00Z",
            "isBlogger": false,
            "replies": []
          }
        ]
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 1
    },
    "blogger_badge_enabled": "true",
    "blogger_badge_text": "博主",
    "placeholder_name": "输入昵称",
    "placeholder_email": "输入邮箱",
    "placeholder_content": "写下你的评论...",
    "placeholder_url": "https://",
    "admin_comment_key_configured": "false",
    "admin_email_hash": "xxxxx",
    "verify_enabled": "false",
    "verify_honeypot": "",
    "verify_version": "2"
  }
}
```

**响应（失败）**：

```json
{
  "code": 400,
  "message": "Invalid query parameters"
}
```
---

### 验证邮箱（GET `/api/verify-email/verify`）

> 从验证邮件链接中访问，返回 HTML 页面，非 JSON 接口。用于完成邮箱验证流程。

**查询参数**：
- `token`：验证令牌（必需）
- `email`：邮箱地址（必需）

**成功**：返回 HTML 页面，显示"邮箱验证成功！共 N 条评论已通过审核。"

**失败**：返回 HTML 页面，显示具体的错误原因（链接无效、已过期等）。

---

### 人机验证（无感验证 · 协议 v2）

评论区可开启一套 Turnstile 风格的无感验证，由设置项 `comment_verify_enabled` 控制，**默认关闭**。开启后：

1. 前端在加载评论后自动调用 `/api/verify/challenge` 获取挑战
2. 浏览器静默完成**第一层**：HashWX 工作量证明（真人无需任何点击）
3. 若开启第二层，浏览器再执行服务端下发的随机程序并采集环境特征
4. 把两层答案一起提交到 `/api/verify/solution` 换取票据 `ticket`
5. 提交评论时携带该票据，后端校验通过才会写入数据库

> **两层是互补的**：第一层证明「付出了算力」，第二层证明「计算确实发生在浏览器里」。
> 主要成本杠杆是第一层；按上游说明，`undetected-chromedriver` 这类工具驱动**有头**原生 Chrome
> 可以绕过全部自动化检测，因此不要只依赖第二层。

> ⚠️ **协议 v2 是破坏性变更**：`prefix` 载荷、难度语义、答案字段与票据版本都与 v1 不兼容。
> 详见本节末尾的「版本与兼容性」。

#### 一、挑战参数如何派生（三端必须逐字节一致）

服务端**不保存任何挑战状态**，所有参数都由（签名密钥, 挑战 id）确定性派生：

```
cid     = base64url(随机 16 字节)                    // 每次签发都不同
c       = SHA256("hashwx:C:" + secret + ":" + cid)   // 32 字节，hex 下发
program = generateProgram(SHA256("instr:prog:" + secret + ":" + cid))
```

> `program` 的生成与解释口径见下面的「第二层」。注意 `secret` 是十六进制字符串，
> 冒号分隔符与字段顺序都属于协议的一部分，改动会让三端互不认可。

#### 二、第一层：HashWX 工作量证明

算法来自 [tevador/hashwx](https://github.com/tevador/hashwx) v1.0.0（LGPL-3.0，见 `nodejs/vendor/hashwx/`）。

```
target            = U64_MAX / d                      // 整数除法
seed(i, block)    = SHA256(c(32字节) ‖ u8le(i) ‖ u64le(block))
需要找到 nonce 使得 hash(seed(i, nonce / n), nonce) <= target
block             = nonce / n                        // 整数除法
```

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `count` | 4 | 子挑战个数，把总工作量均分以压平解题耗时的长尾 |
| `d` | `round(总难度 / count)` | 每个子挑战的期望哈希次数 |
| `n` | 65536 | 每个生成函数覆盖的 nonce 数（摊薄内层模块的编译开销） |

> - `nonce` 是 **u64**，JSON 中一律用十进制字符串传输（JS 的 Number 放不下 64 位）。
> - 总难度取自 `comment_verify_difficulty`，**语义是访客需要完成的哈希计算总次数**。
> - 实现要点：compiled 模式需要运行时编译每个索引用一次生成的内层 WASM 模块；
>   服务端只需单次求值，因此统一使用解释模式（实测单次校验 100–150µs）。

#### 三、第二层：Instrumentation 环境质询

仅在 `comment_verify_instr_enabled` 为 `"true"` 时下发与校验。

**程序格式**：扁平的整数数组，每 3 个整数一个操作：`[opcode, a, b]`。共 24 个操作码：

| 编号 | 操作 | 语义 |
| --- | --- | --- |
| 0–13 | `CONST` `MOV` `AND` `OR` `XOR` `NAND` `ADD` `SUB` `MUL` `ROTL` `ROTR` `SHL` `SHR` `NOT` | 4 个 32 位有符号寄存器的整数运算（乘法为 32 位溢出截断，移位/旋转按 32 位语义） |
| 14–21 | `DOM_CREATE` `DOM_APPEND` `DOM_SET_TEXT` `DOM_SET_ATTR` `DOM_READ_TEXT` `DOM_READ_ATTR` `DOM_WALK_UP` `DOM_REMOVE` | 在真实 DOM 上建元素树并读写：写入的值都是程序自己算出来的，因此服务端能用「影子模型」独立推算 |
| 22–23 | `PROTO_JOIN` `PROTO_CHARCODE` | 通过真实原型链调用（`Array.prototype.join` / `String.prototype.charCodeAt`） |

- 元素标签候选：`div span p section b i em u`；读写属性名固定为 `data-v`。
- `DOM_WALK_UP(dst, steps)`：从栈顶节点沿 `parentElement` 向上最多 `steps` 步，累加各节点的 `data-v`，再叠加到 `dst`。
- 程序结尾保证把整棵树拆掉，客户端执行完不应留下任何节点。
- 操作码总数上限 240。

**程序生成（确定性 PRNG）**：用 SHA-256 计数器模式扩展种子 —— 把 4 字节大端计数器追加到 32 字节种子后求摘要，每次得到 8 个 32 位字，循环取用即可。刻意不用有状态的 PRNG，避免跨语言的初始化/溢出语义差异。

**期望值**：服务端用「影子 DOM 模型」解释同一段程序得到 `regs`；客户端必须用真实 DOM 执行得到相同结果。两侧语义必须逐位一致，`doc/vectors/instrumentation-v2.json` 是双方共用的固定向量（覆盖全部 24 个操作码）。

**环境向量**（客户端采集，服务端判定）：

| 字段 | 说明 |
| --- | --- |
| `cd` | `navigator.webdriver`：`-1` 表示 `undefined`，`0` 表示 `false`，`1` 表示 `true` |
| `ua` / `br` | `userAgent` 与 `userAgentData.brands` 拼接（各截断到 300 字符） |
| `ge` | 引擎标记：`1`=Blink，`2`=Gecko，`3`=WebKit，`0`=未知 |
| `dm` | `navigator.deviceMemory`，不支持为 `-1` |
| `tm` | 字体度量：同一探测串在 17 个字体栈下的宽度（**原始浮点值，不要取整**，否则会虚增下面的整数量化计数） |
| `lw` / `lh` | 布局探针的宽高（离屏元素，32px 字号） |
| `iw` `ih` `ow` `oh` | 视口与窗口尺寸 |
| `sw` `sh` `ex` | 屏幕宽高与 `screen.isExtended` |
| `mob` | 是否移动端 |
| `nt` | 原生方法被改写的位掩码：`1`=canvas，`2`=webgl，`4`=permissions |

**判定规则**（`comment_verify_block_automated` 为 `"false"` 时只记录日志，不拦截）：

| 规则 | 触发条件 | 为何不误伤真人 |
| --- | --- | --- |
| `webdriver_true` | `cd === 1` | 规范定义的自动化标志，没有市售浏览器会设为 true |
| `webdriver_stripped` | Blink 引擎且 `cd === -1` | 真实 Chrome 永远暴露 `false` |
| `headless_token` | UA 或 brands 含 `HeadlessChrome` | 消费级浏览器不含该 token |
| `layout_zero` | `lw <= 0` 或 `lh <= 0` | 真实渲染引擎必然给出正的几何尺寸（jsdom 类环境恒为 0） |
| `gecko_contradiction` | Gecko 引擎却暴露 `deviceMemory` 或 `userAgentData` | Firefox 从未实现这两个 API |
| `window_exceeds_screen` | `ow > sw + 4` 或 `oh > sh + 4`（`ex === 1` 时跳过） | 第二显示器/扩展屏场景被排除 |
| `geometry_quantized` | 17 条字宽中至少 5 条为整数且至少有 2 个不同整数 | 单一字体系统不会命中；真实引擎返回小数 |
| `viewport_override` | 非移动端且视口与屏幕完全相等 | 移动端全屏是正常的，已跳过 |

只记录、**永不拦截**的风险标记：`native_tamper`（`nt !== 0`）、`few_font_metrics`（字宽采样不足 5 条）、`ua_missing`。

> 隐私扩展（Canvas Blocker / Chameleon / Trace 等）会改写 `nt` 涉及的同一批原生方法，
> 所以它只能作为风险标记。已知误报风险：Tor Browser 的字体整数量化、混合 DPI 多显示器环境。

#### 四、签发挑战（POST `/api/verify/challenge`）

**请求体**：
```json
{
  "post_slug": "/posts/my-article"
}
```

**响应（开启验证）**：
```json
{
  "code": 200,
  "message": "Challenge issued",
  "data": {
    "enabled": true,
    "version": 2,
    "post_slug": "/posts/my-article",
    "challenge_id": "7Yb1pQ2wS9kLzXcV3nRf4A",
    "prefix": "eyJ2IjoyLCJjaWQiOiI3WGIxcFEyd1M5a0x6WGNWM25SZjRBIiwiaXBoIjoiYTFiMmMzZDRlNWY2N2E4YiIsImlhdCI6MTczMDAwMDAwMDAwMH0",
    "sig": "5mQ8x1vTn0pLbE2sKd9cRw7yUa4hGf6jZo3iNq8tVm0",
    "expires_in": 600,
    "pow": {
      "algo": "hashwx",
      "c": "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801",
      "d": 250000,
      "n": 65536,
      "count": 4
    },
    "instr": {
      "ops": [0, 0, 12345, 14, 0, 0, 15, 0, 0, 17, 0, 0],
      "fonts": 17
    }
  }
}
```

- `instr` 仅在 `comment_verify_instr_enabled` 为 `"true"` 时出现；未开启时该字段整个缺席。
- `prefix` 是 base64url 编码的载荷 `{"v":2,"cid":…,"iph":…,"slug":…,"iat":…}`（**字段顺序固定**），由 `sig` 做 HMAC-SHA256 签名。
- **挑战绑定文章**：载荷里的 `slug` 就是本次请求的 `post_slug`。提交答案时请求体里的 `post_slug` 必须与它**完全一致**，否则返回 `reason: "slug mismatch"`。
  这是必需的：`/api/verify/solution` 的 `post_slug` 来自未签名的请求体，若不与挑战绑定，一次工作量证明就能在同一 IP 上换成**任意文章**的票据，跨文章防护等于不存在。
  两处必须使用**同一套净化规则**处理 `post_slug`（对 `post_slug` 应用 `checkContent` 后按 **Unicode 码点**截断到 200），否则会出现「同一篇文章两次净化结果不同」的假拒绝。三端口径由 `doc/vectors/sanitize-v2.json` 钉死 —— 注意截断单位是**码点**，不是 UTF-16 码元、也不是字节：按码元切可能切出孤立代理项，按字节切会把多字节字符切成非法 UTF-8，两者都会让三端结果不一致。
- `c` 虽不参与签名，但服务端在校验时会用（密钥, cid）重新派生；用错 `c` 必然被拒。
- 挑战有效期 10 分钟，且与来源 IP 绑定。

**响应（验证已关闭）**：
```json
{
  "code": 200,
  "message": "Verification disabled",
  "data": {
    "enabled": false,
    "version": 2
  }
}
```

> 前端在 `enabled` 为 `false` 时不应渲染验证框。

#### 五、提交答案（POST `/api/verify/solution`）

**请求体**：
```json
{
  "post_slug": "/posts/my-article",
  "prefix": "eyJ2IjoyLCJjaWQiOiI3WGIxcFEyd1M5a0x6WGNWM25SZjRBIiwi...",
  "sig": "5mQ8x1vTn0pLbE2sKd9cRw7yUa4hGf6jZo3iNq8tVm0",
  "nonces": ["58284", "12901", "77310", "4023"],
  "elapsed_ms": 1840,
  "hp": "",
  "instr": {
    "regs": [16, 0, 45, 0],
    "env": { "cd": 0, "ua": "Mozilla/5.0 …", "ge": 1, "tm": [10.5, 10.75], "lw": 120.5, "lh": 32.25 },
    "lw": 120.5,
    "lh": 32.25,
    "tm": [10.5, 10.75]
  }
}
```

> - `nonces` 是与子挑战一一对应的 **u64 十进制字符串**数组，长度必须等于 `pow.count`。
> - `hp` 为蜜罐字段，字段名由评论列表接口下发的 `verify_honeypot` 决定。真人始终提交空值；后端一旦发现非空即判定为脚本并直接拒绝。
> - `instr` 在服务端开启第二层时必须携带（`env` / `lw` / `lh` / `tm` 用于环境判定，`regs` 用于程序结果比对）。
> - 最小解题耗时下限为 **50ms**（仅用于拦截预置答案/缓存响应；下限过高会误伤多核高性能机器），上限为挑战有效期。

**响应（成功）**：
```json
{
  "code": 200,
  "message": "Verification passed",
  "data": {
    "enabled": true,
    "version": 2,
    "ticket": "eyJ2IjoyLCJpcGgiOiJhMWIyYzNkNGU1ZjY3YThiIiwic2x1ZyI6Ii9wb3N0cy9teS1hcnRpY2xlIiwiaWF0IjoxNzMwMDAwMDAwMDAwLCJleHAiOjE3MzAwMDAzMDAwMDAsImp0aSI6IkxnTjZ4UTJ3In0.9rT2mVpQ4xLbE8sKd1cRw7yUa4hGf6jZo3iNq8tVm0",
    "expires_in": 300
  }
}
```

> 票据（版本 `v: 2`）有效期 5 分钟，绑定来源 IP 与 `post_slug`；前端刷新页面会重新发起验证。

**响应（失败）**：
```json
{
  "code": 403,
  "message": "Verification failed",
  "reason": "insufficient work"
}
```

> `reason` 仅用于调试与日志定位。第一层可能取值：`missing challenge`、`bad signature`、
> `malformed prefix`、`malformed payload`、`PROTOCOL_OUTDATED`、**`slug mismatch`**、`challenge expired`、
> `challenge from the future`、`ip mismatch`、`implausible timing`、`challenge already used`、
> `malformed spec`、`malformed challenge`、`solution count mismatch`、`bad nonce`、`insufficient work`。
> 第二层可能取值：`malformed registers`、`program result mismatch`，
> 以及命中自动化规则时的 `automated browser detected: <规则名列表>`。
> 蜜罐命中时为 `honeypot`。
>
> 判定顺序（顺序会影响返回的 reason）：签名 → JSON 解析 → 是否为对象 → **协议版本** → 字段形状
> → **文章绑定** → 时效 → IP → 时序 → 工作量 → 防重放 → 第二层。
> 协议版本先于字段形状是刻意的：v1 载荷既没有 `v` 也没有 `slug`，否则会被误判成 `malformed payload`。

> **防重放**：挑战是**单次使用**的 —— 兑换成功（或第二层校验失败）之后，同一 `prefix` 不能再提交。
> 第二层校验发生在挑战被标记为已用之后，这是有意的：否则攻击者可以用同一个已通过算力证明的挑战
> 反复更换环境向量，直到凑出一个能通过自动化检测的组合。

#### 六、相关设置项

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `comment_verify_enabled` | `"false"` | 总开关，默认关闭 |
| `comment_verify_difficulty` | `"1000000"` | **访客需要完成的哈希计算总次数**（协议 v2 语义），有效范围 1000–1000000000，按 4 个子挑战均分。**兼容 v1 旧值**：≤26 的值按 `2^值` 迁移（视为旧的前导 0 比特数），且上限钳到 2^20。**`"0"`、负数或解析不出数字时退回默认强度 `1000000`**（视为配置无效，安全的失败方向）；合法但低于下限的值才钳到 1000；`parseInt` 容忍尾部垃圾（与 v1 一致，`"1.5x"` 解析为 `1`） |
| `comment_verify_instr_enabled` | `"false"` | 第二层环境质询开关，默认关闭 |
| `comment_verify_block_automated` | `"false"` | 第二层命中自动化特征时是否拒绝，默认只记录日志 |
| `comment_verify_retention_days` | `"30"` | 认证记录（`VerifyRecord`）保留天数：`0` 或负数 = 永久保留，上限 3650，非法值按 30 处理；超期记录由三端惰性清理自动删除 |
| `comment_verify_log_challenge` | `"true"` | 是否记录「签发挑战」事件（非 `"false"` 即记录）。关闭后只记录通过/失败，可显著降低写入量，代价是看不到「签发了但没人提交答案」的流失 |
| `comment_verify_secret` | 自动生成 | 服务端签名密钥，首次使用时自动生成并写入 `Settings` 表，不对外提供读写 |

#### 七、版本与兼容性

| 项目 | 协议 v1（包版本 1.5.0 及更早） | 协议 v2（包版本 1.5.1 起） |
| --- | --- | --- |
| 挑战响应字段 | `difficulty`（前导 0 比特数） | `version`、`pow.{c,d,n,count}`、可选 `instr` |
| 第一层算法 | `SHA256(prefix + ":" + nonce)` 前导 0 比特 | HashWX（一次性生成函数） |
| 答案字段 | `nonce`（单个） | `nonces`（u64 十进制字符串数组） |
| 难度语义 | 前导 0 比特数（8–26） | 总哈希计算次数（1000–1e9） |
| 票据版本 | `v: 1` | `v: 2` |
| 挑战重放 | 按 `cid:nonce` 去重 | 挑战单次使用 |
| 最小解题耗时 | 300ms | 50ms |

- **旧前端 + 新后端**：旧前端签发的 `prefix` 载荷 `v` 为 1，新后端返回 `reason: "PROTOCOL_OUTDATED"` 而不是笼统的失败原因。
- **新前端 + 旧后端**：挑战响应里没有 `pow`，新前端会显示「验证服务版本过旧，请联系博主升级」，并禁用无效的重试按钮。
- 评论列表接口下发 `verify_version`（当前为 `"2"`），便于前端做前后端配套判断。
- 浏览器需要支持 WebAssembly（第一层必需）；不支持时前端会提示「浏览器版本过低，不支持验证」。**v2 不提供纯 JS 降级路径**。


---

## 管理员接口

> 🚧 需要 `Authorization: Bearer <token>`

### 登录 (POST `/admin/login`)

**请求体**：
```json
{
  "name": "momo",
  "password": "momo"
}
```

> 初始默认凭据为 `momo`/`momo`，首次登录后系统会要求修改。

**响应（成功）**：

```json
{
  "code": 200,
  "message": "Login successful",
  "token": "<token>",
  "needChangePassword": false
}
```

> `needChangePassword` 为 `true` 时表示正在使用默认凭据，建议立即修改。

**响应（失败）**：

```json
{
  "code": 400,
  "message": "Invalid username or password"
}
```

```json
{
  "code": 400,
  "message": "IP is blocked due to multiple failed login attempts"
}
```

### 获取系统设置 (GET `/admin/settings`)

> 获取系统配置项。敏感字段（密码类）返回空字符串。支持按模块筛选。

**查询参数**：
- `type`：按模块筛选（可选）
  - `basic` — 基本设置（站点信息、评论审核、博主标识、占位符）
  - `email` — 邮件通知（SMTP 配置、邮箱验证、邮件模板）
  - `security` — 安全设置（CORS、评论密钥、IP/邮箱黑名单）
  - `account` — 账户信息（管理员名称）
  - 不传则返回全部设置（向后兼容）；未知取值（含 `toString` 等原型链成员名）同样回退为全部设置

**响应（成功）**：
`GET /admin/settings`（返回全部设置）

```json
{
  "code": 200,
  "message": "Settings fetched",
  "data": {
    "site_name": "Momo Blog",
    "admin_email": "admin@example.com",
    "allow_origin": "http://localhost:4321,https://example.com",
    "smtp_host": "smtp.example.com",
    "smtp_port": "465",
    "email_user": "notify@example.com",
    "email_password": "",
    "email_secure": "true",
    "email_enabled": "true",
    "email_verify_enabled": "false",
    "reply_template": "",
    "notification_template": "",
    "comment_auto_approve": "true",
    "ip_blacklist": "[\"192.168.1.100\",\"10.0.0.0/8\"]",
    "email_blacklist": "[\"spam@example.com\"]",
    "blogger_badge_enabled": "false",
    "blogger_badge_text": "",
    "placeholder_name": "",
    "placeholder_email": "",
    "placeholder_content": "",
    "placeholder_url": "",
    "admin_comment_key": "",
    "admin_comment_key_enabled": "false",
    "comment_verify_enabled": "false",
    "comment_verify_difficulty": "1000000",
    "comment_verify_instr_enabled": "false",
    "comment_verify_block_automated": "false",
    "comment_verify_retention_days": "30",
    "comment_verify_log_challenge": "true"
  }
}
```

> `email_password`、`admin_comment_key` 等敏感字段始终返回空字符串。
> `comment_verify_secret` 由系统自动生成，不在任何设置接口的读写白名单内。
>
> 当 `trust_proxy` 出现在返回结果中时，若该开关被环境变量或配置文件强制指定，
> 响应会额外带上 `trust_proxy_override` 字段，取值为 `"env"`（环境变量）、
> `"config"`（Go 的 config.yaml）或 `"worker"`（Cloudflare Worker 形态下该开关无意义），
> 前端据此提示「页面设置不生效」。

**模块筛选示例**：

`GET /admin/settings?type=basic`
```json
{
  "code": 200,
  "message": "Settings fetched",
  "data": {
    "site_name": "Momo Blog",
    "admin_email": "admin@example.com",
    "comment_auto_approve": "true",
    "blogger_badge_enabled": "false",
    "blogger_badge_text": "",
    "placeholder_name": "",
    "placeholder_email": "",
    "placeholder_content": "",
    "placeholder_url": ""
  }
}
```

`GET /admin/settings?type=email`
```json
{
  "code": 200,
  "message": "Settings fetched",
  "data": {
    "smtp_host": "smtp.example.com",
    "smtp_port": "465",
    "email_user": "notify@example.com",
    "email_password": "",
    "email_secure": "true",
    "email_enabled": "true",
    "email_verify_enabled": "false",
    "reply_template": "",
    "notification_template": ""
  }
}
```

`GET /admin/settings?type=security`
```json
{
  "code": 200,
  "message": "Settings fetched",
  "data": {
    "allow_origin": "http://localhost:4321,https://example.com",
    "admin_comment_key": "",
    "admin_comment_key_enabled": "false",
    "ip_blacklist": "[\"192.168.1.100\",\"10.0.0.0/8\"]",
    "email_blacklist": "[\"spam@example.com\"]",
    "comment_verify_enabled": "false",
    "comment_verify_difficulty": "1000000",
    "comment_verify_instr_enabled": "false",
    "comment_verify_block_automated": "false",
    "comment_verify_retention_days": "30",
    "comment_verify_log_challenge": "true",
    "trust_proxy": "false"
  }
}
```

`GET /admin/settings?type=account`
```json
{
  "code": 200,
  "message": "Settings fetched",
  "data": {
    "admin_name": "momo"
  }
}
```

**响应（失败）**：
```json
{
  "code": 401,
  "message": "Invalid token"
}
```

---

### 更新系统设置 (PUT `/admin/settings`)

> 更新系统配置。SMTP 等配置修改后可能需要重启服务才能完全生效。

**请求体**（所有字段可选，只传需要修改的字段）：
```json
{
  "site_name": "My Blog",
  "admin_email": "newadmin@example.com",
  "smtp_host": "smtp.gmail.com",
  "smtp_port": "587",
  "email_user": "user@gmail.com",
  "email_password": "app-password",
  "email_secure": "false",
  "allow_origin": "https://myblog.com",
  "email_enabled": "true",
  "email_verify_enabled": "false",
  "reply_template": "<div>Hi {{toName}}，<br>{{replyAuthor}} 回复了您：{{replyContent}}</div>",
  "notification_template": "<div>{{commentAuthor}} 评论了 {{postTitle}}：{{commentContent}}</div>",
  "comment_auto_approve": "false",
  "ip_blacklist": "[\"192.168.1.100\",\"10.0.0.0/8\"]",
  "email_blacklist": "[\"spam@example.com\"]",
  "admin_comment_key_enabled": "true",
  "admin_comment_key": "my-secret-key",
  "comment_verify_enabled": "true",
  "comment_verify_difficulty": "1000000",
  "comment_verify_instr_enabled": "true",
  "comment_verify_block_automated": "false",
  "comment_verify_retention_days": "30",
  "comment_verify_log_challenge": "true",
  "trust_proxy": "false"
}
```

> **注意**：
> - `email_password` 留空时不覆盖已有密码，仅当传入新值时更新
> - `admin_comment_key_enabled` 控制管理员评论密钥的启用/关闭，关闭时自动清除密钥
> - `comment_verify_enabled` 控制评论无感验证的启用/关闭，默认 `"false"`；开启后提交评论必须携带 `verify_ticket`
> - `comment_verify_difficulty` 是**访客需要完成的哈希计算总次数**（协议 v2 语义），默认 `"1000000"`；≤26 的历史值会按 `2^值` 自动迁移
> - `comment_verify_instr_enabled` 开启第二层环境质询，默认 `"false"`；`comment_verify_block_automated` 控制命中自动化特征时是否拒绝，默认 `"false"`（只记录日志）
> - `comment_verify_retention_days` 是认证记录（`VerifyRecord`）的保留天数，默认 `"30"`；`"0"` 表示永久保留，上限 3650
> - `comment_verify_log_challenge` 控制是否记录「签发挑战」事件，默认 `"true"`；设为 `"false"` 只记录通过/失败以降低写入量
> - `admin_password` **不在允许写入的字段中**，直接提交会返回 `400`；修改密码请使用 `PUT /admin/password`（需要提供旧凭据）
> - `ip_blacklist` 会被校验格式，必须是「合法 IP 或 CIDR」组成的 JSON 数组，否则返回 `400`
> - `allow_origin`：逗号分隔的来源白名单；**留空表示不放开跨域**，填 `*` 表示允许任意来源。
>   管理接口使用 `Authorization: Bearer`，不依赖 Cookie 凭据，因此不会下发 `Access-Control-Allow-Credentials`
> - `trust_proxy`：是否信任反向代理下发的客户端 IP 头（`cf-connecting-ip` / `x-real-ip` / `x-forwarded-for`）。
>   默认 `"false"`，只使用 TCP 连接对端地址；部署在 Nginx / Cloudflare 之后时必须设为 `"true"`。
>   开启后 `x-forwarded-for` 取最右一跳。该项也可由环境变量 `TRUST_PROXY`（Node）或
>   `config.yaml` 中的 `TRUST_PROXY`（Go）强制指定，此时页面设置不生效，详见各后端 README

> **邮件模板可用占位符**（三端一致：替换为 **HTML 转义后**的值，未匹配的 `{{...}}` 保持原样）：
> - 回复模板：`{{toName}}` `{{replyAuthor}}` `{{postTitle}}` `{{parentComment}}` `{{replyContent}}` `{{postUrl}}`
> - 通知模板：`{{postTitle}}` `{{commentAuthor}}` `{{commentContent}}` `{{postUrl}}`

> **新字段说明**：
> - `comment_auto_approve`：评论自动通过开关，`"true"` 表示评论直接显示，`"false"` 表示评论需审核
> - `ip_blacklist`：IP 黑名单，JSON 数组格式，支持单个 IP 和 CIDR 网段（如 `"192.168.1.0/24"`）
> - `email_blacklist`：邮箱黑名单，JSON 数组格式，不区分大小写匹配邮箱地址（可通过用户列表一键拉黑）

**响应（成功）**：
```json
{
  "code": 200,
  "message": "Settings updated. Some changes may require a restart to take full effect.",
  "smtpChanged": false
}
```

> `smtpChanged` 为 `true` 表示 SMTP 配置有变更。

**响应（失败）**：
```json
{
  "code": 400,
  "message": "Setting \"invalid_key\" is not allowed"
}
```

---

### 发送测试邮件 (POST `/admin/settings/test-email`)

> 向管理员邮箱发送一封测试邮件，验证 SMTP 配置是否正确。

**请求体**：无

**响应（成功）**：
```json
{
  "code": 200,
  "message": "A test email has been sent"
}
```

**响应（失败）**：
```json
{
  "code": 400,
  "message": "SMTP is not configured. "
}
```

```json
{
  "code": 400,
  "message": "Admin email is not configured. "
}
```

```json
{
  "code": 400,
  "message": "The email notification feature is currently disabled. "
}
```

---

### 修改管理员凭据 (PUT `/admin/password`)

> 修改管理员用户名和密码。修改后当前 token 将失效，需重新登录。

**请求体**：
```json
{
  "old_name": "momo",
  "old_password": "momo",
  "new_name": "newadmin",
  "new_password": "newpassword123"
}
```

**响应（成功）**：
```json
{
  "code": 200,
  "message": "Admin credentials updated successfully. Please login again."
}
```

**响应（失败）**：
```json
{
  "code": 401,
  "message": "Current credentials are incorrect"
}
```

```json
{
  "code": 400,
  "message": "New password must be at least 8 characters"
}
```

> 最小长度三端统一为 **8 位**（C10）。

---

### 登出 (POST `/admin/logout`)

> 吊销当前 token。修改密码时后端也会吊销**全部**已签发的 token。

**请求头**：`Authorization: Bearer <token>`

**响应（成功）**：
```json
{
  "code": 200,
  "message": "Logged out"
}
```

**响应（失败）**：
```json
{
  "code": 401,
  "message": "Invalid token"
}
```

---

### 修改评论状态 (PUT `/admin/comments/status`)

**请求参数**：
- `id`：评论ID（必需）
- `status`：评论状态，仅允许 `approved`、`pending`、`rejected`、`deleted`（必需）

**级联语义**（三端一致）：
- `deleted` / `pending`：**连同全部子孙评论一起修改**（递归更新所有回复）
- `approved` / `rejected`：只修改本条评论

**响应（成功）**：
`PUT/admin/comments/status?id=...&status=...`

```json
{
  "code": 200,
  "message": "Comment status updated"
}
```

**响应（失败）**：

```json
{
  "code": 400,
  "message": "Invalid status. Allowed: pending, approved, rejected, deleted"
}
```

```json
{
  "code": 404,
  "message": "Comment not found"
}
```

> **三端一致**：`id` 不存在时统一返回 **404**（若在读取后被并发删除也会得到该响应）。
> `deleted` / `pending` 的级联更新同样以「目标评论是否存在」为准，不存在即 404。

### 修改评论内容 (PUT `/admin/comments/edit`)

**请求体**：
```json
{
  "id": 123,
  "author": "新作者名",
  "email": "new@example.com",
  "content_text": "修改后的纯文本内容",
  "content_html": "<p>修改后的HTML内容</p>",
  "url": "https://example.com"
}
```

> `id` 为必填字段，其余字段至少传一个，未传的字段不会被修改。

**响应（成功）**：
```json
{
  "code": 200,
  "message": "Comment updated"
}
```

**响应（失败）**：
```json
{
  "code": 400,
  "message": "Invalid request parameters"
}
```

```json
{
  "code": 400,
  "message": "No fields to update"
}
```

```json
{
  "code": 404,
  "message": "Comment not found"
}
```

> **三端一致**：`id` 不存在时统一返回 **404**（若在读取后被并发删除也会得到该响应）。

### 获取所有评论 (GET `/admin/comments/list`)

**查询参数**：
- `page`：查询页数（默认 1）
- `status`：按状态筛选（可选，取值：`approved`、`pending`、`deleted`，为空返回全部）

**响应（成功）**：
`GET /admin/comments/list&page=1`
或过滤：`GET /admin/comments/list?page=1&status=pending`

```json
{
  "code": 200,
  "message": "Comments fetched successfully",
  "data": {
    "comments": [
      {
        "id": 123,
        "pubDate": "2025-10-23T10:00:00Z",
        "postSlug": "/posts/my-article",
        "author": "张三",
        "email": "zhangsan@example.com",
        "url": "https://example.com",
        "ipAddress": "192.168.1.1",
        "os": "Windows 10",
        "browser": "Chrome 96.0.4664.110",
        "contentText": "写得真好！",
        "contentHtml": "<p>写得真好！</p>",
        "status": "approved",
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "totalPage": 1
    }
  }
}
```

**响应（失败）**：

```json
{
  "code": 400,
  "message": "Invalid query parameters"
}
```

### 统计概览 (GET `/admin/stats/overview`)

> 获取整体数据统计，包括评论数、用户数、状态分布、趋势等

**查询参数**：
- `range`：时间范围（可选，默认 7）
  - `7` — 最近 7 天（逐日）
  - `14` — 最近 14 天（逐日）
  - `30` — 最近 30 天（逐日）
  - `0` 或 `all` — 最近 12 个月（按月聚合）
  - 上限 365 天，超出按 365 处理；非法值按默认 7 处理

> 分桶时区：三端统一按 **UTC** 聚合（`strftime(..., 'unixepoch')`），返回的 `date` 形如 `2026-04-27`（逐日）或 `2026-04`（逐月）。

**响应（成功）**：
`GET /admin/stats/overview?range=7`

```json
{
  "code": 200,
  "message": "Stats fetched successfully",
  "data": {
    "totalComments": 100,
    "totalUsers": 25,
    "totalPosts": 10,
    "statusDistribution": {
      "approved": 80,
      "pending": 15,
      "deleted": 5
    },
    "recentComments": [
      { "date": "2026-04-21", "count": 5 },
      { "date": "2026-04-22", "count": 3 },
      { "date": "2026-04-23", "count": 8 },
      { "date": "2026-04-24", "count": 2 },
      { "date": "2026-04-25", "count": 7 },
      { "date": "2026-04-26", "count": 4 },
      { "date": "2026-04-27", "count": 6 }
    ],
    "topCommenters": [
      { "author": "张三", "email": "zhangsan@example.com", "count": 15, "lastCommentDate": "2026-04-27T10:00:00.000Z" },
      { "author": "李四", "email": "lisi@example.com", "count": 10, "lastCommentDate": "2026-04-26T08:00:00.000Z" }
    ]
  }
}
```

`GET /admin/stats/overview?range=0`

```json
{
  "code": 200,
  "message": "Stats fetched successfully",
  "data": {
    "recentComments": [
      { "date": "2025-06", "count": 12 },
      { "date": "2025-07", "count": 8 },
      { "date": "2025-08", "count": 15 },
      { "date": "2025-09", "count": 0 },
      { "date": "2025-10", "count": 22 },
      { "date": "2025-11", "count": 18 },
      { "date": "2025-12", "count": 5 },
      { "date": "2026-01", "count": 10 },
      { "date": "2026-02", "count": 7 },
      { "date": "2026-03", "count": 14 },
      { "date": "2026-04", "count": 9 },
      { "date": "2026-05", "count": 3 }
    ]
  }
}
```

**响应（失败）**：
```json
{
  "code": 401,
  "message": "Invalid token"
}
```

### 认证记录统计概览 (GET `/admin/verify/overview`)

> 统计评论区**无感验证（人机验证）**的每一次认证：签发挑战数、通过数、失败数、平均解题耗时，
> 以及趋势折线与 Top 榜单。数据来自 `VerifyRecord` 表（见 [data_table.md](./data_table.md)），
> 只有开启 `comment_verify_enabled` 后才会产生记录。
>
> 统计口径（三端逐条一致）：分桶与时间键统一按 **UTC**；`passRate = pass / (pass + fail)`；
> 平均耗时只统计 `pass` 事件；`*Delta` 与紧邻的上一个等长窗口比较，上一窗口无数据时为 `null`。

**查询参数**：
- `days`：统计窗口天数（可选，默认 `30`）
  - `1` — 最近 24 小时（按小时分桶，键形如 `2026-04-27T14`）
  - `7` / `30` / `90` — 最近 N 天（按天分桶，键形如 `2026-04-27`）
  - `0` 或 `all` — 最近 12 个月（按月分桶，键形如 `2026-04`）
  - 上限 365 天，超出按 365 处理；非法值按默认 30 处理
- `offset`：窗口向前平移的**整窗个数**（可选，默认 `0`，上限 120）—— 对应管理面板上的左右箭头

**响应（成功）**：
`GET /admin/verify/overview?days=30&offset=0`

```json
{
  "code": 200,
  "message": "Verify stats fetched successfully",
  "data": {
    "range": {
      "days": 30,
      "offset": 0,
      "from": "2026-03-28T00:00:00.000Z",
      "to": "2026-04-26T23:59:59.999Z",
      "bucket": "day"
    },
    "summary": {
      "challenges": 2400000,
      "challengesDelta": 20,
      "verified": 2200000,
      "verifiedDelta": 11,
      "failed": 142000,
      "failedDelta": -85,
      "avgDurationMs": 5000,
      "avgDurationDelta": -12,
      "passRate": 93.9
    },
    "trend": [
      { "date": "2026-04-25", "challenges": 120, "verified": 110, "failed": 7 },
      { "date": "2026-04-26", "challenges": 98, "verified": 90, "failed": 5 }
    ],
    "geoSupported": true,
    "topCountries": [
      { "name": "US", "count": 85200, "percent": 30.1 },
      { "name": "GB", "count": 25400, "percent": 9.0 }
    ],
    "topNetworks": [
      { "name": "Comcast Cable Communications", "asn": 7922, "count": 20200, "percent": 7.1 }
    ],
    "topReasons": [
      { "reason": "ip mismatch", "count": 1200, "percent": 0.4 },
      { "reason": "challenge expired", "count": 320, "percent": 0.1 }
    ]
  }
}
```

> **`geoSupported`**：只有 Cloudflare Worker 部署为 `true`（地域与运营商来自请求对象上的
> `cf.country` / `cf.asOrganization` / `cf.asn`）。Node 与 Go 部署返回 `false`，且
> `topCountries` / `topNetworks` 恒为空数组，管理面板据此隐藏这两块榜单。
>
> **`topReasons`** 三端都有数据，取窗口内 `event = 'fail'` 的原因计数。
> Top 榜单的 `percent` 为「该条目计数 ÷ 窗口内全部事件数（签发 + 通过 + 失败）」。

**响应（失败）**：
```json
{
  "code": 401,
  "message": "Invalid token"
}
```

### 认证记录明细 (GET `/admin/verify/records`)

> 分页返回认证记录明细，用于排查「某个 IP 为什么一直失败」「某篇文章的认证流失」这类问题。

**查询参数**：
- `page`：页码（可选，默认 1）
- `pageSize`：每页条数（可选，默认 20，上限 100）
- `event`：`all`（默认）| `challenge` | `pass` | `fail`
- `reason`：失败原因精确匹配，例如 `ip mismatch`
- `ip`：来源 IP **前缀**匹配（便于按网段排查），如 `203.0.113.`
- `slug`：文章标识精确匹配
- `days`：时间窗口天数（可选，默认 30；`0` 或 `all` 表示全部历史）

**响应（成功）**：
`GET /admin/verify/records?page=1&pageSize=20&event=fail&days=30`

```json
{
  "code": 200,
  "message": "Verify records fetched successfully",
  "data": {
    "list": [
      {
        "id": 10241,
        "createdAt": "2026-04-26T12:34:56.789Z",
        "event": "fail",
        "reason": "ip mismatch",
        "elapsedMs": 4200,
        "difficulty": 1000000,
        "challengeId": "3Qk9mZ2f1sV0xA",
        "postSlug": "/posts/hello-world",
        "ipAddress": "203.0.113.42",
        "country": "US",
        "network": "Comcast Cable Communications",
        "asn": 7922
      }
    ],
    "total": 142,
    "page": 1,
    "pageSize": 20
  }
}
```

> `createdAt` 为 ISO 8601 UTC 字符串；`elapsedMs` / `difficulty` / `asn` 在无数据时为 `null`；
> `reason` / `challengeId` / `postSlug` / `ipAddress` / `country` / `network` 无数据时为空字符串。
> `country` / `network` / `asn` 同样只有 Cloudflare Worker 部署有值。

**响应（失败）**：
```json
{
  "code": 401,
  "message": "Invalid token"
}
```

### 用户列表 (GET `/admin/stats/users`)

> 按用户名+邮箱唯一标识用户，显示每个用户的评论统计，标记邮箱是否已被拉黑，以及该邮箱是否已通过邮箱验证。

**查询参数**：
- `page`：查询页数（默认 1）
- `limit`：每页用户数（默认 20）
- `search`：搜索关键字（可选），按昵称或邮箱模糊匹配（不区分大小写）
- `verified`：按邮箱验证状态筛选（可选）。`all`（默认，不筛选）/ `true`（仅已验证）/ `false`（仅未验证）

> **判定口径**：只要 `EmailVerification` 表中存在该邮箱 `verified = 1` 的记录即视为「已验证」，
> 与提交评论时跳过邮箱验证的判定完全一致（邮箱为精确匹配，大小写敏感）。
> 验证记录不会过期，因此用户验证过一次后，后续评论都不再需要重复验证。

**响应（成功）**：
`GET /admin/stats/users?search=张三`
`GET /admin/stats/users?verified=false`

```json
{
  "code": 200,
  "message": "Users fetched successfully",
  "data": {
    "users": [
      {
        "author": "张三",
        "email": "zhangsan@example.com",
        "commentCount": 15,
        "approvedCount": 12,
        "pendingCount": 2,
        "deletedCount": 1,
        "firstCommentDate": "2024-01-01T00:00:00.000Z",
        "lastCommentDate": "2026-04-27T10:00:00.000Z",
        "blacklisted": false,
        "emailVerified": true,
        "emailVerifiedAt": "2026-04-20T08:30:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "totalPage": 2
    }
  }
}
```

> `blacklisted` 为 `true` 表示该用户的邮箱已在邮箱黑名单中，无法再提交评论。

### 将用户加入黑名单 (POST `/admin/users/blacklist`)

> 一键将用户加入黑名单：将用户的邮箱写入 `email_blacklist` 设置（不区分大小写），加入后该邮箱将无法提交评论。可在"安全设置"的邮箱黑名单中统一管理。

**请求体**：
```json
{
  "email": "spam@example.com"
}
```

**响应（成功）**：
```json
{
  "code": 200,
  "message": "User added to blacklist",
  "data": {
    "email": "spam@example.com",
    "blacklisted": true
  }
}
```

**响应（重复拉黑）**：
```json
{
  "code": 200,
  "message": "User is already in blacklist",
  "data": {
    "email": "spam@example.com",
    "blacklisted": true
  }
}
```

**响应（失败）**：
```json
{
  "code": 400,
  "message": "email is required"
}
```

### 将用户移出黑名单 (DELETE `/admin/users/blacklist`)

**查询参数**：
- `email`：邮箱地址（必需）

**响应（成功）**：
`DELETE /admin/users/blacklist?email=spam@example.com`

```json
{
  "code": 200,
  "message": "User removed from blacklist",
  "data": {
    "email": "spam@example.com",
    "blacklisted": false
  }
}
```

**响应（不在黑名单中）**：
```json
{
  "code": 200,
  "message": "User is not in blacklist",
  "data": {
    "email": "spam@example.com",
    "blacklisted": false
  }
}
```

### 用户的评论列表 (GET `/admin/stats/users/comments`)

> 获取指定用户的所有评论详情

**查询参数**：
- `author`：作者昵称（必需）
- `email`：邮箱（必需）
- `page`：查询页数（默认 1）

**响应（成功）**：
```json
{
  "code": 200,
  "message": "User comments fetched successfully",
  "data": {
    "comments": [
      {
        "id": 123,
        "pubDate": "2025-10-23T10:00:00Z",
        "postSlug": "/posts/my-article",
        "author": "张三",
        "email": "zhangsan@example.com",
        "url": null,
        "ipAddress": "192.168.1.1",
        "os": "Windows 10",
        "browser": "Chrome 96",
        "contentText": "写得真好！",
        "contentHtml": "<p>写得真好！</p>",
        "status": "approved"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "totalPage": 2
    }
  }
}
```

**响应（失败）**：
```json
{
  "code": 400,
  "message": "author and email are required"
}
```

---

### 导出评论数据 (GET `/admin/data/export/comments`)

> 导出所有评论为 JSON 格式，用于备份或迁移

**查询参数**：无

**响应（成功）**：
```json
{
  "code": 200,
  "message": "Comments exported",
  "data": {
    "exportedAt": "2026-05-02T10:00:00.000Z",
    "type": "comments",
    "version": "1.0",
    "total": 100,
    "comments": [
      {
        "id": 1,
        "pubDate": "2025-10-23T10:00:00.000Z",
        "postSlug": "/posts/my-article",
        "author": "张三",
        "email": "zhangsan@example.com",
        "url": "https://example.com",
        "ipAddress": "192.168.1.1",
        "os": "Windows 10",
        "browser": "Chrome 96",
        "contentText": "写得真好！",
        "contentHtml": "<p>写得真好！</p>",
        "parentId": null,
        "status": "approved"
      }
    ]
  }
}
```

---

### 导出系统设置 (GET `/admin/data/export/settings`)

> 导出系统设置，不含 `admin_password`/`comment_verify_secret`。
>
> **敏感字段会被置空**：`email_password` 与 `admin_comment_key` 出于安全考虑统一导出为空字符串，
> 响应中的 `sensitiveOmitted` 会列出被置空的字段名，导入后需要手工补填。
>
> `admin_name`（管理员用户名）会正常导出，保证「导出 → 导入」往返后管理员身份不丢失。

**查询参数**：无

**响应（成功）**：
```json
{
  "code": 200,
  "message": "Settings exported. Sensitive fields (email_password, admin_comment_key) are blanked; please fill them in manually after importing.",
  "data": {
    "exportedAt": "2026-05-02T10:00:00.000Z",
    "type": "settings",
    "version": "1.0",
    "sensitiveOmitted": ["email_password", "admin_comment_key"],
    "settings": {
      "site_name": "Momo Blog",
      "admin_email": "admin@example.com",
      "admin_name": "momo",
      "smtp_host": "smtp.example.com",
      "smtp_port": "465",
      "email_user": "notify@example.com",
      "email_password": "",
      "email_secure": "true",
      "allow_origin": "*",
      "email_enabled": "true",
      "admin_comment_key": "",
      "email_verify_enabled": "false",
      "reply_template": "...",
      "notification_template": "..."
    }
  }
}
```

> 导入时，`email_password` / `admin_comment_key` 为空字符串表示「未修改」，不会覆盖数据库中已有的值。

---

### 导入评论数据 (POST `/admin/data/import/comments`)

> 导入之前导出的评论 JSON 文件数据
>
> **安全说明**：导入路径与前台提交执行相同的净化处理——
> `author`/`contentText` 会去除脚本与危险标签，`url` 会经过协议白名单校验，
> 并且 `contentHtml` **不会被采信**，一律由 `contentText` 重新渲染并净化后生成，防止通过导入文件写入 XSS 载荷。
> 字段长度上限与提交评论一致。
>
> **字段契约**（三端一致）：
> - `pubDate`：同时接受毫秒整数（`1712345678901`）与 ISO 字符串（`2025-10-23T10:00:00.000Z`）；
>   无法解析时使用当前时间。
> - `status`：缺省为 `pending`（与三端表默认值一致，最安全）。
> - `parentId`：用于还原回复关系，导出文件中已包含。

**请求体**：
```json
{
  "comments": [
    {
      "postSlug": "/posts/my-article",
      "author": "张三",
      "email": "zhangsan@example.com",
      "contentText": "写得真好！",
      "contentHtml": "<p>写得真好！</p>",
      "pubDate": "2025-10-23T10:00:00.000Z",
      "status": "approved"
    }
  ]
}
```

**响应（成功）**：
```json
{
  "code": 200,
  "message": "导入完成，成功 10 条，失败 0 条",
  "data": {
    "imported": 10
  }
}
```

**响应（部分失败）**：
```json
{
  "code": 200,
  "message": "导入完成，成功 8 条，失败 2 条",
  "data": {
    "imported": 8,
    "errors": [
      "第 3 条缺少必填字段",
      "第 7 条导入失败: ..."
    ]
  }
}
```

---

### 导入系统设置 (POST `/admin/data/import/settings`)

> 导入之前导出的系统设置 JSON 数据
>
> **字段契约**（三端一致）：
> - 只有白名单内的键会被写入，其余键被忽略。
> - 空字符串**会照写**（用于清空某项配置）；例外是 `email_password` 与 `admin_comment_key`，
>   它们留空表示「未修改」（导出时这两个字段固定为空串）。
> - `ip_blacklist` 必须是合法的 IP/CIDR JSON 数组，否则整个请求返回 400。

**请求体**：
```json
{
  "site_name": "Momo Blog",
  "smtp_host": "smtp.example.com",
  "smtp_port": "465",
  "email_user": "notify@example.com",
  "email_password": "actual-password"
}
```

**响应（成功）**：
```json
{
  "code": 200,
  "message": "设置导入完成，已更新 5 项",
  "data": {
    "updated": [
      "site_name",
      "smtp_host",
      "smtp_port",
      "email_user",
      "email_password"
    ]
  }
}
```

