/**
 * 休眠提醒链路（任务规范 §8 / §10.6 / §10.7）：
 *  - 公开评论列表的惰性检测（发提醒邮件 → 成功才落 DormantNotice）；
 *  - 同一休眠周期不重复提醒、新的休眠周期 / 记录过期后再提醒；
 *  - 功能关闭 / SMTP 未配置时不发信也不落记录；
 *  - 提醒页三个公共端点（notice / confirm / update）的页面与结果文案。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { api } from '../helpers/http';
import {
	allDormantNotices,
	allMailLogs,
	allTrustedLinks,
	createSchema,
	countMailLogs,
	getComment,
	getDormantNoticeByToken,
	seedComment,
	seedDormantNotice,
	seedSettings,
	testEnv,
} from '../helpers/db';
import { resetSentMails, sentMails } from '../stubs/nodemailer';

const DAY = 24 * 3600 * 1000;
const POST = '/p';
const LINK = 'https://a.example.com';
/** 触发休眠的那条评论的时间（90 天前） */
const PUB = Date.now() - 90 * DAY;

const SMTP = {
	smtp_host: 'smtp.example.com',
	smtp_port: '465',
	email_user: 'noreply@example.com',
	email_password: 'secret',
};

/** 一份「链接安全开启 + 提醒开关开启 + 邮箱验证开启 + SMTP 可用 + 基地址固定」的配置 */
const BASE_SETTINGS: Record<string, string> = {
	...SMTP,
	site_name: 'Momo Blog',
	verify_base_url: 'https://blog.example.com',
	link_security_enabled: 'true',
	link_dormant_days: '30',
	// 休眠提醒邮件的两个前提（doc/link_security.md 第 2.7 节）：提醒开关 + 邮箱验证
	link_dormant_notice_enabled: 'true',
	email_verify_enabled: 'true',
};

beforeEach(async () => {
	await createSchema();
	resetSentMails();
});

/** 一条 90 天前、带网址的已通过评论（Alice / a@x.com） */
async function seedDormantComment(overrides: Record<string, unknown> = {}): Promise<number> {
	return await seedComment({
		author: 'Alice',
		email: 'a@x.com',
		url: LINK,
		pub_date: PUB,
		post_slug: POST,
		status: 'approved',
		...overrides,
	});
}

async function readComments(query = '') {
	return await api(`/api/comments?post_slug=${encodeURIComponent(POST)}${query}`);
}

