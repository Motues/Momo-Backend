# 多管理员邮箱与通知收件人

本文件是**管理员邮箱口径的唯一事实来源**。三端（Node / Go / Worker）的校验与读取归一化必须逐条一致，
口径由 `doc/vectors/admin-emails-v1.json` 钉死。

> **1.8.0 变更**：新增 `admin_emails`（数组）与 `notify_email`（通知收件人），
> 旧的 `admin_email`（单邮箱）**继续兼容**。

---

## 1. 三个设置键

| 键 | 默认值（未配置时） | 说明 |
|---|---|---|
| `admin_emails` | `[]` | **管理员邮箱列表**（JSON 数组字符串，最多 10 个）。列表里的人都是博主 |
| `admin_email` | `""` | **旧键（单邮箱）**：仅在 `admin_emails` 解析为空时回落成单元素列表；v3 起不再由面板写入 |
| `notify_email` | `""` | **通知收件邮箱**：必须命中管理员列表，否则读取时回落到列表第一个 |

三个键都是**字符串**；`admin_emails` 是 JSON 数组的字符串形式（如 `["a@x.com","b@y.com"]`）。

## 2. 邮箱校验

三端共用同一条判定（**先 `trim` 再校验**，长度按 UTF-16 / 字节无关的字符数，上限 254）：

```
^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$    且  长度 ≤ 254
```

刻意不做 RFC 5322 全量解析：只挡明显非法形态（无 `@`、无 TLD、含空格、`<a@b.com>` 这类尖括号包裹、
`a@@b.com`、`a@b..com`）。归一化一律是 `trim` + **转小写**。

## 3. 写入路径（严格）

`PUT /admin/settings` 与 `POST /admin/data/import/settings` 同一套：

| 键 | 规则 | 不满足时 |
|---|---|---|
| `admin_emails` | `trim` 后为空视为「未配置」（存 `[]`）；否则必须是 **JSON 数组**，每一项都是字符串；归一化（trim + 小写）后丢弃空串、**去重**，剩下的**最多 10 个**，每个都必须是合法邮箱；写入时**存归一化去重后的 JSON 数组** | `400`，消息见下表 |
| `notify_email` | `trim` 后为空 = 清空（读取时回落列表第一个）；否则必须是合法邮箱，且归一化后**必须命中**管理员列表 | `400`，消息见下表 |

校验**顺序**也是三端一致的（决定了同时命中多条规则时报哪一条）：

```
不是 JSON 数组 → 有非字符串项 → 归一化去空去重后超过 10 个 → 有非法邮箱
```

即：同一个地址写 11 遍**不算**超限（去重后只剩 1 个）；`[…11 个合法地址…, 1]` 报「每一项都必须是字符串」而不是「最多 10 个邮箱」。

`admin_emails` 的 4 条错误文案（三端逐字一致）：

| 情形 | 消息 |
|---|---|
| 不是合法 JSON / 不是数组 | `admin_emails 必须是 JSON 数组` |
| 数组里有非字符串项 | `admin_emails 的每一项都必须是字符串` |
| 归一化去空后超过 10 个 | `admin_emails 最多 10 个邮箱` |
| 有非法邮箱 | `admin_emails 包含非法邮箱地址` |

`notify_email` 的 2 条错误文案：

| 情形 | 消息 |
|---|---|
| 不是合法邮箱（非空时） | `notify_email 必须是合法的邮箱地址` |
| 归一化后不在管理员列表里 | `notify_email 必须在管理员邮箱列表中` |

**「在列表里」判定用的列表**：同一次请求里若同时提交了 `admin_emails`，用**新列表**判定；
否则用**当前库里**解析出的列表（`admin_emails` 为空时即旧键 `admin_email` 的单元素列表）。
列表为空时提交 `notify_email` 一律 `400`（没有列表可命中）。

`admin_email`（旧键）的写入语义不变：**原样存储**（不 `trim`、不做大小写归一），
以保证旧版本/旧配置读到的值与历史一致；读取时统一走 `normalizeEmail`（`trim` + 小写）判定，
所以值里带两侧空格不会影响任何行为。

