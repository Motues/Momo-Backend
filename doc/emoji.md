# 表情（owo.json 来源）

评论区的表情面板只有 OwO 格式的来源：管理员配置的**一组** OwO 格式地址（owo.json 同构，
最多 5 个），由访客浏览器**直接拉取**并按配置顺序**拼接合并**成一个面板，本站既不代理也不存储任何表情内容。

本文件是**格式与配置的唯一事实来源**。三端（Node / Go / Worker）的校验必须与这里逐条一致，
口径由 `doc/vectors/emoji-v3.json`（多来源，现行）与 `doc/vectors/emoji-v2.json`（单来源，兼容）钉死；
面板侧还有一层「保存前在线校验 OwO 格式」的护栏。

> **契约 v3（1.8.0）变更**：新增 `emoji_cdn_urls`（JSON 数组，最多 5 个地址，按顺序拼接合并）。
> 旧的 `emoji_cdn_url`（单地址）**继续兼容**：仅在 `emoji_cdn_urls` 解析为空时作为回落。
> 公开接口新增 `emoji_cdn_urls` 数组字段，同时保留 `emoji_cdn_url` = 数组第一个地址（旧前端不受影响）。
>
> **契约 v2（1.7.0）变更**：v1 的「自定义表情包」（`Settings.emoji_packs`）与公开接口
> `GET /api/emoji` 已**整体删除**，取而代之的是 `emoji_enabled` 开关 + 可修改的表情来源地址。

---

## 1. 三个设置键

| 键 | 默认值（未配置时） | 说明 |
|---|---|---|
| `emoji_cdn_urls` | `[]` | **OwO 格式地址数组**（JSON 数组字符串，最多 5 个，见第 2 节）。按数组顺序拼接合并；**由访客浏览器直接拉取**，本站不代理 |
| `emoji_cdn_url` | `https://open.motues.top/emoji/owo.json` | **旧键（单地址）**：仅在 `emoji_cdn_urls` 解析为空时作为回落；v3 起不再由面板写入 |
| `emoji_enabled` | `"true"` | 是否在评论区显示表情按钮 |

- 三者都是**字符串**：`emoji_enabled` 取 `"true"` / `"false"`；`emoji_cdn_urls` 是 JSON 数组的字符串形式（如 `["https://a/owo.json","https://b/owo.json"]`）。
- 写入路径：`PUT /admin/settings`、`POST /admin/data/import/settings`（同一套校验）。
- 读取路径：`GET /api/comments` 的响应体里以 `emoji_enabled` / `emoji_cdn_urls`（数组）/ `emoji_cdn_url`（=第一个地址）下发，
  前端据此决定「显示按钮 + 从这些地址拉 owo.json 并合并」。`GET /admin/settings?type=emoji` 返回 `emoji_enabled` + `emoji_cdn_urls`（外加兼容用的 `emoji_cdn_url`）。
- 数组为空（未配置）→ 先回落 `emoji_cdn_url`，仍为空再回落默认源；**关闭表情请用 `emoji_enabled = "false"`**。

## 2. owo.json 格式

顶层是「对象」，**每个键就是一个标签页的名字**，键的顺序就是标签栏的顺序：

```json
{
  "颜文字": {
    "type": "emoticon",
    "container": [
      { "icon": "OωO", "text": "Author: DIYgod" },
      { "icon": "|´・ω・)ノ", "text": "Hi" }
    ]
  },
  "Bilibili": {
    "type": "image",
    "container": [
      { "icon": "<img src=\"https://open.motues.top/static/emoji/bilibili/3dea3d8c….png\">", "text": "doge" }
    ]
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| 顶层键 | ✅ | 标签页文案，建议 1–32 字符，不可为空白 |
| `type` | ❌ | `emoji` / `emoticon` / `image`；缺省按 `image` 处理；无法识别的值前端按 `image` 处理 |
| `container` | ✅ | 表情数组，至少 1 项 |
| `container[].icon` | ✅ | `emoji`/`emoticon` 为要插入的文本；`image` 为严格的 `<img src="…">` |
| `container[].text` | ❌ | 悬停提示；`image` 项同时用作短代码推导依据，见第 5 节 |

`type` 语义：

| type | `icon` 形态 | 点击后面板插入什么 | 评论正文里存什么 |
|---|---|---|---|
| `emoji` | Unicode emoji，如 `😂` | 直接插入 `icon` | `😂` |
| `emoticon` | 颜文字，如 `OωO` | 直接插入 `icon` | `OωO` |
| `image` | `<img src="…">` | 插入短代码 `:name:` | `:name:` |

`image` 项**不会**把 `<img>` 塞进评论正文：本项目评论走 Markdown 渲染 + 服务端净化，
而 Go 的 bluemonday 与 Worker 的正则净化都会剥掉 `data:` 图片。统一存 `:name:` 短代码，
由前端渲染时替换成内联小图，可以同时满足三端，并且在表情源换掉后**优雅降级为纯文本**而不是图裂。

### 官方来源与「只取某个标签」

默认源 `https://open.motues.top/emoji/owo.json` 含 5 个标签
（`颜文字` / `Emoji` / `Bilibili` / `QQ` / `小黑盒`）。站点支持用查询参数只取其中一个标签：

