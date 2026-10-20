import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getSetting } from '../../utils/settings';
import { sanitizeUrl } from '../../utils/security';
import {
	applyLinkSync,
	DAY_MS,
	isTrustActive,
	LINK_DORMANT_DAYS_KEY,
	parseDormantDays,
	upsertTrustedLink,
} from '../../utils/linkSecurity';
import {
	deleteDormantNoticeById,
	DormantNoticeRow,
	getDormantNoticeByToken,
} from '../../utils/dormantNotice';

/**
 * 休眠提醒的三个公共端点（任务规范 §8.3，不需要登录：邮件令牌即凭据）。
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET  | `/api/link-dormant/notice?token=` | 中文 HTML 页面（不跳转前端） |
 * | POST | `/api/link-dormant/confirm?token=` | 「我仍在使用」→ 恢复正常 |
 * | POST | `/api/link-dormant/update?token=`  | 表单字段 `url`：提交新链接（批量更新该邮箱历史评论） |
 *
 * 两个 POST 动作都是**一次性**的：动作完成后删除 `DormantNotice` 记录，
 * 同一个 token 再访问就落到「该提醒已失效或已处理」。
 */

/** 固定文案（三端逐字一致） */
const MSG_MISSING_TOKEN = '缺少提醒参数。';
const MSG_NOT_FOUND = '该提醒已失效或已处理。';
const MSG_EXPIRED = '该提醒已过期，请在评论区留言或等待新的提醒邮件。';
const MSG_BAD_URL = '新链接格式不正确，请填写以 http:// 或 https:// 开头的网址。';
const MSG_ERROR = '处理失败，请稍后重试。';

/** 读取并归一化 `link_dormant_days`（脏值回退 30、上限 3650） */
async function resolveDormantDays(env: Bindings): Promise<number> {
	return parseDormantDays(await getSetting(env, LINK_DORMANT_DAYS_KEY));
}

/** HTML 转义（本模块自用，避免把用户可控的 url 直接插进页面） */
function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** 提醒记录是否已过期（与人工确认同一口径：`expires_at` 严格大于 now 才算有效） */
function isExpired(record: DormantNoticeRow, now: number): boolean {
	return !isTrustActive(record.expires_at, now);
}

/**
 * `GET /api/link-dormant/notice?token=` —— 中文 HTML 提醒页。
 *
 * 令牌有效时给出当前链接、两个表单（`confirm` / `update`）与有效期页脚；
 * 缺 token / 查不到记录 / 已过期一律返回失败结果页。
 */
export const dormantNoticePage = async (c: Context<{ Bindings: Bindings }>) => {
	const token = c.req.query('token');
	if (!token) return c.html(dormantResultPage(false, MSG_MISSING_TOKEN));

	try {
		const record = await getDormantNoticeByToken(c.env, token);
		if (!record) return c.html(dormantResultPage(false, MSG_NOT_FOUND));
		if (isExpired(record, Date.now())) return c.html(dormantResultPage(false, MSG_EXPIRED));

		const days = await resolveDormantDays(c.env);
		return c.html(dormantNoticeHtml(record, days));
	} catch (error) {
		console.error('[dormant] 渲染提醒页失败:', error);
		return c.html(dormantResultPage(false, MSG_ERROR));
	}
};

/**
 * `POST /api/link-dormant/confirm?token=` —— 「我仍在使用」。
 *
 * 写入一条 `TrustedLink`（`source = 'self'`、有效期 = 现在 + N 天）并删除提醒记录
 * （删记录是为了：确认到期后若仍没评论，会再次休眠并再发一封提醒）。
 */
export const dormantLinkConfirm = async (c: Context<{ Bindings: Bindings }>) => {
	const token = c.req.query('token');
	if (!token) return c.html(dormantResultPage(false, MSG_MISSING_TOKEN));

	try {
		const record = await getDormantNoticeByToken(c.env, token);
		if (!record) return c.html(dormantResultPage(false, MSG_NOT_FOUND));

		const now = Date.now();
		if (isExpired(record, now)) return c.html(dormantResultPage(false, MSG_EXPIRED));

		const days = await resolveDormantDays(c.env);
		await upsertTrustedLink(c.env, {
			email: record.email,
			url: record.url,
			expiresAt: new Date(now + days * DAY_MS).toISOString(),
			createdAt: new Date(now).toISOString(),
			source: 'self',
		});
		await deleteDormantNoticeById(c.env, record.id);

		return c.html(dormantResultPage(true, `确认成功！该链接已恢复正常，${days} 天内不会再标记为休眠。`));
	} catch (error) {
		console.error('[dormant] 确认失败:', error);
		return c.html(dormantResultPage(false, MSG_ERROR));
	}
};

/**
 * `POST /api/link-dormant/update?token=` —— 提交新链接（浏览器原生表单，`url` 字段）。
 *
 * 1. `url = sanitizeUrl(表单 url)`，为空 → 非法文案；
 * 2. 批量把该邮箱**所有历史评论**（`status NOT IN ('rejected','deleted')`）里
 *    `url != 新链接` 的行的 `url` 改成新链接（幂等），返回改动条数 `count`；
 * 3. 同样写入 `TrustedLink`（**新链接** + N 天 + `source='self'`），并删除旧提醒记录
 *    （否则新链接会因为「最后评论时间没变」立刻又被判休眠）。
 */