/** 读取刚发出去的休眠提醒邮件里的提醒页地址 */
function noticeUrlOf(index = 0): string {
	const html = String(sentMails[index]?.html ?? '');
	const match = /https:\/\/blog\.example\.com\/api\/link-dormant\/notice\?token=[^"<\s]+/.exec(html);
	if (!match) throw new Error('提醒邮件里没有提醒页地址');
	return match[0].replace(/&amp;/g, '&');
}

function tokenOf(noticeUrl: string): string {
	const token = /token=([^&\s]+)/.exec(noticeUrl)?.[1];
	if (!token) throw new Error('提醒页地址里没有 token');
	return decodeURIComponent(token);
}

describe('惰性检测 —— 公开评论列表触发休眠提醒', () => {
	it('90 天前带网址的评论 + 开启链接安全：读一次列表 → 发一封提醒 + 一行 DormantNotice + 一行 MailLog', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedDormantComment();

		const res = await readComments();
		expect(res.status).toBe(200);
		expect(res.body.data.comments[0].urlDormant).toBe(true);

		// 邮件发出一次，主题与正文符合契约
		expect(sentMails).toHaveLength(1);
		expect(sentMails[0].to).toBe('a@x.com');
		expect(sentMails[0].subject).toBe('您在 Momo Blog 的个人网站链接已进入休眠');
		expect(sentMails[0].html).toContain(LINK);
		expect(sentMails[0].html).toContain('我仍在使用');
		expect(sentMails[0].html).toContain('此链接 30 天内有效');

		// 记录落库：last_comment_at 是「当前最后评论时间」，notify_count = 1
		const notices = await allDormantNotices();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			email: 'a@x.com',
			url: LINK,
			last_comment_at: PUB,
			notify_count: 1,
		});
		// expires_at = notified_at + 30 天（两次取 now 之间可能差 1 毫秒，放宽到秒级）
		expect(
			Math.abs(Date.parse(notices[0].expires_at) - (Date.parse(notices[0].notified_at) + 30 * DAY))
		).toBeLessThan(1000);

		// 邮件日志里有一行 dormant_notice / sent
		const logs = await allMailLogs();
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({ type: 'dormant_notice', recipient: 'a@x.com', status: 'sent' });

		// 提醒页地址里的 token 与记录里的 token 一致
		const noticeUrl = noticeUrlOf();
		expect(noticeUrl).toContain('https://blog.example.com/api/link-dormant/notice?token=');
		expect(notices[0].token).toBe(tokenOf(noticeUrl));
	});

	it('同一休眠周期只提醒一次（再读一次不发信、notify_count 不变）', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedDormantComment();

		await readComments();
		expect(sentMails).toHaveLength(1);

		await readComments();
		await readComments();

		expect(sentMails).toHaveLength(1);
		const notices = await allDormantNotices();
		expect(notices).toHaveLength(1);
		expect(notices[0].notify_count).toBe(1);
		expect(await countMailLogs()).toBe(1);
	});

	it('他后来又评论过（最后评论时间变了）= 新的休眠周期 → 再发一封，notify_count = 2', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedDormantComment();
		await readComments();
		expect(sentMails).toHaveLength(1);

		// 跨文章评论：60 天前（仍然超过 30 天 → 仍然休眠，但最后评论时间变了）
		const secondPub = Date.now() - 60 * DAY;
		await seedComment({
			author: 'Alice',
			email: 'a@x.com',
			url: null,
			pub_date: secondPub,
			post_slug: '/other',
			status: 'approved',
		});

		await readComments();

		expect(sentMails).toHaveLength(2);
		const notices = await allDormantNotices();
		expect(notices).toHaveLength(1);
		expect(notices[0].notify_count).toBe(2);
		expect(notices[0].last_comment_at).toBe(secondPub);
		expect(await countMailLogs()).toBe(2);
	});

	it('记录过期后 → 再发一封并刷新令牌 / 有效期', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedDormantComment();
		await readComments();
		const before = await allDormantNotices();
		expect(before).toHaveLength(1);

		// 把记录改成已过期
		await testEnv.MOMO_DB.prepare('UPDATE DormantNotice SET expires_at = ?')
			.bind(new Date(Date.now() - 1000).toISOString())
			.run();

		await readComments();

		expect(sentMails).toHaveLength(2);
		const after = await allDormantNotices();
		expect(after).toHaveLength(1);
		expect(after[0].notify_count).toBe(2);
		expect(after[0].token).not.toBe(before[0].token);
		expect(Date.parse(after[0].expires_at)).toBeGreaterThan(Date.now());
	});

	it('link_security_enabled = "false" → 不发信、不落记录，评论照常返回', async () => {
		await seedSettings({ ...BASE_SETTINGS, link_security_enabled: 'false' });
		await seedDormantComment();

		const res = await readComments();
		expect(res.status).toBe(200);
		expect(res.body.data.comments[0].urlDormant).toBe(false);
		expect(sentMails).toHaveLength(0);
		expect(await allDormantNotices()).toHaveLength(0);
		expect(await countMailLogs()).toBe(0);
	});

	it('link_dormant_notice_enabled = "false" → 链接照常休眠，但不发信、不落记录', async () => {
		await seedSettings({ ...BASE_SETTINGS, link_dormant_notice_enabled: 'false' });
		await seedDormantComment();

		const res = await readComments();
		expect(res.status).toBe(200);
		expect(res.body.data.comments[0].urlDormant).toBe(true);
		expect(sentMails).toHaveLength(0);
		expect(await allDormantNotices()).toHaveLength(0);
		expect(await countMailLogs()).toBe(0);
	});

	it('email_verify_enabled = "false" → 即使提醒开关打开也不发信（硬前提）', async () => {
		await seedSettings({ ...BASE_SETTINGS, email_verify_enabled: 'false' });
		await seedDormantComment();

		const res = await readComments();
		expect(res.status).toBe(200);
		expect(res.body.data.comments[0].urlDormant).toBe(true);
		expect(sentMails).toHaveLength(0);
		expect(await allDormantNotices()).toHaveLength(0);
	});

	it('未配置 SMTP → 不发信、不落记录，也不影响评论列表响应', async () => {
		const settings: Record<string, string> = { ...BASE_SETTINGS };
		delete settings.smtp_host;
		delete settings.email_user;
		delete settings.email_password;
		await seedSettings(settings);
		await seedDormantComment();

		const res = await readComments();
		expect(res.status).toBe(200);
		expect(res.body.code).toBe(200);
		expect(res.body.data.comments[0].urlDormant).toBe(true);
		expect(sentMails).toHaveLength(0);
		expect(await allDormantNotices()).toHaveLength(0);
		// 下次读取还会重试（记录没落，所以仍然判定需要提醒）
		await readComments();
		expect(await allDormantNotices()).toHaveLength(0);
	});

	it('同一次请求里同一 (email, url) 只处理一次（同页多条同链接评论只发一封）', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedDormantComment({ post_slug: POST, pub_date: PUB });
		await seedDormantComment({ post_slug: POST, pub_date: PUB - 1000 });
		await seedDormantComment({ post_slug: POST, pub_date: PUB - 2000 });

		await readComments();

		expect(sentMails).toHaveLength(1);
		expect(await allDormantNotices()).toHaveLength(1);
	});

	it('单请求最多发 3 封：5 条休眠链接 → 第一次 3 封，再请求一次补齐剩下 2 封且不重复', async () => {
		await seedSettings(BASE_SETTINGS);
		for (let i = 0; i < 5; i++) {
			await seedComment({
				author: `User${i}`,
				email: `u${i}@x.com`,
				url: `https://u${i}.example.com`,
				pub_date: PUB,
				post_slug: POST,
				status: 'approved',
			});
		}

		await readComments();
		expect(sentMails).toHaveLength(3);
		const first = await allDormantNotices();
		expect(first).toHaveLength(3);
		expect(new Set(first.map((row) => row.email)).size).toBe(3);

		await readComments();
		expect(sentMails).toHaveLength(5);
		const second = await allDormantNotices();
		expect(second).toHaveLength(5);
		// 每个 (email, url) 只提醒一次，没有重复
		expect(new Set(second.map((row) => `${row.email}|${row.url}`)).size).toBe(5);
		expect(second.every((row) => row.notify_count === 1)).toBe(true);

		// 第三次读取：全部已有记录 → 不再发信
		await readComments();
		expect(sentMails).toHaveLength(5);
	});

	it('已被人工确认（有效 TrustedLink）的链接不再提醒', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedDormantComment();
		await testEnv.MOMO_DB.prepare(
			`INSERT INTO TrustedLink (email, url, expires_at, created_at, source) VALUES (?, ?, ?, ?, 'admin')`
		)
			.bind('a@x.com', LINK, new Date(Date.now() + 30 * DAY).toISOString(), new Date().toISOString())
			.run();

		await readComments();

		expect(sentMails).toHaveLength(0);
		expect(await allDormantNotices()).toHaveLength(0);
	});
});

