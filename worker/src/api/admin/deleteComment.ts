import { Context } from 'hono';
import { Bindings } from '../../bindings';

export const deleteComment = async (c: Context<{ Bindings: Bindings }>) => {
  const id = c.req.query('id');

  if (!id) {
    return c.json({ message: "Missing id" }, 400);
  }

  // 使用 UPDATE 代替 DELETE，将状态改为 'deleted'
  const { success } = await c.env.MOMO_DB.prepare(
    "UPDATE Comment SET status = 'deleted' WHERE id = ?"
  ).bind(id).run();

  if (!success) {
    return c.json({ message: "Delete operation failed" }, 500);
  }

  return c.json({
    message: `Comment marked as deleted, id: ${id}.`
  });
};