```
https://open.motues.top/emoji/owo.json?group=Emoji   # 只保留 Emoji 标签
```

对本项目而言它只是一个普通地址（前端原样 `fetch`），因此配置成该形式即可。

## 3. 校验与归一化

### 3.1 写入路径（严格）

| 键 | 规则 | 不满足时 |
|---|---|---|
| `emoji_enabled` | 归一化（`trim` + 转小写）后只能是 `""` / `"true"` / `"false"`；写入时**存归一化后的值** | `400`，消息 `emoji_enabled 只能是 true 或 false` |
| `emoji_cdn_urls` | `trim` 后为空视为「未配置」（存 `[]`）；否则必须是 **JSON 数组**，每一项都是字符串；去掉两侧空格并丢弃空串后**最多 5 个**，每个都必须是 `^https?://[^"<>]+$`（大小写不敏感）且 ≤ **500** 码点；写入时**存归一化后的 JSON 数组**（trim + 去空） | `400`，消息见下 |
| `emoji_cdn_url` | `trim` 后为空视为「未配置」；否则必须是 `^https?://[^"<>]+$`（大小写不敏感）且 ≤ **500** 码点；写入时自动去掉两侧空格 | `400`，消息 `emoji_cdn_url 只允许 http/https 地址` / `emoji_cdn_url 不能超过 500 个字符` |

`emoji_cdn_urls` 的 5 条错误文案（三端逐字一致，见 `doc/vectors/emoji-v3.json` 的 `errors`）：

| 情形 | 消息 |
|---|---|
| 不是合法 JSON / 不是数组 | `emoji_cdn_urls 必须是 JSON 数组` |
| 数组里有非字符串项 | `emoji_cdn_urls 的每一项都必须是字符串` |
| 去空后超过 5 个 | `emoji_cdn_urls 最多 5 个地址` |
| 某一项不是 http/https | `emoji_cdn_urls 只允许 http/https 地址` |
| 某一项超过 500 码点 | `emoji_cdn_urls 不能超过 500 个字符` |

- 长度单位一律是 **Unicode 码点**（不是字节，也不是 UTF-16 码元）。
- `null` / `undefined` 视为「未提供」，通过校验（写入路径会跳过它们）。
- 非法取值一律 `400` 且**不落库**；同一次请求里多个键任一非法则**整批不落库**（与既有语义一致）。
- `emoji_packs` 已从白名单移除：`PUT /admin/settings` 会以 `Setting "emoji_packs" is not allowed` 拒绝；
  导入接口按既有的「白名单过滤」语义**静默忽略**未知键（不落库、返回 200）。

### 3.2 读取路径（宽容）

读取时用同一个 `resolve` 口径（三端一致，fixture 的 `resolve` 段钉死）：

```
urls    = parseRead(storedUrls)                  # 见下；最多取前 5 个
if urls 为空:
    legacy = trim(storedCdnUrl)                  # 旧键回落
    urls = legacy == "" ? [DEFAULT] : [legacy]
enabled = (trim+小写(storedEnabled) === "false") ? "false" : "true"
legacyOut = urls[0]                              # 下发给旧前端的 emoji_cdn_url
```

`parseRead` 的容错规则（读取路径刻意比写入路径宽松，历史脏值不能让面板/评论区整体不可用）：

1. `null` / `undefined` / 空串 / 只有空白 → `[]`；
2. 不是合法 JSON、或 JSON 不是数组 → `[]`；
3. 数组里**非字符串项直接丢弃**、字符串项 `trim` 后为空的丢弃；
4. 结果**截断到前 5 个**（顺序保持）。

即：地址数组为空/只有空白 → 回落旧键，旧键也为空 → 回落默认源；开关为空或无法识别 → **fail-open 为启用**；
`FALSE` / `False` 这类历史脏值同样判为关闭；**关闭时地址照常下发**（面板不会丢掉配置）。

### 3.3 多来源的拼接合并

