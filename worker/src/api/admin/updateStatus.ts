import { Context } from 'hono';
import { Bindings } from '../../bindings';

export const updateStatus = async (c: Context<{ Bindings: Bindings }>) => {
  const id = c.req.query('id');
  const status = c.req.query('status'); // 按照你规范中 URL 参数的形式

  if (!id || !status) {
    return c.json({ message: "Missing id or status" }, 400);
  }

  const { success } = await c.env.MOMO_DB.prepare(
    "UPDATE Comment SET status = ? WHERE id = ?"
  ).bind(status, id).run();

  if (!success) {
    return c.json({ message: "Update failed" }, 500);
  }

  return c.json({
    message: `Comment status updated, id: ${id}, status: ${status}.`
  });
};