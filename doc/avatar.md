# 评论区头像来源（avatar source）

> 口径版本：v1。跨语言固定向量：[`vectors/avatar-v1.json`](./vectors/avatar-v1.json)。
> Node / Go / Worker 三端读同一份向量，任何一端漂移都会让对应测试失败。

## 1. 概述

公开评论列表（`GET /api/comments` 及三端的同构接口）为每条评论下发 `avatar` 字段。
头像地址**由服务端按「邮箱」推导**，不落库、不代理图片、不向任何第三方发起请求：

- 默认保持历史行为：`https://open.motues.top/avatar?name=<md5>&mode=cravatar&variant=beam`；
- 管理员可以在面板「系统设置 → 头像设置」里**关闭头像**（关闭后所有评论统一显示内置默认头像），
  也可以选择**预设来源**（Gravatar / Cravatar / QQ 邮箱头像），或填写**自定义 URL 模板**；
- 配置在每个请求读取设置时解析一次，随后对整页评论复用同一份模板；
- 任一环节缺失或非法都**回落到内置默认源**（fail-open），保证评论区永远有头像可用。

头像 URL 出现在公开评论响应里，也出现在两个管理接口（`/admin/comments/list`、
`/admin/stats/users/comments`）里。**管理接口的 `avatar` 不受 `avatar_enabled` 影响**：
开关只约束访客可见的公开列表，后台需要它来识别评论者，因此始终按 `avatar_source` /
`avatar_custom_url` 生成（关闭头像时也不会把 340 字符的内联 SVG 塞进每一行）。
公开响应仍然不会下发 `email` 本身（见 `doc/api.md`）。

## 2. 设置键

| 键 | 默认值 | 说明 |
|---|---|---|
| `avatar_enabled` | `"true"` | 总开关。只有明确 `"false"` 才关闭；关闭后所有评论统一下发 `defaultAvatarUrl` |
| `avatar_source` | `"default"` | 头像来源。取值见下表 |
| `avatar_custom_url` | `""` | 仅当 `avatar_source = "custom"` 时使用；URL 模板，支持占位符 |

三个键都在后台设置接口的白名单内：
`GET/PUT /admin/settings`（分组 `type=avatar`）、`POST /admin/data/import/settings`，
并出现在系统设置导出的完整快照里（见 `doc/vectors/settings-export-v1.json`）。

`avatar_enabled` 的读取语义与 `emoji_enabled` 一致：`trim` + 转小写后，只有 `"false"` 判为关闭，
空串、未知值都 **fail-open** 为开启。关闭**不会清空** `avatar_source` / `avatar_custom_url`，
面板重新开启后按原配置恢复。

### 关闭头像时的默认头像

`avatar_enabled = "false"` 时，公开评论列表对**每一条**评论都下发同一个内置默认头像：

```text
data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIzMiIgZmlsbD0iI2U1ZTdlYiIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMjQiIHI9IjExIiBmaWxsPSIjOWNhM2FmIi8+PHBhdGggZD0iTTEzIDU3YzAtMTAuNSA4LjUtMTkgMTktMTlzMTkgOC41IDE5IDE5IiBmaWxsPSIjOWNhM2FmIi8+PC9zdmc+
```

它是内联 SVG（灰色人像），**零外部请求**，三端常量与向量里的 `defaultAvatarUrl` 逐字一致。
选择内联 SVG 而不是静态路由，是为了让自研前端 / 第三方调用方不需要知道 API 地址即可直接显示。

`avatar_source` 的取值：

| 值 | 含义 |
|---|---|
| `default` | 内置默认源（历史地址，`open.motues.top` + `cravatar` + `beam` 变体） |
| `gravatar` | Gravatar 官方 |
| `cravatar` | Cravatar（`cravatar.cn`） |
| `qq` | QQ 邮箱头像（仅对 `数字@qq.com` 生效，其余邮箱回落 `default`） |
| `custom` | 使用 `avatar_custom_url` 模板；模板为空/非法时回落 `default` |

写入时 `avatar_source` 会 `trim` + 转小写；空串归一化为 `default`。

## 3. 预设模板

| 来源 | 模板 |
|---|---|
| `default` | `https://open.motues.top/avatar?name={hash}&mode=cravatar&variant=beam` |
| `gravatar` | `https://gravatar.com/avatar/{hash}?s=200&d=identicon` |
| `cravatar` | `https://cravatar.cn/avatar/{hash}?s=200&d=identicon` |
| `qq` | `https://q1.qlogo.cn/g?b=qq&nk={qq}&s=100` |

## 4. 占位符

自定义模板只允许以下占位符（区分大小写）：

| 占位符 | 替换值 | 编码 |
|---|---|---|
| `{hash}` | `md5(lower(trim(email)))` 的 32 位小写十六进制 | 无需编码 |
| `{email}` | 归一化后的邮箱 | percent-encode（RFC 3986 非保留字符之外全部编码） |
| `{author}` | 评论者昵称（`trim` 后） | percent-encode |
| `{qq}` | `email` 命中 `^\d+@qq\.com$` 时的数字部分，否则为空串 | 无需编码 |

