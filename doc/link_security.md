# 链接安全审查（休眠链接 + 历史链接批量更新）

本文件是**链接安全审查口径的唯一事实来源**。三端（Node / Go / Worker）必须逐条一致，
口径由 `doc/vectors/link-security-v1.json` 钉死。

这套功能解决两个问题：

1. **休眠链接**：某位评论者很久没再来评论，他留下的个人网站链接可能已经失效甚至被他人接管（域名过期被抢注、
   指向博彩/钓鱼）。系统按「多久没来评论」自动把这些链接标记为**休眠**，其他访客点击时**不再跳转**，
   而是看到「无法访问」的提示；他本人一旦再次评论，休眠**自动解除**；
   管理员也可以对某条休眠链接做**人工确认**（第 2.4 节），确认后一段时间内不再休眠。
2. **历史链接批量更新**：同一位评论者后来提交了新网址，可以把他**所有历史评论**里的旧链接一次性改成新链接；
   由于「邮箱」是唯一的身份凭据，改动前必须向该邮箱发一封**确认邮件**（防止别人冒用邮箱改掉别人的链接）。

---

## 1. 四个设置键

| 键 | 默认值 | 说明 |
|---|---|---|
| `link_security_enabled` | `"false"` | 休眠链接**总开关** |
| `link_dormant_days` | `"30"` | 多久没来评论就算「休眠」，整数 **1–3650** |
| `link_sync_enabled` | `"false"` | 历史链接批量更新开关（**运行时还要求** `email_verify_enabled = "true"` + SMTP 可用 + 该邮箱已通过邮箱验证） |
| `link_dormant_notice_enabled` | `"false"` | 链接**进入休眠时是否给评论者发提醒邮件**（**运行时还要求** 总开关开启 + `email_verify_enabled = "true"` + SMTP 可用 + `email_enabled != "false"`，见第 2.7 节） |

**开关一律 fail-closed**：读取时只有归一化（`trim` + 小写）后等于 `"true"` 才算开启，
其余（空、脏值、`TRUE` 以外的大小写写完就算，见下）一律按**关闭**处理。
这与表情开关的 fail-open **刻意相反** —— 安全功能默认不生效，绝不会因为一个脏值把全站链接拦起来。

### 1.1 写入校验（`PUT /admin/settings` 与导入接口同一套）

| 键 | 规则 | 不满足时 |
|---|---|---|
| `link_security_enabled` | 归一化后只能是 `""` / `"true"` / `"false"`；写入时**存归一化后的值** | `400`，`link_security_enabled 只能是 true 或 false` |
| `link_sync_enabled` | 同上 | `400`，`link_sync_enabled 只能是 true 或 false` |
| `link_dormant_notice_enabled` | 同上 | `400`，`link_dormant_notice_enabled 只能是 true 或 false` |
| `link_dormant_days` | 只能是 **1–3650 的整数**（十进制、无符号、无小数、无单位）；写入时存**规范化后的十进制**（`" 30 "` / `"0030"` → `"30"`） | `400`，`link_dormant_days 必须是 1-3650 之间的整数` |

### 1.2 读取归一化（宽容）

```
enabled = (trim+小写(stored) === "true") ? "true" : "false"      # fail-closed
days    = 整数且 1..3650 ? 该值 : (大于上限 ? 3650 : 30)          # 脏值回退 30，超上限夹取
```

即 `""` / `"   "` / `"abc"` / `"1.5"` / `"0"` / `"-5"` → 30 天；`"99999"` → 3650 天。

---

## 2. 休眠链接

### 2.1 判定口径（读取时实时推导，不落库）

对**每一条评论**：

```
休眠 = 功能开启
      && 该评论有个人网址（url 非空）
      && 该网址归属的邮箱「最后一条评论」距今 **严格大于** N 天
```

- **身份标识是邮箱**：`lower(trim(email))` 归一化后相同即视为同一个人（与 `doc/admin_emails.md` 同一套归一化）。
- **「最后一条评论」跨文章统计**：同一个人在 A 文章评论过、30 天后只在 B 文章评论，
  他在 A 文章的链接同样立刻解除休眠。
