import { describe, it, expect } from 'vitest';
import {
	applyTemplate,
	buildMailPreview,
	escapeHtml,
	MAIL_SAMPLE_DATA,
	MAIL_TEMPLATE_KINDS,
} from '../src/utils/mailTemplates.js';

/**
 * 面板预览的口径测试。
 *
 * 这些断言对应 `doc/mail.md` 第 2 节（占位符 / 转义 / 原样插入）与三端
 * `applyTemplate` 的实现：预览要是和真实发信不一致，管理员照着预览调出来的模板
 * 到了收件箱就是另一个样子。
 */

describe('escapeHtml —— 与三端 htmlEscape 一致', () => {
	it('五个实体按 & < > " \' 的顺序替换（& 先替换，避免二次转义）', () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
			'&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
		);
	});

	it('null / undefined / 数字都能安全处理', () => {
		expect(escapeHtml(null)).toBe('');
		expect(escapeHtml(undefined)).toBe('');
		expect(escapeHtml(42)).toBe('42');
	});
});

describe('applyTemplate —— 占位符替换', () => {
	it('纯文本占位符做 HTML 转义', () => {
		expect(applyTemplate('Hi {{toName}}', { toName: '<b>小明</b>' })).toBe(
			'Hi &lt;b&gt;小明&lt;/b&gt;',
		);
	});

	it('*Html 占位符原样插入（不转义）', () => {
		const html = '<p><img src="x" alt="y"></p>';
		expect(applyTemplate('{{replyContentHtml}}', {}, { replyContentHtml: html })).toBe(html);
	});

	it('同一个占位符出现多次时全部替换', () => {
		expect(applyTemplate('{{postTitle}} / {{postTitle}}', { postTitle: 'A&B' })).toBe(
			'A&amp;B / A&amp;B',
		);
	});

	it('未匹配的 {{...}} 保持原样', () => {
		expect(applyTemplate('{{unknown}} {{toName}}', { toName: 'Momo' })).toBe('{{unknown}} Momo');
	});

	it('值里的 $& / $1 不会被当成替换模式展开（只有 & 按转义规则变成 &amp;）', () => {
		expect(applyTemplate('{{x}}', { x: '$& $1' })).toBe('$&amp; $1');
	});

	it('空模板返回空串', () => {
		expect(applyTemplate('', { toName: 'Momo' })).toBe('');
	});
});

describe('buildMailPreview —— 默认模板回落', () => {
	it('模板为空串时用默认模板，并标记 isDefault', () => {
		const preview = buildMailPreview({ kind: 'reply', template: '' });
		expect(preview.isDefault).toBe(true);
		expect(preview.kind).toBe('reply');
		expect(preview.html).toContain('回复了您在');
		expect(preview.html).toContain('最新回复');
	});

	it('默认模板里的纯文本字段已转义（& < > 不会变成标签）', () => {
		const preview = buildMailPreview({ kind: 'reply', template: '' });
		expect(preview.html).toContain('Hi 小明 &amp; 朋友们，');
		expect(preview.html).toContain('Momo &lt;站长&gt;');
		// 原评论 / 回复的 HTML 原样插入
		expect(preview.html).toContain('<strong>粗体</strong>');
		expect(preview.html).toContain('<img src="data:image/svg+xml');
	});

	it('template 缺省（undefined / null）同样回落默认模板', () => {
		expect(buildMailPreview({ kind: 'notification' }).isDefault).toBe(true);
		expect(buildMailPreview({ kind: 'notification', template: null }).isDefault).toBe(true);
	});

	it('纯空白模板按自定义模板渲染（与后端 getTemplate 的 t || fallback 一致）', () => {
		const preview = buildMailPreview({ kind: 'reply', template: '   ' });
		expect(preview.isDefault).toBe(false);
		expect(preview.html).toBe('   ');
	});

	it('默认模板与新评论通知的正文/主题对应', () => {
		const preview = buildMailPreview({ kind: 'notification', template: '', siteName: '我的博客' });
		expect(preview.isDefault).toBe(true);
		expect(preview.subject).toBe('您在 我的博客 上有新的评论');
		expect(preview.html).toContain('有人在您的文章下发表了评论');
		expect(preview.html).toContain('Momo &lt;站长&gt;');
	});
});

describe('buildMailPreview —— 自定义模板', () => {
	it('回复模板：六个纯文本占位符 + 两个原样占位符', () => {
		const template = [
			'<p>{{toName}} / {{replyAuthor}} / {{postTitle}} / {{postUrl}}</p>',
			'<div>{{parentComment}}</div>',
			'<div>{{replyContent}}</div>',
			'<div>{{parentCommentHtml}}</div>',
			'<div>{{replyContentHtml}}</div>',
		].join('\n');
		const preview = buildMailPreview({ kind: 'reply', template });

		expect(preview.isDefault).toBe(false);
		expect(preview.html).toContain('小明 &amp; 朋友们');
		expect(preview.html).toContain('Momo &lt;站长&gt;');
		expect(preview.html).toContain('https://example.com/posts/momo-mail-template');
		// 纯文本占位符被转义：尖括号变成实体，不会真的生成标签
		expect(preview.html).not.toContain('Momo <站长>');
		// 原样占位符保留真实标签
		expect(preview.html).toContain('原评论：这篇文章里的<strong>粗体</strong>');
		expect(preview.html).toContain('<img src="data:image/svg+xml');
	});

	it('通知模板：四个纯文本占位符 + commentContentHtml', () => {
		const template = '<p>{{postTitle}}|{{postUrl}}|{{commentAuthor}}|{{commentContent}}</p>{{commentContentHtml}}';
		const preview = buildMailPreview({ kind: 'notification', template });
		expect(preview.isDefault).toBe(false);
		expect(preview.html).toContain('如何在 Momo 里自定义邮件模板');
		expect(preview.html).toContain('https://example.com/posts/momo-mail-template');
		expect(preview.html).toContain('Momo &lt;站长&gt;');
		expect(preview.html).not.toContain('Momo <站长>');
		expect(preview.html).toContain('<a href="https://example.com/album">链接</a>');
	});

	it('主题里的站点名缺省回落 Momo Blog', () => {
		expect(buildMailPreview({ kind: 'reply', template: '' }).subject).toBe(
			'您在 Momo Blog 上的评论有了新回复',
		);
		expect(buildMailPreview({ kind: 'reply', template: '', siteName: '  ' }).subject).toBe(
			'您在 Momo Blog 上的评论有了新回复',
		);
	});

	it('未知模板类型直接抛错（避免静默预览到别的模板）', () => {
		expect(() => buildMailPreview({ kind: 'test' })).toThrow(/Unknown mail template kind/);
	});
});

describe('演示数据与模板元信息', () => {
	it('演示数据冻结，避免预览过程中被意外修改', () => {
		expect(Object.isFrozen(MAIL_SAMPLE_DATA)).toBe(true);
	});

	it('模板类型与设置键对应后端字段', () => {
		expect(MAIL_TEMPLATE_KINDS.reply.settingKey).toBe('reply_template');
		expect(MAIL_TEMPLATE_KINDS.notification.settingKey).toBe('notification_template');
		expect(MAIL_TEMPLATE_KINDS.reply.label).toBe('回复通知');
		expect(MAIL_TEMPLATE_KINDS.notification.label).toBe('新评论通知');
	});
});
