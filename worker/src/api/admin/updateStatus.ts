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

  const { success } = await c.env.MOMO_DB.prepare(
    "UPDATE Comment SET status = ? WHERE id = ?"
  ).bind(status, id).run();

  if (!success) {
    return c.json({ 
      code: 500,
      message: "Update failed" 
    }, 500);
  }

  return c.json({
    code: 200,
    message: `Comment status updated`
  });
};