export const dormantLinkUpdate = async (c: Context<{ Bindings: Bindings }>) => {
	const token = c.req.query('token');
	if (!token) return c.html(dormantResultPage(false, MSG_MISSING_TOKEN));

	try {
		const record = await getDormantNoticeByToken(c.env, token);
		if (!record) return c.html(dormantResultPage(false, MSG_NOT_FOUND));

		const now = Date.now();
		if (isExpired(record, now)) return c.html(dormantResultPage(false, MSG_EXPIRED));

		// 浏览器原生表单 application/x-www-form-urlencoded（解析失败按空表单处理）
		const body = await c.req.parseBody().catch(() => ({}) as Record<string, string>);
		// 合法口径（与 Node 端逐字一致）：非空 + sanitizeUrl 通过 + 必须是 http:// 或 https:// 开头。
		// `mailto:` 与协议相对地址（//host）在本流程里也算非法 —— 这封提醒针对的是「个人网站」。
		const newUrl = sanitizeUrl((body as Record<string, unknown>)?.url);
		if (!newUrl || !/^https?:\/\//i.test(newUrl)) {
			return c.html(dormantResultPage(false, MSG_BAD_URL));
		}

		const days = await resolveDormantDays(c.env);
		const count = await applyLinkSync(c.env, record.email, newUrl);
		await upsertTrustedLink(c.env, {
			email: record.email,
			url: newUrl,
			expiresAt: new Date(now + days * DAY_MS).toISOString(),
			createdAt: new Date(now).toISOString(),
			source: 'self',
		});
		await deleteDormantNoticeById(c.env, record.id);

		return c.html(
			dormantResultPage(
				true,
				count > 0
					? `链接更新成功！共 ${count} 条历史评论的网址已更新。`
					: '新链接与现有链接相同，未做修改。'
			)
		);
	} catch (error) {
		console.error('[dormant] 更新失败:', error);
		return c.html(dormantResultPage(false, MSG_ERROR));
	}
};

/** 令牌有效时的提醒页（标题「链接已休眠」+ 当前链接 + 两个表单 + 有效期页脚） */
function dormantNoticeHtml(record: DormantNoticeRow, days: number): string {
	const token = encodeURIComponent(record.token);
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>链接已休眠 - 链接安全提醒</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      padding: 40px 36px;
      max-width: 480px;
      width: 90%;
    }
    .icon {
      font-size: 56px;
      color: #f0ad4e;
      text-align: center;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 24px;
      color: #1a1a1a;
      margin: 0 0 12px 0;
      text-align: center;
    }
    p {
      font-size: 15px;
      color: #555;
      line-height: 1.6;
      margin: 0 0 16px 0;
    }
    .url {
      padding: 12px;
      background: #f5f5f5;
      border-radius: 6px;
      color: #0066cc;
      word-break: break-all;
      font-size: 14px;
    }
    form {
      margin: 0 0 16px 0;
    }
    input[type="text"] {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid #d9d9d9;
      border-radius: 6px;
      font-size: 14px;
      margin-bottom: 10px;
    }
    button {
      width: 100%;
      padding: 12px 20px;
      border: none;
      border-radius: 6px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      background: #0066cc;
      color: #fff;
    }
    button.secondary {
      background: #fff;
      color: #0066cc;
      border: 1px solid #0066cc;
    }
    .footer {
      font-size: 12px;
      color: #999;
      text-align: center;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#9888;</div>
    <h1>链接已休眠</h1>
    <p>这个个人网站链接很久没有新的评论活动了。为防止域名被抢注后指向钓鱼站点，本站已不再从评论区直接跳转它。</p>
    <p class="url">${escapeHtml(record.url)}</p>
    <form method="POST" action="/api/link-dormant/confirm?token=${token}">
      <button type="submit">我仍在使用</button>
    </form>
    <form method="POST" action="/api/link-dormant/update?token=${token}">
      <input type="text" name="url" placeholder="https://example.com" autocomplete="off">
      <button type="submit" class="secondary">提交新链接</button>
    </form>
    <div class="footer">确认后 ${days} 天内不会再标记为休眠</div>
  </div>
</body>
</html>`;
}

/** 成功 / 失败两种视觉的结果页（与既有 `linkSyncResultPage` 同款 CSS 与图标） */
function dormantResultPage(success: boolean, message: string): string {
	const icon = success ? '&#10003;' : '&#10007;';
	const color = success ? '#28a745' : '#dc3545';
	const title = success ? '操作成功' : '操作失败';

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - 链接安全提醒</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      padding: 48px 40px;
      max-width: 420px;
      width: 90%;
      text-align: center;
    }
    .icon {
      font-size: 64px;
      color: ${color};
      margin-bottom: 16px;
    }
    h1 {
      font-size: 24px;
      color: #1a1a1a;
      margin: 0 0 12px 0;
    }
    p {
      font-size: 15px;
      color: #555;
      line-height: 1.6;
      margin: 0 0 24px 0;
    }
    .footer {
      font-size: 12px;
      color: #999;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${escapeHtml(message)}</p>
    <div class="footer">此页面由系统自动生成</div>
  </div>
</body>
</html>`;
}
