import request from './request';

/**
 * 批量审核评论（前端复用单条状态接口）。
 *
 * 为什么不做批量后端接口：单条接口已经定义了 `deleted` / `pending` 的**级联语义**
 * （连同全部子孙回复一起改，见 doc/api.md），批量接口要三端同步且必须复刻同样的递归语义；
 * 管理面板每页最多几十条，用有限并发逐条调用更稳、也天然兼容旧后端。
 *
 * 失败不抛出：返回汇总结果，由调用方决定提示文案与是否保留失败项的勾选。
 */

export const BATCH_STATUS_LABELS = {
  approved: '通过',
  pending: '打回待审',
  deleted: '删除',
};

/** `deleted` / `pending` 会级联到子孙回复，确认框需要额外提示 */
export const BATCH_CASCADE_STATUSES = ['pending', 'deleted'];

export async function updateCommentsStatus(ids, status, options = {}) {
  const unique = [...new Set((ids ?? []).filter((id) => id !== null && id !== undefined))];
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 4, 10));
  const failed = [];
  let succeeded = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < unique.length) {
      const id = unique[cursor];
      cursor += 1;
      try {
        // 与单条审核保持同一个地址与参数形式（query 传参），便于复用既有的三端语义
        await request.put(
          `/admin/comments/status?id=${encodeURIComponent(id)}&status=${encodeURIComponent(status)}`
        );
        succeeded += 1;
      } catch (error) {
        failed.push({ id, error });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, () => worker())
  );

  return {
    total: unique.length,
    succeeded,
    failed,
    failedIds: failed.map((item) => item.id),
  };
}
