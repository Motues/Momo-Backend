# 通知邮件的内容渲染

本文件是**邮件正文渲染口径的唯一事实来源**。三端（Node / Go / Worker）必须逐条一致。

> **1.8.0 变更**：通知邮件不再只发**纯文本**正文，而是发送**渲染后的 HTML**：
> Markdown 图片、链接、表情包短代码都会按评论区的样子显示在邮件里。

---

## 1. 有哪几封邮件

| 邮件 | 收件人 | 正文来源 | 自定义模板 |
|---|---|---|---|
| 新评论通知 | `notify_email`（见 `doc/admin_emails.md`） | 评论的 `content_html` + 短代码水合 | `notification_template` |
| 回复通知 | 被回复评论的作者邮箱 | 回复的 `content_html`、原评论的 `content_html` + 水合 | `reply_template` |
| 邮箱验证 | 评论者本人 | 内置模板（不含评论正文） | ❌ |
| 链接同步确认 | 评论者本人 | 内置模板（不含评论正文） | ❌ |
| **休眠链接提醒** | 评论者本人 | 内置模板（不含评论正文，含提醒页链接） | ❌ |
| 测试邮件 | `notify_email` | 内置模板 | ❌ |

> 休眠链接提醒见 [`link_security.md`](./link_security.md) 第 2.7 节：链接进入休眠时提醒本人
> 「仍在用 / 换新链接」，由公开评论列表的读取路径惰性触发（三端都没有定时任务）。

## 2. 占位符

**回复模板**（`reply_template`）：

| 占位符 | 值 | 转义 |
|---|---|---|
| `{{toName}}` `{{replyAuthor}}` `{{postTitle}}` `{{postUrl}}` | 纯文本 | **HTML 转义** |
| `{{parentComment}}` | 原评论**纯文本** | **HTML 转义** |
| `{{replyContent}}` | 回复**纯文本** | **HTML 转义** |
| `{{parentCommentHtml}}` | 原评论渲染后的 **HTML** | **不转义**（原样插入） |
| `{{replyContentHtml}}` | 回复渲染后的 **HTML** | **不转义**（原样插入） |

**通知模板**（`notification_template`）：

| 占位符 | 值 | 转义 |
|---|---|---|
| `{{postTitle}}` `{{postUrl}}` `{{commentAuthor}}` | 纯文本 | **HTML 转义** |
| `{{commentContent}}` | 评论**纯文本** | **HTML 转义** |
| `{{commentContentHtml}}` | 评论渲染后的 **HTML** | **不转义**（原样插入） |

- 旧的纯文本占位符**保留且语义不变**，只为兼容既有自定义模板；默认模板已改用 `*Html` 占位符。
- 未匹配的 `{{...}}` 保持原样（与既有 `applyTemplate` 语义一致）。

## 3. 「渲染后的 HTML」怎么来

1. 取库里 S**已经净化过**的 `content_html`（写入时由各端 Markdown + 净化管线产出）；
2. 做一次**短代码水合**（见第 4 节），把 `:name:` 替换成 `<img>`；
3. 插入模板（`*Html` 占位符原样插入，不做二次转义）。

> 不二次转义的理由：`content_html` 是**本站自己生成的净化产物**（不是访客原文），
> 三端写入路径都已过滤脚本/事件属性/危险协议；水合注入的 `<img src>` 又只接受
> `https://` 与 `data:image/{png,jpeg,gif,webp};base64,…` 白名单（与前端 `safeImageUrl` 同一口径）。
> 因此邮件 HTML 的攻击面与评论区完全一致。

## 4. 服务端短代码水合（邮件专用）

评论区的表情由**访客浏览器**拉取 owo.json 后水合；邮件没有浏览器，所以**发信路径**自己拉一次：

| 项 | 口径 |
|---|---|
| 数据源 | 解析后的 `emoji_cdn_urls`（见 `doc/emoji.md` 第 3.2/3.3 节），**按顺序**拉取并合并 |
| 超时 | 单次拉取 **3 秒** |
| 响应体上限 | **1 MiB**（超出即放弃该来源） |
| 缓存 | 进程/isolate 内存缓存，TTL **10 分钟**（按地址列表做键） |
| 失败 | 丢该来源（全部失败则整张映射为空），**短代码原样保留为文字**，邮件照常发出 |
| 短代码推导 | 与前端**完全一致**：`text` 归一化合法就用它，否则 `e-<FNV-1a 32 位 8 位十六进制>`；同标签重名、跨标签重名追加 `-2`/`-3`…… |
| 可水合的项 | 只有 `type` 为 `image`（或缺省/未知按 image）的项；`emoji`/`emoticon` 是文本，正文里本来就是文本 |
| 图片地址白名单 | `https://…` 或 `data:image/{png,jpeg,gif,webp};base64,…`，其余丢弃 |
| 替换范围 | 只在**文本节点**上替换；`<code>` / `<pre>` / `<script>` / `<style>` / `<textarea>` 内部不替换 |
| 边界规则 | 与前端一致：名称前一个字符不能是字母/数字、后一个字符不能是数字（`12:30:45` 不受影响） |
| 注入的标签 | `<img src="…" alt=":name:" title=":name:" style="max-width:1.5em;max-height:1.5em;vertical-align:-0.25em;margin:0 1px;">` |

> `emoji_enabled = "false"` 时**不水合**（与评论区一致：关掉表情就看不到表情图）。

## 5. 发信前必须已经在跑的闸门

渲染只发生在**已经决定要发信**之后，不改变既有闸门顺序（来源校验 / 限流 / 黑名单 /
无感验证 / 邮箱验证都在发信之前，见 `doc/api.md`）。`email_enabled = "false"` 时一封都不发。

## 6. 外发邮件日志（管理面板「邮件管理」）

所有邮件都从**同一个底层发送函数**发出，日志也统一记在那里（`MailLog` 表，见
[`data_table.md`](./data_table.md)）：

- 只记**真正尝试发送**的邮件：SMTP 未配置、`email_enabled = "false"` 导致的「跳过」不记；
- 成功记 `sent`、失败记 `failed` 并带上错误信息（截断到 500 字符），**错误照旧抛给调用方**；
- 一次实际发送 = 一行；多个收件人写在同一行的 `recipient` 里（`", "` 连接）；
- 类型枚举（三端逐字一致）：`verify` / `link_sync` / `dormant_notice` / `comment_notify` / `reply_notify` / `test`；
- **保留天数可配置**：设置项 `mail_log_retention_days`（面板「邮件通知设置 → 邮件记录」），默认 **30 天**，
  `0` = **永久保留**，只能是 0–3650 的整数（写入时存规范化后的十进制，`" 045 "` → `"45"`；
  非法值写入返回 `400`，读取时按默认 30 天处理）；
- 清理是**惰性**的：写下一封邮件日志时顺手删掉窗口外的行（走 `idx_ml_created`），
  `GET /admin/mails` 也只返回窗口内的行并下发 `retentionDays`（`0` 时不设时间下限）；
- 面板按状态/类型筛选、按收件人或主题搜索。

## 7. 实现位置

| 端 | 文件 |
|---|---|
| Node | `nodejs/src/utils/emailEmoji.ts`（拉取/缓存/水合）、`utils/email.ts`（模板与占位符）、`utils/mailLog.ts`（外发邮件日志） |
| Go | `go/internal/pkg/utils/email_emoji.go`、`utils/email.go`、`utils/mail_log.go` |
| Worker | `worker/src/utils/emailEmoji.ts`、`utils/email.ts`、`utils/mailLog.ts` |
