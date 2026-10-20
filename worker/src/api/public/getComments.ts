import { Context } from 'hono'
import { Bindings } from '../../bindings'
import { getCravatar } from '../../utils/getAvatar'
import { getSetting } from '../../utils/settings'
import { getPublicVerifyConfig } from '../../utils/verify'
import {
  resolveEmojiSettings,
  EMOJI_CDN_URLS_KEY,
  EMOJI_CDN_URL_KEY,
  EMOJI_ENABLED_KEY,
} from '../../utils/emoji'
import { getAdminConfig, adminEmailHashes, isAdminMember, sha256Hex } from '../../utils/adminEmails'
import { resolveLinkSecurityConfig, getLastCommentTimes, getActiveTrustsByEmail, isUrlDormant } from '../../utils/linkSecurity'
import { DormantNoticeCandidate, sweepDormantNotices } from '../../utils/dormantNotice'
import { resolveWaitUntil } from '../../utils/verifyRecord'
import { resolveBaseUrl } from './postComment'
import { toIsoString } from '../../utils/time'
import { allowRequest } from '../../utils/rateLimit'

// 公开评论列表限流（单 isolate 尽力而为）：缓解批量遍历 post_slug 采集博主邮箱哈希
const RATE_LIMIT = 120
const RATE_WINDOW_MS = 60 * 1000