- **计数口径**：`status NOT IN ('rejected', 'deleted')` —— `pending`（待审核）也算「来过」，
  否则「他评论了但还在审核」会让链接继续挂着休眠标记，与直觉不符。
- **边界**：`now - lastCommentAt > N * 86400000`（**严格大于**）。刚好 N 天不算休眠；
  N 天零 1 毫秒就算。
- **查不到最后评论时间**（数据缺失/历史脏值）→ **不标记**（fail-open：宁可照常跳转，也不冤枉活人）。
- **功能关闭**（`link_security_enabled != "true"`）→ 所有评论一律 `urlDormant = false`，不做任何查询。
- 实现上按「本页评论涉及的邮箱集合」做**一次**分组查询拿到每个人的最后评论时间（避免 N+1）。

### 2.2 公开接口字段

`GET /api/comments` 返回的**每条评论**新增：

| 字段 | 类型 | 说明 |
|---|---|---|
| `urlDormant` | boolean | 该评论的个人网址是否处于休眠。功能关闭、无网址、无法判定时恒为 `false`（字段始终存在，形状稳定）；见第 2.4 节，人工确认有效时同样为 `false` |

> 该字段在**公开评论列表**（`GET /api/comments`）的每条评论上下发。管理后台的**评论列表**不新增该字段
> （后台自己看得到原始网址，且管理员不该被自己的提示挡住）；但管理后台的**用户列表**
> （`GET /admin/stats/users`）会额外下发 `url`（该用户最近一次留下的非空网址）与 `urlDormant`
> （该链接是否休眠），供面板显示「网站链接」列 —— 两者判定口径完全一致（同一个人按邮箱聚合、
> 跨文章统计最后一条评论、严格大于 N 天）。用户列表还下发 `urlTrustedUntil`（第 2.4 节）。

### 2.3 前端行为

- 评论者昵称与头像上的链接：`urlDormant === true` 时**不再是 `<a>`**，而是一个按钮（**不再有休眠徽标**）；
- 点击后在**昵称旁弹出小浮窗**（不是全屏遮罩、不是 `window.confirm`，样式跟随评论区 CSS 变量）：
  - 文案只有一句：`该评论已经休眠，暂时无法由本站跳转访问`
  - **没有任何继续访问的入口**（浮窗里不含 `<a>`）；
  - 交互：点外部 / 按 Esc / 滚动或改窗口大小 / 再次点击触发元素 → 关闭；
  - 触发元素（昵称、头像）带同名 `title` 与 `aria-expanded`，位置用 `position: fixed` +
    实测坐标（嵌套回复外面套了 `overflow-hidden` 容器，`absolute` 会被裁掉）；
- 多语言文案键（`frontend/src/i18n/`）：`comments.linkDormantTip`（只有这一个）；
- **不做服务端跳转中转**：本站不代理也不探测目标网址（避免 SSRF 与被当成开放重定向）。
  「不跳转」是**界面层**的拦截而不是密码学边界：评论的原始 `url` 本来就在公开接口里，
  因此不承诺「拿不到地址」，只承诺评论区不给出口。

### 2.4 人工确认（管理员放行某条休眠链接）

自动判定难免误伤（域名只是暂时打不开、评论者只是潜水）。管理员在后台**用户列表**看到「休眠」徽标后：

1. 点徽标可在新窗口打开该网址（`rel="noopener noreferrer"`），自己看一眼是否正常；
2. 操作列（在「查看评论」**左侧**）的「确认安全」写入一条 `TrustedLink` 记录（第 2.6 节端点）。

判定口径（三端逐条一致，由 `doc/vectors/link-security-v1.json` 的 `trust` 段钉死）：

```
豁免 = 该 (归一化邮箱, 网址) 存在一条人工确认记录 && expires_at 严格大于 now
休眠 = 功能开启 && 未被豁免 && 有个人网址 && 最后评论距今严格大于 N 天
```

