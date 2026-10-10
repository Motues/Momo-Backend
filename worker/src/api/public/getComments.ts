import { Context } from 'hono'
import { Bindings } from '../../bindings'
import { getCravatar } from '../../utils/getAvatar'
import { getSetting } from '../../utils/settings'
import { getPublicVerifyConfig } from '../../utils/verify'
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

  // 读取博主标识设置
  const adminEmail = await getSetting(c.env, "admin_email") || "";
  const badgeEnabled = await getSetting(c.env, "blogger_badge_enabled") || "false";
  const badgeText = await getSetting(c.env, "blogger_badge_text") || "";
  const placeholderName = await getSetting(c.env, "placeholder_name") || "";
  const placeholderEmail = await getSetting(c.env, "placeholder_email") || "";
  const placeholderContent = await getSetting(c.env, "placeholder_content") || "";
  const placeholderUrl = await getSetting(c.env, "placeholder_url") || "";
  const adminCommentKey = await getSetting(c.env, "admin_comment_key") || "";
  const adminCommentKeyEnabled = await getSetting(c.env, "admin_comment_key_enabled") || "false";
  // 邮箱哈希仅供前端判断「是否需要显示管理员密钥输入框」。
  // 只有在博主密钥功能开启时才下发，避免被用于离线枚举管理员邮箱。
  const adminEmailHash = (adminEmail && adminCommentKeyEnabled === "true")
    ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adminEmail.toLowerCase().trim())))).map(b => b.toString(16).padStart(2, "0")).join("")
    : "";
  // 无感验证公开配置（开关 + 按文章派生的蜜罐字段名）
  const verifyConfig = await getPublicVerifyConfig(c.env, post_slug);

  try {
    // 1. 查询审核通过的评论
    // 注意：email 仅用于在服务端计算头像与博主标识，绝不进入响应体
    const query = `
      SELECT id, author, email, url, content_text as contentText,
             content_html as contentHtml, pub_date as pubDate, parent_id as parentId
      FROM Comment
      WHERE post_slug = ? AND status = 'approved'
      ORDER BY pub_date DESC
    `
    const { results } = await c.env.MOMO_DB.prepare(query).bind(post_slug).all()

    // 2. 批量处理头像并格式化，同时标记博主（显式挑字段，防止 email 等隐私字段回归）
    const allComments = await Promise.all((results || []).map(async (row: any) => {
      const isBlogger = row.email === adminEmail;
      let avatar = '';
      try {
        avatar = await getCravatar(row.email);
      } catch {
        avatar = '';
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
        isBlogger
      };
    }))

    // 3. 处理嵌套逻辑
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
          verify_enabled: verifyConfig.verify_enabled,
          verify_honeypot: verifyConfig.verify_honeypot,
          verify_version: verifyConfig.verify_version,
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
          verify_enabled: verifyConfig.verify_enabled,
          verify_honeypot: verifyConfig.verify_honeypot,
          verify_version: verifyConfig.verify_version,
        }
      })
    }
  } catch (e: any) {
    console.error('getComments error:', e)
    return c.json({ code: 500, message: 'Internal server error' }, 500)
  }
}
