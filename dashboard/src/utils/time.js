/**
 * 仪表盘的时间显示工具。
 *
 * 约定：后端（Node / Go / Worker）所有时间戳与统计**分桶键**都按 UTC 产生
 * （见 doc/data_table.md 的「统计口径」），接口不做任何时区换算。
 * 前端展示统一换算成**浏览器（管理员本机 OS）时区**，与「认证明细」里
 * 用 toLocaleString 渲染的时间列保持一致 —— 否则同一条记录在趋势图和明细里
 * 会落在不同的日期上。
 *
 * 注意：分桶键代表一个 UTC 区间的**起点**（如 `2024-05-06` = 该日 00:00Z 起 24 小时），
 * 换算后展示的就是这个起点的本地时间。跨时区时「一个 UTC 日」并不等于「一个本地日」，
 * 因此标签只表示该分桶起点在本地时区的位置。
 */

const pad = (value) => String(value).padStart(2, '0');

/** 分桶粒度：月 / 日 / 小时（与后端 range.bucket 一致） */
export function bucketGranularity(key) {
  const value = String(key ?? '');
  // 顺序敏感：先匹配最长的形式
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(value)) return 'hour';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'day';
  if (/^\d{4}-\d{2}$/.test(value)) return 'month';
  return null;
}

/** 把后端分桶键解析成对应的 UTC 时刻；形式无法识别时返回 null */
export function parseBucketKey(key) {
  const value = String(key ?? '');
  let match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(value);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4])));
  }
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  }
  return null;
}

/**
 * 任意时间输入（ISO 字符串 / 毫秒数 / Date / 分桶键）→ 本地时区的 `YYYY-MM-DD`。
 * 无法解析时返回空字符串，调用方据此决定是否降级显示。
 */
export function formatLocalDate(input) {
  if (input === null || input === undefined || input === '') return '';
  const date =
    input instanceof Date
      ? input
      : typeof input === 'number'
        ? new Date(input)
        : parseBucketKey(input) ?? new Date(input);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 趋势图 X 轴标签（本地时区）：
 * 小时粒度取 `HH:00`，日粒度取 `MM-DD`，月粒度取「M月 / YY年」（与改造前的形状一致）。
 * 无法识别的键原样返回，避免数据凭空消失。
 */
export function bucketAxisLabel(key) {
  const date = parseBucketKey(key);
  if (!date) return String(key ?? '');

  switch (bucketGranularity(key)) {
    case 'hour':
      return `${pad(date.getHours())}:00`;
    case 'month': {
      const month = date.getMonth() + 1;
      if (month === 1) return `${String(date.getFullYear()).slice(2)}年`;
      return `${month}月`;
    }
    default:
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
}

/**
 * 趋势图悬浮提示里的完整时间（本地时区）：
 * 小时粒度 `YYYY-MM-DD HH:00`、日粒度 `YYYY-MM-DD`、月粒度 `YYYY-MM`。
 */
export function bucketTooltipLabel(key) {
  const date = parseBucketKey(key);
  if (!date) return String(key ?? '');

  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  switch (bucketGranularity(key)) {
    case 'hour':
      return `${ymd} ${pad(date.getHours())}:00`;
    case 'month':
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
    default:
      return ymd;
  }
}