export const getComments = async (c: Context<{ Bindings: Bindings }>) => {
    const post_slug = c.req.query('post_slug')
  // 分页参数 clamp：page >= 1，1 <= limit <= 50（与 Node/Go 一致，C14）
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1)
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '20', 10) || 20), 50)
  const nested = c.req.query('nested') !== 'false'
  const offset = (page - 1) * limit

  if (!post_slug) return c.json({ code: 400, message: "post_slug is required" }, 400)

  const ip = c.req.header('cf-connecting-ip') || '127.0.0.1'
  if (!allowRequest(`comments:get:${ip}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return c.json({ code: 429, message: "Too many requests. Please slow down." }, 429)
  }

  // 管理员列表（宽容解析：admin_emails 为空时回落旧键 admin_email；notify_email 命中不了则回落第一个）
  const adminConfig = await getAdminConfig(c.env)
  const badgeEnabled = await getSetting(c.env, "blogger_badge_enabled") || "false"
  const badgeText = await getSetting(c.env, "blogger_badge_text") || ""
  const placeholderName = await getSetting(c.env, "placeholder_name") || ""
  const placeholderEmail = await getSetting(c.env, "placeholder_email") || ""
  const placeholderContent = await getSetting(c.env, "placeholder_content") || ""
  const placeholderUrl = await getSetting(c.env, "placeholder_url") || ""
  const adminCommentKey = await getSetting(c.env, "admin_comment_key") || ""
  const adminCommentKeyEnabled = await getSetting(c.env, "admin_comment_key_enabled") || "false"
  // 邮箱哈希仅供前端判断「是否需要显示管理员密钥输入框」。
  // 只有在博主密钥功能开启时才下发，避免被用于离线枚举管理员邮箱（口径见 doc/admin_emails.md 第 5 节）。
  const keyEnabled = adminCommentKeyEnabled === "true"
  // 旧字段：通知邮箱（notify_email）的哈希，兼容只认单个哈希的旧前端
  const adminEmailHash = keyEnabled && adminConfig.notify
    ? await sha256Hex(adminConfig.notify)
    : ""
  // 新字段：每个归一化管理员邮箱的哈希数组（同样只在密钥功能开启时下发）
  const adminEmailHashList = keyEnabled ? await adminEmailHashes(adminConfig.admins) : []
  // 无感验证公开配置（开关 + 按文章派生的蜜罐字段名）
  const verifyConfig = await getPublicVerifyConfig(c.env, post_slug)
  // 表情设置（契约 v3）：开关 + OwO 格式的来源地址**数组**，前端据此显示按钮并直接拉取 owo.json。
  // 数组为空回落旧键、旧键也为空回落默认源；开关只有显式 "false" 才关闭，关闭时地址照常下发。
  const emoji = resolveEmojiSettings(
    await getSetting(c.env, EMOJI_CDN_URLS_KEY),
    await getSetting(c.env, EMOJI_CDN_URL_KEY),
    await getSetting(c.env, EMOJI_ENABLED_KEY)
  )
  // 链接安全（休眠链接）：fail-closed；功能关闭时一律 urlDormant = false 且不做任何查询
  const linkSecurity = await resolveLinkSecurityConfig(c.env)

  try {
    // 1. 查询审核通过的评论
    // 注意：email 仅用于在服务端计算头像、博主标识与休眠判定，绝不进入响应体
    const query = `
      SELECT id, author, email, url, content_text as contentText,
             content_html as contentHtml, pub_date as pubDate, parent_id as parentId
      FROM Comment
      WHERE post_slug = ? AND status = 'approved'
      ORDER BY pub_date DESC
    `
    const { results } = await c.env.MOMO_DB.prepare(query).bind(post_slug).all()

    // 2. 休眠链接：对本页涉及「有个人网址」的邮箱集合做**一次**分组查询拿最后评论时间
    //    （跨文章统计，status NOT IN ('rejected','deleted')；功能关闭时完全跳过），
    //    同时一次取回这些邮箱名下未过期的人工确认（TrustedLink，避免 N+1）
    const lastCommentTimes = new Map<string, number>()
    const activeTrusts = new Map<string, Map<string, { expiresAt: string; source: string }>>()
    const now = Date.now()
    if (linkSecurity.securityEnabled) {
      const emailsWithUrl = (results || [])
        .filter((row: any) => typeof row.url === 'string' && row.url.trim() !== '')
        .map((row: any) => String(row.email ?? ''))
        .filter((email: string) => email.trim() !== '')
      if (emailsWithUrl.length > 0) {
        const [grouped, trusts] = await Promise.all([
          getLastCommentTimes(c.env, emailsWithUrl),
          getActiveTrustsByEmail(c.env, emailsWithUrl, now),
        ])
        for (const [email, last] of grouped) lastCommentTimes.set(email, last)
        for (const [email, byUrl] of trusts) activeTrusts.set(email, byUrl)
      }
    }

    // 3. 批量处理头像并格式化，同时标记博主（显式挑字段，防止 email 等隐私字段回归）
    //    顺带收集本页被判为休眠的评论，供第 4 步的惰性提醒检测使用（email 不进入响应体）
    const dormantCandidates: DormantNoticeCandidate[] = []
    const allComments = await Promise.all((results || []).map(async (row: any) => {
      const hasUrl = typeof row.url === 'string' && row.url.trim() !== ''
      const emailKey = String(row.email ?? '').trim().toLowerCase()
      // 人工确认按「归一化邮箱 + 逐字相等的 url」匹配（写入端已过 sanitizeUrl，这里是同一个值）
      const commentUrl = hasUrl ? String(row.url).trim() : ''
      const trusted = commentUrl !== '' && (activeTrusts.get(emailKey)?.get(commentUrl) ?? null) !== null
      const isBlogger = isAdminMember(adminConfig.admins, row.email)
      let avatar = ''
      try {
        avatar = await getCravatar(row.email)
      } catch {
        avatar = ''
      }
      // 休眠链接：功能关闭、无网址、最后评论时间未知（fail-open）时恒为 false；
      // 有效人工确认（TrustedLink）直接豁免休眠
      const lastCommentAt = hasUrl ? lastCommentTimes.get(emailKey) ?? null : null
      const urlDormant = isUrlDormant({
        enabled: linkSecurity.securityEnabled ? 'true' : 'false',
        hasUrl,
        dormantDays: linkSecurity.dormantDays,
        lastCommentAt,
        trusted,
        now,
      })
      if (urlDormant && commentUrl !== '' && lastCommentAt !== null) {
        dormantCandidates.push({
          email: emailKey,
          url: commentUrl,
          author: String(row.author ?? ''),
          lastCommentAt,
        })
      }
      return {
        id: row.id,
        author: row.author,
        url: row.url || undefined,
        contentText: row.contentText,
        contentHtml: row.contentHtml,
        // pub_date 在库里是毫秒整数，响应契约统一为 ISO 字符串（与 Node/Go 一致）
        pubDate: toIsoString(row.pubDate),
        parentId: row.parentId,
        avatar,
        replies: [] as any[],
        isBlogger,
        urlDormant
      }
    }))

    // 3.5 休眠提醒的惰性检测（任务规范 §8.1，本仓库三端都没有定时任务）：
    //     只在功能开启时执行；同一 (email, url) 只处理一次；「发提醒邮件 → 成功才落记录」
    //     全部异步（waitUntil），任何异常都不影响评论列表响应。
    if (linkSecurity.securityEnabled && dormantCandidates.length > 0) {
      try {
        await sweepDormantNotices(
          c.env,
          dormantCandidates,
          { baseUrl: await resolveBaseUrl(c), dormantDays: linkSecurity.dormantDays },
          resolveWaitUntil(c)
        )
      } catch (error) {
        console.error('[dormant] 惰性检测调用失败（已忽略）:', error)
      }
    }

    // 4. 处理嵌套逻辑
    if (nested) {
      const commentMap = new Map()
      const rootComments: any[] = []

      allComments.forEach(comment => commentMap.set(comment.id, comment))
      allComments.forEach(comment => {
        if (comment.parentId && commentMap.has(comment.parentId)) {
          commentMap.get(comment.parentId).replies.push(comment)
        } else if (!comment.parentId) {
          rootComments.push(comment)
        }
      })

      // 对根评论进行分页
      const rootTotal = rootComments.length
      const paginatedData = rootComments.slice(offset, offset + limit)
      return c.json({
        code: 200,
        message: 'Comments fetched successfully',
        data: {
          comments: paginatedData,
          pagination: {
            page,
            limit,
            totalPage: Math.ceil(rootTotal / limit) || 1,
          },
          blogger_badge_enabled: badgeEnabled,
          blogger_badge_text: badgeText,
          placeholder_name: placeholderName,
          placeholder_email: placeholderEmail,
          placeholder_content: placeholderContent,
          placeholder_url: placeholderUrl,
          admin_comment_key_configured: adminCommentKey && adminCommentKeyEnabled === "true" ? "true" : "false",
          admin_email_hash: adminEmailHash,
          admin_email_hashes: adminEmailHashList,
          verify_enabled: verifyConfig.verify_enabled,
          verify_honeypot: verifyConfig.verify_honeypot,
          verify_version: verifyConfig.verify_version,
          emoji_enabled: emoji.enabled,
          emoji_cdn_urls: emoji.urls,
          emoji_cdn_url: emoji.url,
        }
      })
    } else {
      // 非嵌套逻辑直接分页
      const paginatedData = allComments.slice(offset, offset + limit)
      return c.json({
        code: 200,
        message: 'Comments fetched successfully',
        data: {
          comments: paginatedData,
          pagination: {
            page,
            limit,
            totalPage: Math.ceil(allComments.length / limit)
          },
          blogger_badge_enabled: badgeEnabled,
          blogger_badge_text: badgeText,
          placeholder_name: placeholderName,
          placeholder_email: placeholderEmail,
          placeholder_content: placeholderContent,
          placeholder_url: placeholderUrl,
          admin_comment_key_configured: adminCommentKey && adminCommentKeyEnabled === "true" ? "true" : "false",
          admin_email_hash: adminEmailHash,
          admin_email_hashes: adminEmailHashList,
          verify_enabled: verifyConfig.verify_enabled,
          verify_honeypot: verifyConfig.verify_honeypot,
          verify_version: verifyConfig.verify_version,
          emoji_enabled: emoji.enabled,
          emoji_cdn_urls: emoji.urls,
          emoji_cdn_url: emoji.url,
        }
      })
    }
  } catch (e: any) {
    console.error('getComments error:', e)
    return c.json({ code: 500, message: 'Internal server error' }, 500)
  }
}