访客浏览器按 `emoji_cdn_urls` 的**数组顺序**依次拉取，把结果合并成**一个** owo 对象：

- 顶层标签按「首次出现」的顺序排列；
- 不同来源出现**同名标签**时，后面的来源把 `container` **追加**进先出现的那个标签（不新建标签页）；
- 短代码去重仍按第 5 节：同标签内重名、或与更靠前的标签重名时追加 `-2` / `-3`……，
  保证每个条目都能水合回**它自己**那张图；
- 某个来源拉取失败（网络 / 跨域 / 非 JSON）时**只丢这一个来源**，其余来源照常合并，
  并在面板里显示「部分来源加载失败」的重试入口；全部失败才回退本地缓存；
- 类型不同（`emoji`/`emoticon`/`image`）的来源可以随意混合：每个标签各自按自己的 `type` 渲染；
- **同名标签合并后沿用「先出现」那个标签的 `type`**：把 `emoji`/`emoticon` 与 `image` 混进同一个
  标签名时，后者追加进来的图片项会按前者的类型处理（渲染成文本）。
  需要两种渲染就把标签起成不同的名字（例如 `Bilibili` 与 `Bilibili 动图`）。

## 4. 面板侧的在线校验（OwO 格式护栏）

后台保存前，面板用**浏览器**逐条 `fetch` 配置的地址并检查它们是不是 owo.json 形状
（规则逐条同下，**每条地址独立判定**）：

1. 顶层必须是对象（不能是数组 / 字符串），且**至少有一个标签**；
2. 每个标签的值必须是对象，且 `container` 是数组；
3. 每一项必须是对象，`icon` 是非空字符串；
4. `type` 若存在，必须是 `emoji` / `emoticon` / `image`；
5. 至少有一个标签通过 1–4（全都不合格视为「不是 owo.json」）。

> 校验的是**形状**：`container` 为空数组的标签也算「形状合格」，只是不会在面板里出现表情项，
> 前端构建标签时会跳过空标签（与第 2 节的「container 至少 1 项」是两回事：前者是给管理员的护栏，
> 后者是本站自己产出 owo.json 时的约定）。

逐条地址的结果分三种：

| 结果 | 面板行为 |
|---|---|
| 通过 | 汇总显示「校验通过：N 个来源 / T 个标签 / M 个表情」（T/M 是各来源之和） |
| 明确不是 owo.json（拉取成功但形状不对） | 显示「第 k 条：<第一条原因>」，**阻止保存** |
| 拉取失败（网络 / 跨域被拦） | 提示「第 k 条无法在线校验（可能被跨域限制拦截），仍可保存」，允许保存 |

这层校验只是给管理员的**护栏**，不是安全边界：地址由管理员自己填写，前端也只是把它交给
`fetch` 与 `<img>`；后端只做第 3.1 节的形状校验（服务端抓取第三方地址会引入 SSRF 与保存延迟，
刻意不做）。**唯一的例外是通知邮件**：为了让邮件里的 `:name:` 能显示成图片，发信路径会按同一批
地址在服务端拉取一次（带超时、响应体上限与内存缓存，失败即降级为文字），见 `doc/mail.md`。

## 5. 短代码（shortcode）推导

`image` 项在评论里以 `:name:` 表示。`name` 由前端按固定规则推导（面板与渲染侧同一函数）：

1. 把 `text` 小写化，非 `[a-z0-9]` 的字符替换为 `-`，压缩连续 `-` 并去掉首尾 `-`；
   结果匹配 `^[a-z0-9][a-z0-9-]{0,31}$` 时直接使用（例：`tv_doge` → `tv-doge`、`doge` → `doge`）；
2. 否则取 `src` 的 **FNV-1a 32 位**哈希的 8 位十六进制，拼成 `e-<8hex>`
   （例：`https://open.motues.top/static/emoji/bilibili/3dea3d8c3ebf19f4734afbe32c62f4a158cd3ebd.png` → `e-3fb127fe`）。
   刻意不用 WebCrypto 的 SHA-1：水合发生在渲染路径上，需要**同步**哈希，且非安全上下文
   （http 站点）里 `crypto.subtle` 根本不存在；
3. 同一包内重名时追加 `-2`、`-3`…；
4. **跨包重名时，标签栏靠前的包先占名，后来的包追加 `-2`、`-3`…**（每个条目都必须能水合回
   **它自己**那张图）。水合侧仍是「先到先得」，所以老评论里已有的 `:doge:` 不会图裂，只是继续
   指向靠前包的那张图。