- **有效期 = 确认那一刻的 `link_dormant_days` 天**（默认 30）。落库的是**绝对时间** `expires_at`，
  因此事后改 `link_dormant_days` 不会追溯影响已有确认；
- **粒度是「邮箱 + 网址」**：评论者换了新链接（自己评论或链接同步）后，旧确认不会顺手放行一个没审过的地址；
- **到期自动恢复休眠**：读取时实时比较 `expires_at`，不依赖定时任务；
- **严格大于**才算有效（`expires_at == now` 视为已过期）；
- `expires_at` 只接受写入格式本身（`YYYY-MM-DDTHH:mm:ss.sssZ`，即 `new Date(ms).toISOString()`）：
  空值 / 简写日期 / 带时区偏移 / 数字串一律**不豁免**（fail-closed，管理员重新确认即可）。
  这条刻意写死是因为 JS 的 `Date.parse` 比 Go 的 `time.Parse(RFC3339)` 宽容得多，不钉死会两端给出不同答案；
- 功能关闭时一切都不标记休眠，豁免自然也用不上；但功能关着时**写入**的记录会在功能开启后按 `expires_at` 生效；
- **可撤销**：面板上「撤销确认」删除记录，该链接立刻回到自动判定（该休眠就继续休眠）。

### 2.5 新表 `TrustedLink`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增 ID |
| `email` | TEXT | NOT NULL | 归一化（`trim` + 小写）后的邮箱 —— 与休眠判定的身份口径一致 |
| `url` | TEXT | NOT NULL | 网址（已过 `sanitizeUrl`）；与评论里的 `url` **逐字相等**才算命中 |
| `expires_at` | TEXT | NOT NULL | 到期时间（ISO 8601 UTC，`YYYY-MM-DDTHH:mm:ss.sssZ`） |
| `created_at` | TEXT | NOT NULL | 本次确认时间（同一格式；重复确认会刷新） |
| `source` | TEXT | NOT NULL DEFAULT `'admin'` | 确认来源：`admin` 管理员在用户列表人工确认 / `self` 评论者本人从提醒邮件确认（第 2.7 节） |

索引：`idx_tl_email_url`（`email` + `url`，**UNIQUE**，同时作为幂等 upsert 的落点）、`idx_tl_email`（`email`）。

建表方式与既有表一致：Node `nodejs/src/orm/migrations.ts` 的 `SCHEMA_DDL` + 一条启动自迁移；
Go `go/internal/repository/sqlite/comment.go` 的 `InitSchema` + `migrate.go` 一条迁移；
Worker `worker/schemas/comment.sql` + `worker/src/utils/migrations.ts` 一条版本化迁移
（`CREATE TABLE IF NOT EXISTS`，旧库重启/下次请求自动补表）。

### 2.6 管理端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/admin/links/trust` | 人工确认某条链接安全；body `{ email, url }` |
| `DELETE` | `/admin/links/trust?email=&url=` | 撤销人工确认 |

`POST` 的 `email` 归一化为 `trim` + 小写，`url` 过 `sanitizeUrl`；任一为空 → `400`；
成功 → `200 Link trusted successfully`，`data: { email, url, expiresAt, days }`。
**幂等**：同一 `(email, url)` 重复确认只刷新 `expires_at`（不新增行），写入 `source = 'admin'`。

`DELETE` 幂等：删掉了 → `200 Link trust revoked`（`data.revoked = true`），
本来就没有 → `200 Link is not trusted`（`data.revoked = false`）；缺参数 → `400 email and url are required`。

> 两个端点都**要求管理员登录**（与其它 `/admin/*` 一致）。鉴权失败时的 401 文案沿用各端既有的
> 管理端中间件口径：Node / Go 为 `Invalid token`，Worker 走统一 `adminAuth` 中间件、
> 为 `Unauthorized` / `Token expired or invalid` —— 这是**既有差异**，本次没有为这两个端点特例化。

### 2.7 休眠提醒邮件 + 本人自助页

「链接从正常进入休眠」时，系统可以给评论者本人发一封提醒邮件，他可以确认「仍在用」或直接换新链接。

