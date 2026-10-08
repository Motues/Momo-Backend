import { Context } from 'hono'
import { Bindings } from '../../bindings'
import { getCravatar } from '../../utils/getAvatar'
import { getSetting } from '../../utils/settings'
import { getPublicVerifyConfig } from '../../utils/verify'

export const getComments = async (c: Context<{ Bindings: Bindings }>) => {
    const post_slug = c.req.query('post_slug')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const nested = c.req.query('nested') !== 'false'
  const offset = (page - 1) * limit

  if (!post_slug) return c.json({ message: "post_slug is required" }, 400)

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
  const adminEmailHash = adminEmail ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adminEmail.toLowerCase().trim())))).map(b => b.toString(16).padStart(2, "0")).join("") : "";
  // 无感验证公开配置（开关 + 按文章派生的蜜罐字段名）
  const verifyConfig = await getPublicVerifyConfig(c.env, post_slug);

  try {
    // 1. 查询审核通过的评论
    const query = `
      SELECT id, author, email, url, content_text as contentText,
             content_html as contentHtml, pub_date as pubDate, parent_id as parentId
      FROM Comment
      WHERE post_slug = ? AND status = "approved"
      ORDER BY pub_date DESC
    `
    const { results } = await c.env.MOMO_DB.prepare(query).bind(post_slug).all()

    // 2. 批量处理头像并格式化，同时标记博主
    const allComments = await Promise.all((results || []).map(async (row: any) => {
      try {
        return {
          ...row,
          avatar: await getCravatar(row.email),
          replies: [],
          isBlogger: row.email === adminEmail
        };
      } catch {
        return {
          ...row,
          avatar: '',
          replies: [],
          isBlogger: false
        };
      }
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
        }
      })
    }
  } catch (e: any) {
    console.error('getComments error:', e)
    return c.json({ message: 'Internal server error' }, 500)
  }
}