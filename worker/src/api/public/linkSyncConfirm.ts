import { Context } from 'hono';
import { Bindings } from '../../bindings';
import {
	isEmailIdentityVerified,
	isEmailServiceAvailable,
	sendLinkSyncConfirmationEmail,
} from '../../utils/email';
import { getSetting } from '../../utils/settings';
import {
	applyLinkSync,
	createLinkSyncRequest,
	findHistoricalOtherUrl,
	hasPendingLinkSync,
	invalidatePendingLinkSync,
	markLinkSyncConfirmed,
	resolveLinkSecurityConfig,
} from '../../utils/linkSecurity';
import { normalizeEmail } from '../../utils/adminEmails';

interface LinkSyncRecord {
	id: number;
	email: string;
	new_url: string;
	token: string;
	expires_at: string;
	confirmed: number;
	created_at: string;
}

/**
 * 历史链接批量更新（`doc/link_security.md` 第 3 节）。
 *
 * 触发（评论提交后，全部条件满足才会发确认邮件）：
 *   1. `link_sync_enabled = "true"`（fail-closed）；
 *   2. `email_verify_enabled = "true"`（硬前提）；
 *   3. SMTP 可用；
 *   4. 提交评论的邮箱已经通过邮箱验证；
 *   5. 本次提交的 `url` 非空，且该邮箱存在 url 非空且与本次不同的历史评论。
 *
 * 任一不满足 → 什么都不做，评论照常落库。写入新记录前会作废该邮箱既有的
 * 「未确认且未过期」记录（保证邮件里的旧链接立刻失效）；同一邮箱 + 同一 newUrl
 * 已有未过期未确认记录时**不重复发信**。
 */
export async function requestLinkSyncIfNeeded(
	env: Bindings,
	params: {
		email: string;
		newUrl: string;
		author: string;
		postTitle: string;
		postUrl: string;
		baseUrl: string;
	},
	waitUntil: (promise: Promise<unknown>) => void
): Promise<void> {
	try {
		if (!params.newUrl) return;
		const config = await resolveLinkSecurityConfig(env);
		if (!config.syncEnabled) return;
		if ((await getSetting(env, 'email_verify_enabled')) !== 'true') return;
		if (!(await isEmailServiceAvailable(env))) return;
		if (!(await isEmailIdentityVerified(env, params.email))) return;

		const oldUrl = await findHistoricalOtherUrl(env, params.email, params.newUrl);
		if (!oldUrl) return;

		// 去重：同一邮箱 + 同一 newUrl 已有未过期未确认记录 → 不重复发信
		if (await hasPendingLinkSync(env, params.email, params.newUrl)) return;

		// 同一邮箱只保留一条有效待确认记录
		await invalidatePendingLinkSync(env, params.email);

		const token = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		await createLinkSyncRequest(env, {
			email: params.email,
			newUrl: params.newUrl,
			token,
			expiresAt,
		});

		const confirmUrl = `${params.baseUrl.replace(/\/+$/, '')}/api/link-sync/confirm?token=${encodeURIComponent(token)}&email=${encodeURIComponent(normalizeEmail(params.email))}`;

		waitUntil(
			(async () => {
				try {
					await sendLinkSyncConfirmationEmail(env, {
						toEmail: params.email,
						toName: params.author,
						oldUrl,
						newUrl: params.newUrl,
						confirmUrl,
						postTitle: params.postTitle,
						postUrl: params.postUrl,
					});
				} catch (error) {
					console.error('链接同步确认邮件发送失败:', error);
				}
			})()
		);
	} catch (error) {
		// 链接同步永远不能影响评论提交
		console.error('链接同步触发失败（已忽略）:', error);
	}
}

/**
 * `GET /api/link-sync/confirm?token=&email=` —— 确认并执行批量更新，返回 HTML 结果页。
 *
 * 结果页的四种情形（文案三端一致，见 `doc/link_security.md` 第 3.4 节）。
 * 端点不需要登录（与邮箱验证端点同一模型：邮件链接即凭据）。
 */
export const linkSyncConfirm = async (c: Context<{ Bindings: Bindings }>) => {
	const token = c.req.query('token');
	const email = c.req.query('email');

	if (!token || !email) {
		return c.html(linkSyncResultPage(false, '缺少确认参数'));
	}

	try {
		const record = await c.env.MOMO_DB.prepare(
			'SELECT * FROM LinkSyncRequest WHERE token = ? AND email = ?'
		)
			.bind(token, normalizeEmail(email))
			.first<LinkSyncRecord>();

		if (!record) {
			return c.html(linkSyncResultPage(false, '确认链接无效'));
		}

		if (record.confirmed === 1) {
			return c.html(linkSyncResultPage(true, '该链接同步已完成'));
		}

		const expiresAt = Date.parse(record.expires_at);
		if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
			return c.html(linkSyncResultPage(false, '确认链接已过期，请重新提交评论以获取新的确认邮件'));
		}

		// 批量更新 → 标记一次性令牌已使用（幂等：url != new_url 的老评论才会被写）
		const updated = await applyLinkSync(c.env, record.email, record.new_url);
		await markLinkSyncConfirmed(c.env, record.id);

		return c.html(linkSyncResultPage(true, `链接同步完成！共 ${updated} 条历史评论的网址已更新`));
	} catch (error) {
		console.error('链接同步确认失败:', error);
		return c.html(linkSyncResultPage(false, '链接同步处理失败，请稍后重试'));
	}
};

/** 与邮箱验证结果页同款样式的纯 HTML 结果页 */
function linkSyncResultPage(success: boolean, message: string): string {
	const icon = success ? '&#10003;' : '&#10007;';
	const color = success ? '#28a745' : '#dc3545';
	const title = success ? '链接同步成功' : '链接同步失败';

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - 链接同步</title>
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
    <p>${message}</p>
    <div class="footer">此页面由系统自动生成</div>
  </div>
</body>
</html>`;
}