**发信前提（三端逐条一致，向量见 `link-security-v1.json` 的 `notice.sendGate`）**：

```
发信 = link_security_enabled == "true"
    && link_dormant_notice_enabled == "true"     # 后台「链接安全」页的开关，默认关闭
    && email_verify_enabled == "true"            # 与历史链接同步同一硬前提
    && SMTP 可用 && email_enabled != "false"      # 由发信函数自己再检查一次
```

- 三个设置值都按**同一套 fail-closed 归一化**（`trim` + 小写后等于 `"true"`）判定；
- 开关关闭（含空值 / 脏值）时**什么都不做**：不发信、不查 `DormantNotice`、不落记录。
  因此「先关着攒历史、再打开」与「一直开着」在状态机看来没有区别：打开后第一次有人访问评论区才开始提醒；
- **依赖邮箱验证**：`email_verify_enabled` 未开启时**即使提醒开关打开也不会发信**
  （面板「链接安全」页会显示同样口径的警告，与历史链接同步同款）；
- 后台已打开提醒开关但邮箱验证未开启属于**配置不完整**，面板只提示、不自动改任何设置。

本仓库三端**都没有定时任务**（休眠是读取时实时推导的），因此这封信也挂在读取路径上**惰性触发**：

```
读取公开评论列表（GET /api/comments）
  └─ 本页里有「判为休眠」的链接时 → 异步（不阻塞响应）：
       需要发提醒？（见下面的状态机）
         └─ 是 → 发提醒邮件（成功才落记录）
```

**状态机（`DormantNotice` 表，跨语言向量见 `link-security-v1.json` 的 `notice.needNotify`）**：

```
需要发提醒 = 该链接当前休眠
          && ( 没有提醒记录
               || 记录已过期（提醒页令牌失效）
               || 记录里的 last_comment_at ≠ 当前该邮箱的最后评论时间 )
```

含义：**同一个休眠周期只提醒一次**（锚点是「该邮箱最后一条评论的时间」）；他后来又评论过 =
新的休眠周期（再提醒一次）；记录过期后也会再提醒（顺带刷新令牌与有效期）。

- 邮件发送**成功才**写入/刷新 `DormantNotice`；三个前提任一不满足（见本节开头的发信前提）、
  SMTP 未配置、`email_enabled = "false"`、或发送失败时**不落记录**（下次读取会重试）——
  发信失败也不影响评论列表响应；
- **单个请求最多发 3 封提醒**（`MAX_DORMANT_NOTICES_PER_REQUEST = 3`）：老站点第一次开启本功能时，
  历史上可能一下子有几十条链接同时处于休眠，不设上限就会在第一次有人访问评论区时群发几十封邮件
  （容易被 SMTP 判成垃圾发信）。上限之内的先发，其余留给后续请求 —— 状态机保证不会重复提醒同一次休眠；
- 每次发信都会换新令牌、刷新有效期（新邮件里的链接有效，旧的自然失效），`notify_count` 累加；
- 提醒页有效期 = 发信时刻 + `link_dormant_days` 天（与确认有效期同一口径）；
- 邮件主题（逐字）：`您在 {siteName} 的个人网站链接已进入休眠`；正文包含问候、说明、
  **完整链接**、按钮「查看并确认」+ 明文 URL、两个选项说明、有效期、以及「忽略本邮件即可」。

**公共端点（邮件令牌即凭据，不需要登录；返回中文 HTML 页，不跳转前端）**：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/link-dormant/notice?token=` | 提醒页：显示当前链接 + 「我仍在使用」/「提交新链接」两个表单 |
| `POST` | `/api/link-dormant/confirm?token=` | 确认仍在用 → 恢复正常（写 `TrustedLink`，`source = 'self'`，删除提醒记录） |
| `POST` | `/api/link-dormant/update?token=` | 表单字段 `url`：批量改掉该邮箱历史评论的链接 + 为新链接写本人确认 + 删除提醒记录 |

- `update` 的 `url` 必须过 `sanitizeUrl` **且以 `http://` / `https://` 开头**，否则
  `新链接格式不正确，请填写以 http:// 或 https:// 开头的网址。` 且**不改任何评论**；