- 替换是**单遍**的：插入的值不会再次被当作模板解析（`{email}` / `{author}` 里的 `{`、`}`
  也会被 percent-encode）；
- 模板里出现 `{qq}` 但邮箱不是 QQ 邮箱时，整条评论回落 `default`（避免生成
  `...&nk=&s=100` 这种无意义地址）；
- 不含任何占位符的模板合法（等价于全站固定头像）。

percent-encode 口径：只保留 `A-Z a-z 0-9 - _ . ~`，其余 UTF-8 字节一律 `%XX`（大写十六进制）。
这样三端对中文昵称、`+`、`@` 等字符得到逐字一致的结果。

## 5. 读取规则（fail-open）

`resolveAvatarConfig(storedSource, storedCustomUrl)`：

1. `avatar_enabled` 归一化后等于 `"false"` → 直接返回内置默认头像（不再解析来源）；
2. `source = normalize(storedSource)`：未知值或空 → `default`；
3. `source = custom` 且模板为空/非法 → `default`；
4. `source = qq` 且邮箱不是 QQ 邮箱 → 按 `default` 模板生成；
5. 其余情况使用对应预设/自定义模板。

读取路径**不做写入校验**：库里已有的脏值只会让该请求回落默认源，不会让评论列表 500。

## 6. 写入校验

`PUT /admin/settings` 与 `POST /admin/data/import/settings` 共用同一套校验，错误信息三端逐字一致：

| 情况 | 错误信息 |
|---|---|
| `avatar_source` 不在取值表内 | `avatar_source 只能是 default / gravatar / cravatar / qq / custom` |
| `avatar_enabled` 不是 `true` / `false` / 空 | `avatar_enabled 只能是 true 或 false` |
| `avatar_custom_url` 不是字符串 | `avatar_custom_url 必须是字符串` |
| 不是 `http` / `https` 开头 | `avatar_custom_url 只允许 http/https 地址` |
| 超过 500 个字符（按码点计） | `avatar_custom_url 不能超过 500 个字符` |
| 含控制字符（`0x00-0x1F`、`0x7F`） | `avatar_custom_url 不能包含控制字符` |
| 含不支持的 `{...}` 占位符 | `avatar_custom_url 包含不支持的占位符：{foo}` |
| 生效来源为 `custom` 但模板为空 | `选择自定义头像来源时必须填写头像地址` |

- 校验失败整批拒绝、不落库；
- `avatar_enabled` / `avatar_source` 落库前 `trim` + 转小写，`avatar_custom_url` 落库前 `trim`；
- 「生效来源」= 本次请求里的 `avatar_source`（若有）否则库里的当前值；
  「生效模板」同理。因此「把来源切到 `custom` 但没填地址」会被拦下，
  而「把来源切回 `default` 并同时清空模板」是允许的。

## 7. 安全说明

- 模板由管理员配置，属于**可信配置**；但它最终会写进访客浏览器的 `<img src>`，
  所以只允许 `http` / `https`，禁止 `javascript:` / `data:` 等协议；
- 服务端不拉取头像、不校验远端是否可达；图片由访客浏览器直接请求（与表情多来源一致）；
- `{hash}` 是邮箱 MD5，属于「知道邮箱即可计算」的弱标识，和 Gravatar 的既有语义一致；
  `{email}` / `{author}` 会做 percent-encode，不会把原始字符直接拼进 URL；
- 自定义模板里不要填写会泄露隐私的查询参数（它会对所有访客可见）。

## 8. 三端实现位置

| 端 | 文件 |
|---|---|
| Node.js | `nodejs/src/utils/avatar.ts`（读取/校验/生成） |
| Go | `go/internal/pkg/utils/avatar.go` |
| Worker | `worker/src/utils/avatar.ts` |
| 面板 | `dashboard/src/views/AvatarSettings.vue` |

公开评论列表在三端的接入点：

- Node：`nodejs/src/utils/content.ts`（`getResponseComment` / `buildNestedComments`）
- Go：`go/internal/handler/http/comment.go`
- Worker：`worker/src/api/public/getComments.ts`

## 9. 示例

默认源：

```text
邮箱：test@example.com（大小写/空格归一化后）
avatar_enabled = true
avatar_source = default
→ https://open.motues.top/avatar?name=55502f40dc8b7c769880b10874abc9d0&mode=cravatar&variant=beam
```

关闭头像：

```text
avatar_enabled = false
avatar_source = custom（保留但不再生效）
→ data:image/svg+xml;base64,...（所有评论同一张内置默认头像）
```

自定义模板：

```text
avatar_source = custom
avatar_custom_url = https://cdn.example.com/avatar/{hash}.png?email={email}&name={author}
邮箱：张三@example.com，昵称：张 三
→ https://cdn.example.com/avatar/3f848e3f116808796c3e9bc7a7e2cc44.png?email=%E5%BC%A0%E4%B8%89%40example.com&name=%E5%BC%A0%20%E4%B8%89
```

QQ 头像：

```text
avatar_source = qq
邮箱：12345@qq.com
→ https://q1.qlogo.cn/g?b=qq&nk=12345&s=100
```

非 QQ 邮箱在 `qq` 来源下回落默认源。