> 第 4 条曾经是「跨包重名就让后来的包共用前一个包的名字」。默认源里 `Bilibili` 与 `QQ` 有
> **33 个同名表情**（`doge` / `sob` / `heart-eyes` …），前者是静态 PNG、后者是动图 GIF，
> 共用名字会让用户从 QQ 面板选的**动图在评论正文里变成 Bilibili 的静图**（看起来就是「GIF 不动了」）。
> 因此后来的包改为追加后缀，例如 QQ 的 `doge` → `:doge-2:`；`Bilibili` 的 `:doge:` 不变。
>
> 代价（刻意接受）：追加后缀的名字依赖**标签顺序**，若管理员之后删掉了靠前的那个包，
> 老评论里的 `:doge-2:` 会退化成纯文本（`:doge:` 本身没有这个问题）。两害相权取其轻 ——
> 让用户在评论里看到「自己选的那张图」比这个边界情况更重要。

短代码只匹配小写形式（正则 `:[a-z0-9][a-z0-9-]{0,31}:`），并且要求**名称前一个字符不是字母/数字、
后一个字符不是数字**（因此 `12:30:45` 不会被替换，而 `:doge:紧跟英文` 仍会被替换），
同时**不替换 `<code>` / `<pre>` 内的文本**。未命中的短代码原样保留为纯文本。

## 6. 前端加载策略

- **文章页零第三方请求**：首屏只读 `localStorage` 里的 owo.json 缓存（**7 天** TTL，
  缓存键是**整个地址列表**的规范化 JSON），因此首次访问时图片表情会先显示为 `:name:` 文本，
  **打开一次面板后即恢复**；
- owo.json 在**首次打开面板**时才拉取（多个地址并发拉取后按顺序合并，见第 3.3 节）；
- **部分来源失败不拖垮整体**：成功的那几个照常渲染，面板底部提示「部分来源加载失败（可重试）」；
  全部失败时回退旧缓存（并提示 stale）；一个来源都拿不到且没有缓存时面板显示可重试的错误态；
- `emoji_enabled = "false"`（或地址列表为空）→ 不渲染表情按钮、不拉取任何地址；
- 自定义表情包与 `GET /api/emoji` 已删除，前端不再有任何指向本站的表情请求。

**面板布局**（仅视觉，不影响上面的加载口径）：

- 面板开在按钮**下方**（不遮挡输入框），高度取「按钮底边 → 视口底边」的剩余空间，
  在 96px（下限，再小就没法用，宁可让页面滚动）与 256px（上限）之间自适应，resize / 滚动时重算；
- 面板宽度是**确定值** `min(24rem, 100vw - 2rem)`（切换标签、开合都不变，窄屏自动收窄），
  圆角 0.25rem —— 不要用 `max-content`：图片包的 `repeat(auto-fill, 2rem)` 在内在尺寸下只算 1 列，
  会让这三个包的面板塌到标签栏宽度，比文本包窄一截；
- 颜文字（`emoji` / `emoticon` 包）用 `flex-wrap` 按内容宽度排布（字号 0.875rem，条目最小 2rem 见方），
  图片包用 2rem 等宽网格（列数随面板宽度 auto-fill，窄屏自动减列）；
- 标签栏换行而非横向滚动，超长颜文字在自身按钮内换行 —— 面板内不出现横向滚动条。

## 7. 示例

**A. 使用默认源（全量）**：`emoji_cdn_urls = []`（未配置 → 回落默认源 `https://open.motues.top/emoji/owo.json`）

**B. 只保留 Emoji 标签**：`emoji_cdn_urls = ["https://open.motues.top/emoji/owo.json?group=Emoji"]`

**C. 拼接两个自建来源**（第一个来源的标签在前，同名标签把后者的表情追加进来）：

```json
["https://cdn.example.com/emoji/owo.json", "https://other.example.com/emoji/owo.json"]
```

**D. 自建 owo.json**：把第 2 节形状的 JSON 放到任意 `https://` 地址即可，例如

```json
{
  "我的表情": {
    "type": "image",
    "container": [{ "icon": "<img src=\"https://cdn.example.com/emoji/hi.png\">", "text": "hi" }]
  },
  "颜文字": {
    "type": "emoticon",
    "container": [{ "icon": "OωO", "text": "Hi" }]
  }
}
```

**E. 关闭表情**：`emoji_enabled = "false"`（评论区不再显示表情按钮）。

**F. 旧键仍可用**（升级兼容）：只设置 `emoji_cdn_url = "https://cdn.example.com/owo.json"`、
不设置 `emoji_cdn_urls`，行为与 v2 完全一致。