- 批量改写沿用「历史链接批量更新」的同一口径（`status NOT IN ('rejected','deleted')`、
  只改本来就有网址且与目标不同的行）；
- 两个动作都是**一次性**的：动作完成后提醒记录被删除，同一个令牌再访问就是「该提醒已失效或已处理」；
- 结果页文案（逐字）：`确认成功！该链接已恢复正常，{N} 天内不会再标记为休眠。` /
  `链接更新成功！共 {count} 条历史评论的网址已更新。` / `新链接与现有链接相同，未做修改。` /
  `新链接格式不正确，请填写以 http:// 或 https:// 开头的网址。` / `缺少提醒参数。` /
  `该提醒已失效或已处理。` / `该提醒已过期，请在评论区留言或等待新的提醒邮件。` /
  `处理失败，请稍后重试。`

> **确认后为什么有效期只有 N 天**：与管理员人工确认同一口径。到期后如果他还是没来评论，
> 会再次休眠并再发一封提醒 —— 这是需求确认过的行为（避免「一次确认就把一个可能已被抢注的
> 域名永久放行」）。

## 3. 历史链接批量更新

## 3. 历史链接批量更新

### 3.1 开启条件（全部满足才会发确认邮件）

1. `link_sync_enabled = "true"`（fail-closed）；
2. `email_verify_enabled = "true"`（**必须**先开启邮箱验证，这条在需求里就是硬前提）；
3. SMTP 可用（`isEmailServiceAvailable`）；
4. 提交评论的邮箱**已经通过邮箱验证**（`EmailVerification.verified = 1`）；
5. 本次提交的 `url` 非空，且该邮箱**存在历史评论**：`url` 非空且与本次提交的 `url` **不同**
   （状态同样是 `status NOT IN ('rejected','deleted')`）。

任一条不满足 → 什么都不做，评论照常落库。

### 3.2 流程

```
评论者提交评论（带新网址 url=newUrl）
   └─ 满足 3.1 → 写一条待确认记录 + 异步发确认邮件（不阻塞评论提交，也不改任何历史评论）
         邮件链接：GET {baseUrl}/api/link-sync/confirm?token=<token>&email=<email>
             └─ 校验通过 → 把该邮箱**所有**历史评论的 url 改为 newUrl（状态过滤同上），
                标记已确认，返回 HTML 结果页（与邮箱验证同款样式）
```

- 同一邮箱**只保留一条有效待确认记录**：写入新记录时，把该邮箱既有的
  「未确认且未过期」记录一并作废（置为已过期或删除），保证邮件里的旧链接立刻失效；
- **去重**：同一邮箱 + 同一 `newUrl` 已有未过期未确认记录时不重复发信；
- 确认页与邮箱验证页一样是**纯 HTML 结果页**（中文文案 + 成功/失败图标），不跳转前端。

**确认邮件（内置模板，不提供自定义模板）**，主题固定为：

```
确认更新您在 {siteName} 上的历史评论链接
```

正文必须包含（三端同一套 HTML 结构，均可自行排版）：

1. 问候语（评论者昵称）；
2. 说明「您刚提交了一个新的个人网址，系统将把它同步到您以前的所有评论」；
3. **旧网址 → 新网址** 与页面地址（文章标题/链接，若有）；
4. 确认链接（`<a href>` 按钮 + 明文 URL，`word-break: break-all`）；
5. 「此链接 24 小时内有效。如果您没有提交新网址，请忽略此邮件，您的历史评论不会被修改。」

### 3.3 新表 `LinkSyncRequest`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | 自增 ID |
| `email` | TEXT | NOT NULL | 归一化（`trim` + 小写）后的邮箱：**身份凭据** |
| `new_url` | TEXT | NOT NULL | 新网址（已过 `sanitizeUrl`，只可能是 http/https/mailto/相对路径） |
| `token` | TEXT | NOT NULL UNIQUE | 一次性确认令牌（Node/Worker 用 `crypto.randomUUID()`，Go 用 32 字节随机十六进制） |
| `expires_at` | TEXT | NOT NULL | 过期时间（ISO 8601 UTC，**24 小时**） |
| `confirmed` | INTEGER | NOT NULL DEFAULT 0 | 是否已确认（0/1，单次使用） |
| `created_at` | TEXT | NOT NULL | 创建时间（ISO 8601 UTC） |

