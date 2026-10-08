import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { isValidCommentStatus } from '../../utils/security';

export const updateStatus = async (c: Context<{ Bindings: Bindings }>) => {
  const id = c.req.query('id');
  const status = c.req.query('status'); // 按照你规范中 URL 参数的形式

  if (!id || !status) {
    return c.json({ 
      code: 400,
      message: "Invalid request parameters" 
    }, 400);
  }

  // 状态枚举白名单：拒绝任意字符串写入状态机
  if (!isValidCommentStatus(status)) {
    return c.json({
      code: 400,
      message: "Invalid status. Allowed: pending, approved, rejected, deleted"
    }, 400);
  }

  // 级联语义（与 Node/Go 一致）：
  //  - deleted / pending：连同全部子孙评论一起改（管理员删除或打回一条评论时，
  //    其下回复不应继续可见/保留旧状态）
  //  - approved / rejected：只改本条
  const shouldCascade = status === 'deleted' || status === 'pending';

  const { success, meta } = shouldCascade
    ? await c.env.MOMO_DB.prepare(`
        WITH RECURSIVE comment_tree AS (
          SELECT id FROM Comment WHERE id = ?
          UNION ALL
          SELECT c.id FROM Comment c
          INNER JOIN comment_tree ct ON c.parent_id = ct.id
        )
        UPDATE Comment SET status = ? WHERE id IN (SELECT id FROM comment_tree)
      `).bind(id, status).run()
    : await c.env.MOMO_DB.prepare(
        "UPDATE Comment SET status = ? WHERE id = ?"
      ).bind(status, id).run();

  if (!success) {
    return c.json({ 
      code: 500,
      message: "Update failed" 
    }, 500);
  }

  // 影响 0 行说明评论不存在：与 Node/Go 统一返回 404，
  // 否则前端会把「记录已被删除」当成更新成功
  if (!meta || !meta.changes) {
    return c.json({
      code: 404,
      message: "Comment not found"
    }, 404);
  }

  return c.json({
    code: 200,
    message: `Comment status updated`
  });
};