describe('提醒页 GET /api/link-dormant/notice', () => {
	it('令牌有效 → 中文 HTML 页，含当前链接、两个表单与有效期页脚', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedDormantNotice({
			email: 'a@x.com',
			url: LINK,
			last_comment_at: PUB,
			token: 'tok-page',
		});

		const res = await api('/api/link-dormant/notice?token=tok-page');
		expect(res.status).toBe(200);
		const html = String(res.body);
		expect(html).toContain('链接已休眠');
		expect(html).toContain(LINK);
		// 表单 1：confirm
		expect(html).toContain('action="/api/link-dormant/confirm?token=tok-page"');
		expect(html).toContain('我仍在使用');
		// 表单 2：update
		expect(html).toContain('action="/api/link-dormant/update?token=tok-page"');
		expect(html).toContain('name="url"');
		expect(html).toContain('placeholder="https://example.com"');
		expect(html).toContain('提交新链接');
		// 有效期说明
		expect(html).toContain('确认后 30 天内不会再标记为休眠');
	});

	it('缺 token / 未知 token / 已过期 → 三种失败文案', async () => {
		await seedSettings(BASE_SETTINGS);
		expect(String((await api('/api/link-dormant/notice')).body)).toContain('缺少提醒参数。');
		expect(String((await api('/api/link-dormant/notice?token=nope')).body)).toContain(
			'该提醒已失效或已处理。'
		);

		await seedDormantNotice({
			token: 'tok-exp',
			expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		expect(String((await api('/api/link-dormant/notice?token=tok-exp')).body)).toContain(
			'该提醒已过期，请在评论区留言或等待新的提醒邮件。'
		);
	});
});

describe('POST /api/link-dormant/confirm', () => {
	it('确认成功 → TrustedLink(source=self)、删除提醒记录、链接不再休眠；同一 token 再用即失效', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedDormantComment();
		await seedDormantNotice({
			email: 'a@x.com',
			url: LINK,
			last_comment_at: PUB,
			token: 'tok-confirm',
		});

		const res = await api('/api/link-dormant/confirm?token=tok-confirm', { method: 'POST' });
		expect(res.status).toBe(200);
		expect(String(res.body)).toContain('确认成功！该链接已恢复正常，30 天内不会再标记为休眠。');

		const trusts = await allTrustedLinks();
		expect(trusts).toHaveLength(1);
		expect(trusts[0]).toMatchObject({ email: 'a@x.com', url: LINK, source: 'self' });
		expect(Date.parse(trusts[0].expires_at)).toBeGreaterThan(Date.now());

		expect(await getDormantNoticeByToken('tok-confirm')).toBeNull();

		// 链接恢复正常
		const comments = await readComments();
		expect(comments.body.data.comments[0].urlDormant).toBe(false);
		expect(sentMails).toHaveLength(0);

		// 一次性：同一 token 再访问 → 已失效
		const again = await api('/api/link-dormant/confirm?token=tok-confirm', { method: 'POST' });
		expect(String(again.body)).toContain('该提醒已失效或已处理。');
		expect(await allTrustedLinks()).toHaveLength(1);
	});

	it('缺 token → 缺少提醒参数；过期 → 过期文案，且都不落 TrustedLink', async () => {
		await seedSettings(BASE_SETTINGS);
		expect(String((await api('/api/link-dormant/confirm', { method: 'POST' })).body)).toContain(
			'缺少提醒参数。'
		);

		await seedDormantNotice({
			token: 'tok-exp',
			expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		expect(
			String((await api('/api/link-dormant/confirm?token=tok-exp', { method: 'POST' })).body)
		).toContain('该提醒已过期，请在评论区留言或等待新的提醒邮件。');
		expect(await allTrustedLinks()).toHaveLength(0);
	});
});

describe('三个公共端点 —— 处理异常', () => {
	it('端点内部抛错 → 「处理失败，请稍后重试。」（不把 500 抛给访客）', async () => {
		await seedSettings(BASE_SETTINGS);
		// 模拟「查询本身失败」：把表删掉，并先把这条迁移标记为已应用，
		// 免得请求前的启动自迁移又把表补回来
		await testEnv.MOMO_DB.prepare('DROP TABLE DormantNotice').run();
		await testEnv.MOMO_DB.prepare(
			"INSERT OR REPLACE INTO SchemaMigration (id, description) VALUES ('0008_dormant_notice', 'test')"
		).run();

		const page = await api('/api/link-dormant/notice?token=whatever');
		expect(page.status).toBe(200);
		expect(String(page.body)).toContain('处理失败，请稍后重试。');

		const confirm = await api('/api/link-dormant/confirm?token=whatever', { method: 'POST' });
		expect(confirm.status).toBe(200);
		expect(String(confirm.body)).toContain('处理失败，请稍后重试。');

		const update = await api('/api/link-dormant/update?token=whatever', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'url=https%3A%2F%2Fnew.example.com',
		});
		expect(update.status).toBe(200);
		expect(String(update.body)).toContain('处理失败，请稍后重试。');
	});
});

describe('POST /api/link-dormant/update', () => {
	const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

	/** 该邮箱历史评论：approved（本页）+ pending（另一篇）+ rejected（不该被改） */
	async function seedHistory() {
		await seedDormantComment({ post_slug: POST, pub_date: PUB, status: 'approved' });
		await seedComment({
			author: 'Alice',
			email: 'a@x.com',
			url: LINK,
			pub_date: PUB - 1000,
			post_slug: '/other',
			status: 'pending',
		});
		await seedComment({
			author: 'Alice',
			email: 'a@x.com',
			url: LINK,
			pub_date: PUB - 2000,
			post_slug: '/rejected',
			status: 'rejected',
		});
	}

	it('更新成功 → 批量改写该邮箱历史评论（含 pending），返回条数正确，新链接不再休眠', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedHistory();
		await seedDormantNotice({
			email: 'a@x.com',
			url: LINK,
			last_comment_at: PUB,
			token: 'tok-upd',
		});

		const res = await api('/api/link-dormant/update?token=tok-upd', {
			method: 'POST',
			headers: FORM,
			body: `url=${encodeURIComponent('https://new.example.com')}`,
		});
		expect(res.status).toBe(200);
		expect(String(res.body)).toContain('链接更新成功！共 2 条历史评论的网址已更新。');

		const { results: urls } = await testEnv.MOMO_DB.prepare(
			'SELECT url, status FROM Comment ORDER BY id ASC'
		).all<{ url: string; status: string }>();
		expect(urls.map((row) => row.url)).toEqual([
			'https://new.example.com',
			'https://new.example.com',
			LINK, // rejected 的不动
		]);

		const trusts = await allTrustedLinks();
		expect(trusts).toHaveLength(1);
		expect(trusts[0]).toMatchObject({ email: 'a@x.com', url: 'https://new.example.com', source: 'self' });
		expect(await getDormantNoticeByToken('tok-upd')).toBeNull();

		// 新链接在 N 天内不再休眠
		const comments = await readComments();
		expect(comments.body.data.comments[0].url).toBe('https://new.example.com');
		expect(comments.body.data.comments[0].urlDormant).toBe(false);
		expect(sentMails).toHaveLength(0);
	});

	it('新链接与现有链接相同 → 成功但「未做修改」', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedHistory();
		await seedDormantNotice({
			email: 'a@x.com',
			url: LINK,
			last_comment_at: PUB,
			token: 'tok-same',
		});

		const res = await api('/api/link-dormant/update?token=tok-same', {
			method: 'POST',
			headers: FORM,
			body: `url=${encodeURIComponent(LINK)}`,
		});
		expect(String(res.body)).toContain('新链接与现有链接相同，未做修改。');
		// 仍然写入确认记录并删除提醒记录（否则新链接会立刻又被判休眠）
		expect(await allTrustedLinks()).toHaveLength(1);
		expect(await getDormantNoticeByToken('tok-same')).toBeNull();
	});

	it('非法 url（javascript: / mailto: / 协议相对 / 空）→ 失败文案且不改任何评论', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedHistory();
		await seedDormantNotice({
			email: 'a@x.com',
			url: LINK,
			last_comment_at: PUB,
			token: 'tok-bad',
		});

		for (const bad of ['javascript:alert(1)', 'mailto:a@x.com', '//evil.example.com', '', '   ']) {
			const res = await api('/api/link-dormant/update?token=tok-bad', {
				method: 'POST',
				headers: FORM,
				body: `url=${encodeURIComponent(bad)}`,
			});
			expect(String(res.body), bad).toContain(
				'新链接格式不正确，请填写以 http:// 或 https:// 开头的网址。'
			);
		}

		// 评论一条都没改，提醒记录也还在（令牌仍可重试）
		const unchanged = await testEnv.MOMO_DB.prepare(
			"SELECT COUNT(*) as count FROM Comment WHERE url = ?"
		)
			.bind(LINK)
			.first<{ count: number }>();
		expect(unchanged?.count).toBe(3);
		expect(await allTrustedLinks()).toHaveLength(0);
		expect(await getDormantNoticeByToken('tok-bad')).not.toBeNull();
	});

	it('缺 token / 未知 token / 已过期 → 三种失败文案', async () => {
		await seedSettings(BASE_SETTINGS);
		const FORM_EMPTY = { ...FORM };
		expect(
			String(
				(await api('/api/link-dormant/update', { method: 'POST', headers: FORM_EMPTY, body: 'url=' }))
					.body
			)
		).toContain('缺少提醒参数。');
		expect(
			String(
				(
					await api('/api/link-dormant/update?token=nope', {
						method: 'POST',
						headers: FORM,
						body: 'url=https%3A%2F%2Fnew.example.com',
					})
				).body
			)
		).toContain('该提醒已失效或已处理。');

		await seedDormantNotice({
			token: 'tok-exp',
			expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		expect(
			String(
				(
					await api('/api/link-dormant/update?token=tok-exp', {
						method: 'POST',
						headers: FORM,
						body: 'url=https%3A%2F%2Fnew.example.com',
					})
				).body
			)
		).toContain('该提醒已过期，请在评论区留言或等待新的提醒邮件。');
	});

	it('更新后旧 token 失效（一次性）', async () => {
		await seedSettings(BASE_SETTINGS);
		await seedHistory();
		await seedDormantNotice({
			email: 'a@x.com',
			url: LINK,
			last_comment_at: PUB,
			token: 'tok-once',
		});

		await api('/api/link-dormant/update?token=tok-once', {
			method: 'POST',
			headers: FORM,
			body: `url=${encodeURIComponent('https://new.example.com')}`,
		});
		const again = await api('/api/link-dormant/update?token=tok-once', {
			method: 'POST',
			headers: FORM,
			body: `url=${encodeURIComponent('https://another.example.com')}`,
		});
		expect(String(again.body)).toContain('该提醒已失效或已处理。');
		// 第二次没有生效
		expect((await getComment(1))?.url).toBe('https://new.example.com');
	});
});