索引：`idx_lsr_email`（`email`）、`idx_lsr_token`（`token`）。

建表方式与既有表一致：Node `nodejs/src/orm/migrations.ts` 的 `SCHEMA_DDL` + 一条启动自迁移；
Go `go/internal/repository/sqlite/comment.go` 的 `InitSchema` + `migrate.go` 一条迁移；
Worker `worker/schemas/comment.sql` + `worker/src/utils/migrations.ts` 一条版本化迁移
（`CREATE TABLE IF NOT EXISTS`，旧库重启/下次请求自动补表）。

### 3.4 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/link-sync/confirm?token=&email=` | 确认并执行批量更新；返回 HTML 结果页 |

结果页的四种情形（文案三端一致）：

| 情形 | 结果 |
|---|---|
| 缺少 `token` 或 `email` | 失败：`缺少确认参数` |
| 查不到记录（token/email 不匹配） | 失败：`确认链接无效` |
| `confirmed = 1` | 成功：`该链接同步已完成` |
| 已过期 | 失败：`确认链接已过期，请重新提交评论以获取新的确认邮件` |
| 正常 | 成功：`链接同步完成！共 N 条历史评论的网址已更新` |

### 3.5 安全说明

- **邮箱是唯一身份凭据**：只有能收到该邮箱邮件的人才能确认，因此「别人冒用同一邮箱提交新网址」
  只能改到自己**本次提交的那条**评论（那条本来就是他自己写的），改不动历史评论；
- 令牌**一次性**（`confirmed` 置 1 后不可重放）、**24 小时**有效、**不可猜测**（≥122 位随机）；
- 端点**不需要登录**（与邮箱验证端点同一模型：邮件链接即凭据）；
- **不做速率限制以外的新风控**，但确认端点不写认证记录、不落 IP；
- 批量更新**只改 `url` 字段**，不动 `content_html` / `content_text`；
- 更新后 `url != new_url` 的老评论才被写（幂等，重复确认不会产生额外写入）。

---

## 4. 实现位置

| 端 | 文件 |
|---|---|
| Node | `utils/linkSecurity.ts`（设置归一化 + 休眠判定 + 人工确认有效期）、`utils/adminEmails.ts`（邮箱归一化）、`orm/schema.ts` + `orm/migrations.ts`（两张新表）、`orm/commentService.ts`（分组查询 + 人工确认读写 + 批量更新）、`api/public/postComment.ts`（触发）、`api/public/linkSyncConfirm.ts`（确认端点）、`api/admin/linkTrust.ts`（人工确认端点）、`utils/email.ts`（确认邮件）、`utils/content.ts`（下发 `urlDormant`） |
| Go | `internal/pkg/utils/link_security.go`、`internal/repository/sqlite/{comment.go,migrate.go}`、`internal/handler/http/{comment.go,link_sync.go,router.go}`、`internal/pkg/utils/email.go` |
| Worker | `src/utils/linkSecurity.ts`、`src/utils/migrations.ts` + `schemas/comment.sql`、`src/api/public/{postComment.ts,linkSyncConfirm.ts}`、`src/api/admin/linkTrust.ts`、`src/utils/email.ts`、`src/index.ts` |
| 面板 | `dashboard/src/views/LinkSecuritySettings.vue`（+ 路由与设置入口卡片）、`dashboard/src/views/Users.vue`（休眠徽标可点击打开 + 链接状态筛选 + 操作列「确认安全 / 撤销确认」）、`dashboard/src/views/MailManagement.vue`（邮件管理） |
| 前端 | `frontend/src/comment/CommentItem.svelte`、`frontend/src/i18n/*` |