## 4. 读取路径（宽容）

```
admins = parseAdminEmails(storedAdminEmails)     # 见下
if admins 为空:
    legacy = normalize(storedAdminEmail)         # 旧键回落
    admins = isEmail(legacy) ? [legacy] : []
notify = normalize(storedNotifyEmail) ∈ admins ? normalize(storedNotifyEmail) : (admins[0] || "")
```

`parseAdminEmails` 的容错规则：

1. `null` / `undefined` / 空串 / 只有空白 → `[]`；
2. 不是合法 JSON、或 JSON 不是数组 → `[]`；
3. 数组里**非字符串项丢弃**、非法邮箱丢弃、空串丢弃；
4. 归一化后**去重保序**，**截断到前 10 个**。

即：列表为空 → 回落旧键，旧键也为空/非法 → 视为「没有管理员」；
`notify_email` 命中不了列表 → 回落到列表第一个；列表为空 → 空串（不发通知）。

## 5. 管理员列表决定什么

邮箱命中管理员列表（`admins.includes(normalize(email))`）即视为**博主**，三端一致：

| 行为 | 说明 |
|---|---|
| 免 60 秒评论冷却 | 管理员邮箱提交评论不受限流（仍受 IP/邮箱黑名单约束） |
| 博主标识 `isBlogger` | 公开接口按列表判定，命中即下发 `isBlogger: true` |
| 管理员评论密钥 | 命中列表才校验 `admin_comment_key`；通过后评论直接 `approved`，且跳过垃圾规则与无感验证 |
| `admin_email_hashes` | 公开接口在 `admin_comment_key_enabled = "true"` 时才下发**哈希数组**（`sha256(lower(trim(email)))`），供前端决定是否显示密钥输入框。**旧字段 `admin_email_hash` 仍然下发**（= 通知邮箱的哈希）以兼容旧前端 |

> 哈希只在密钥功能开启时下发，原因与旧版一致：避免被用于离线枚举管理员邮箱。

## 6. `notify_email` 决定什么

| 行为 | 说明 |
|---|---|
| 新评论通知收件人 | `sendCommentNotification` 发给 `notify_email`（解析后的值） |
| 后台「发送测试邮件」收件人 | `POST /admin/settings/test-email` 发给 `notify_email`；未配置时回落到管理员列表第一个 |
| 回复通知 | **不受影响**：仍然发给被回复的那条评论的作者 |

`notify_email` 为空且管理员列表非空时，默认收件人是**列表第一个**。

## 7. 升级与兼容

- 只配了旧键 `admin_email`：读取等价于 `admin_emails = [normalize(admin_email)]`，通知收件人就是它，行为与 1.7.0 完全一致；
- 面板（Dashboard）保存「管理员邮箱」时同时写 `admin_emails` 与 `admin_email`（= 通知邮箱），
  这样**旧版本后端/旧快照**读到的仍是同一个邮箱，回滚不会丢配置；
- `notify_email` 不在列表里时**不会**报错（读取回落第一个），但面板保存时会拦下来并提示。

## 8. 实现位置

| 端 | 文件 |
|---|---|
| Node | `nodejs/src/utils/adminEmails.ts`（校验/归一化/解析）、`utils/content.ts`（下发）、`utils/email.ts`（收件人）、`api/admin/settings.ts`（校验与写入）、`api/public/postComment.ts`（博主判定） |
| Go | `go/internal/pkg/utils/admin_emails.go`、`utils/settings.go`（白名单）、`utils/email.go`、`handler/http/{admin.go,comment.go}` |
| Worker | `worker/src/utils/adminEmails.ts`、`api/admin/settings.ts`、`utils/email.ts`、`api/public/{postComment.ts,getComments.ts}` |
| 面板 | `dashboard/src/views/BasicSettings.vue` |
| 前端 | `frontend/src/comment/{Comments,CommentItem}.svelte`（哈希数组判定） |
