import { Context } from 'hono'
import { Bindings } from '../../bindings'
import { getCravatar } from '../../utils/getAvatar'

export const getComments = async (c: Context<{ Bindings: Bindings }>) => {
    const post_slug = c.req.query('post_slug')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const nested = c.req.query('nested') !== 'false'
  const offset = (page - 1) * limit

  if (!post_slug) return c.json({ message: "post_slug is required" }, 400)

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

    // 2. 批量处理头像并格式化
    const allComments = await Promise.all(results.map(async (row: any) => ({
      ...row,
      avatar: await getCravatar(row.email),
      replies: []
    })))

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
      const paginatedData = rootComments.slice(offset, offset + limit)
      return c.json({ 
        data: paginatedData,
        pagination: {
          page,
          limit,
          total: Math.ceil(allComments.length / limit),
        } 
      })
    } else {
      // 非嵌套逻辑直接分页
      const paginatedData = allComments.slice(offset, offset + limit)
      return c.json({
        data: paginatedData,
        pagination: {
          page,
          limit,
          total: Math.ceil(allComments.length / limit)
        }
      })
    }
  } catch (e: any) {
    return c.json({ message: e.message }, 500)
  }
}