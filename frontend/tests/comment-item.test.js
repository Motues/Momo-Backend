import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import CommentItem from '../src/comment/CommentItem.svelte';
import { makeComment, stubMatchMedia, stubAlert, findButton, sha256HexOf, patchHappyDomAnimation } from './helpers';

// 回复框使用 transition:slide，销毁时的 animation.cancel() 会产生 happy-dom 的
// unhandled rejection，先中和掉（详见 helpers.js）
beforeAll(patchHappyDomAnimation);

/** 桌面端默认渲染（happy-dom 默认宽度 1024，matchMedia 不命中移动端断点） */
function renderItem(props = {}, events = {}) {
	return render(CommentItem, {
		props: {
			c: makeComment(),
			postSlug: '/posts/demo',
			apiUrl: 'https://api.example.com',
			...props,
		},
		events,
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	cleanup();
});

describe('CommentItem —— 基础渲染', () => {
	it('渲染作者昵称', () => {
		const { container } = renderItem({ c: makeComment({ author: '张三' }) });
		expect(container.textContent).toContain('张三');
	});

	it('根节点带 id="comment-{id}"（锚点跳转依赖它）', () => {
		const { container } = renderItem({ c: makeComment({ id: 42 }) });
		expect(container.querySelector('#comment-42')).toBeTruthy();
	});

	it('根节点带 data-aos 属性（宿主页面的滚动动画依赖它）', () => {
		const { container } = renderItem();
		expect(container.querySelector('[data-aos="fade-up"]')).toBeTruthy();
	});

	it('数字型 pubDate（毫秒）渲染出格式化日期', () => {
		const { container } = renderItem({ c: makeComment({ pubDate: 1730000000000 }), language: 'zh-cn' });
		expect(container.textContent).toContain('2024 年 10 月 27 日');
	});

	it('language="en" 时日期按英文格式渲染', () => {
		const { container } = renderItem({ c: makeComment({ pubDate: 1730000000000 }), language: 'en' });
		expect(container.textContent).toContain('Oct 27, 2024');
	});

	it('"YYYY-MM-DD" 字符串型 pubDate 也能渲染', () => {
		const { container } = renderItem({ c: makeComment({ pubDate: '2024-01-05' }), language: 'zh-cn' });
		expect(container.textContent).toContain('2024 年 1 月 5 日');
	});

	it('0 与负数时间戳按 1970 处理，不抛错', () => {
		expect(() => renderItem({ c: makeComment({ pubDate: 0 }) })).not.toThrow();
		cleanup();
		const { container } = renderItem({ c: makeComment({ pubDate: -1 }), language: 'zh-cn' });
		expect(container.textContent).toContain('1970 年 1 月 1 日');
	});

	it('缺失 pubDate 会让整个组件渲染抛 RangeError（未做兜底，见最终报告）', () => {
		const c = makeComment();
		delete c.pubDate;
		expect(() => renderItem({ c })).toThrow(RangeError);
	});

	it('pubDate 为无法解析的字符串同样抛 RangeError', () => {
		expect(() => renderItem({ c: makeComment({ pubDate: 'not-a-date' }) })).toThrow(RangeError);
	});

	it('缺失可选字段（avatar/url/status/device/browser/os/parentId）不会抛错', () => {
		const c = { id: 9, author: 'Bob', pubDate: 1730000000000, contentText: 'hi' };
		expect(() => renderItem({ c })).not.toThrow();
	});

	it('c.replies 缺失时不会渲染子级区块', () => {
		const { container } = renderItem({ c: makeComment() });
		expect(container.textContent).not.toContain('查看剩余回复');
	});
});

describe('CommentItem —— 评论内容渲染', () => {
	it('contentHtml 被渲染为 HTML', () => {
		const { container } = renderItem({ c: makeComment({ contentHtml: '<p>带<strong>粗体</strong>的内容</p>' }) });
		expect(container.querySelector('.markdown-content strong')?.textContent).toBe('粗体');
	});

	it('contentHtml 中的 <script> 被 DOMPurify 清理', () => {
		const { container } = renderItem({
			c: makeComment({ contentHtml: '<p>hi</p><script>window.__xss = 1</script>' }),
		});
		expect(container.querySelector('script')).toBeNull();
		expect(container.textContent).toContain('hi');
	});

	it('contentHtml 中的事件属性被清理（img onerror）', () => {
		const { container } = renderItem({
			c: makeComment({ contentHtml: '<img src=x onerror="window.__xss=1">' }),
		});
		const img = container.querySelector('.markdown-content img');
		expect(img).toBeTruthy();
		expect(img.getAttribute('onerror')).toBeNull();
	});

	it('contentHtml 中的 javascript: 链接被清理', () => {
		const { container } = renderItem({
			c: makeComment({ contentHtml: '<a href="javascript:alert(1)">x</a>' }),
		});
		const a = container.querySelector('.markdown-content a');
		expect(a?.getAttribute('href') ?? '').not.toContain('javascript:');
	});

	it('contentHtml 非法（未闭合标签）时回退为纯文本并转义', () => {
		const { container } = renderItem({ c: makeComment({ contentHtml: '<div', contentText: '' }) });
		const content = container.querySelector('.markdown-content');
		expect(content.textContent).toContain('<div');
		// 走的是纯文本 <p> 分支，不会生成真实的 div 元素
		expect(content.querySelector('p')).toBeTruthy();
		expect(content.querySelectorAll('div').length).toBe(0);
	});

	it('没有 contentHtml 时使用 contentText', () => {
		const { container } = renderItem({ c: makeComment({ contentHtml: '', contentText: '纯文本内容' }) });
		expect(container.textContent).toContain('纯文本内容');
	});

	it('contentHtml 为纯文本时按 HTML 分支渲染（isValidHtml 认为文本也算节点）', () => {
		const { container } = renderItem({ c: makeComment({ contentHtml: 'just text', contentText: '' }) });
		expect(container.textContent).toContain('just text');
	});

	it('内容全空时显示兜底文案并触发 i18n 告警（comments.noContent 键缺失）', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { container } = renderItem({ c: makeComment({ contentHtml: '', contentText: '' }) });
		expect(container.textContent).toContain('评论内容为空');
		expect(warn.mock.calls.map((c) => c[0])).toContain(
			'[i18n] missing translation key: comments.noContent (zh-cn)'
		);
	});

	it('contentText 只有空白字符时也走兜底文案', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { container } = renderItem({ c: makeComment({ contentHtml: '   ', contentText: '   ' }) });
		expect(container.textContent).toContain('评论内容为空');
	});

	it('超长 contentHtml 不会抛错', () => {
		const long = '<p>' + 'x'.repeat(100000) + '</p>';
		expect(() => renderItem({ c: makeComment({ contentHtml: long, contentText: '' }) })).not.toThrow();
	});

	it('contentHtml 非字符串（数字/对象）时回退到 contentText', () => {
		const { container } = renderItem({ c: makeComment({ contentHtml: 123, contentText: 'fallback' }) });
		expect(container.textContent).toContain('fallback');
		expect(container.textContent).not.toContain('123');
	});
});

describe('CommentItem —— 作者链接的协议过滤', () => {
	it('https 链接会渲染 <a>（头像与昵称都是链接）', () => {
		const { container } = renderItem({ c: makeComment({ url: 'https://me.example.com' }) });
		const anchors = [...container.querySelectorAll('a')];
		expect(anchors.length).toBe(2);
		for (const a of anchors) {
			expect(a.getAttribute('href')).toBe('https://me.example.com');
			expect(a.getAttribute('rel')).toBe('noopener noreferrer');
		}
	});

	it('相对路径被允许', () => {
		const { container } = renderItem({ c: makeComment({ url: '/about' }) });
		expect(container.querySelector('a')?.getAttribute('href')).toBe('/about');
	});

	it('mailto: 被允许', () => {
		const { container } = renderItem({ c: makeComment({ url: 'mailto:me@example.com' }) });
		expect(container.querySelector('a')?.getAttribute('href')).toBe('mailto:me@example.com');
	});

	it('javascript: 被拦截，不产生任何 href', () => {
		const { container } = renderItem({ c: makeComment({ url: 'javascript:alert(1)' }) });
		expect(container.querySelectorAll('a').length).toBe(0);
		expect(container.innerHTML).not.toContain('javascript:');
	});

	it('大小写混合的 JavaScript: 同样被拦截（URL 协议已归一化）', () => {
		const { container } = renderItem({ c: makeComment({ url: 'JaVaScRiPt:alert(1)' }) });
		expect(container.querySelectorAll('a').length).toBe(0);
	});

	it('data: 被拦截', () => {
		const { container } = renderItem({ c: makeComment({ url: 'data:text/html,<b>x</b>' }) });
		expect(container.querySelectorAll('a').length).toBe(0);
	});

	it('ftp: 被拦截（白名单只有 http/https/mailto）', () => {
		const { container } = renderItem({ c: makeComment({ url: 'ftp://files.example.com' }) });
		expect(container.querySelectorAll('a').length).toBe(0);
	});

	it('畸形 URL 解析失败时按不安全处理，不抛错', () => {
		expect(() => renderItem({ c: makeComment({ url: 'http://[invalid' }) })).not.toThrow();
		cleanup();
		const { container } = renderItem({ c: makeComment({ url: 'http://[invalid', author: 'StillHere' }) });
		expect(container.querySelectorAll('a').length).toBe(0);
		expect(container.textContent).toContain('StillHere');
	});

	it('url 为空串/null/undefined 时不产生链接', () => {		for (const url of ['', null, undefined]) {
			const { container } = renderItem({ c: makeComment({ url }) });
			expect(container.querySelectorAll('a').length, `url=${url}`).toBe(0);
			cleanup();
		}
	});

	it('url 为非字符串（数字/对象）时不产生链接', () => {
		for (const url of [123, {}, [], true]) {
			const { container } = renderItem({ c: makeComment({ url }) });
			expect(container.querySelectorAll('a').length, `url=${JSON.stringify(url)}`).toBe(0);
			cleanup();
		}
	});

	it('无链接时昵称用 <span> 渲染（不丢失作者名）', () => {
		const { container } = renderItem({ c: makeComment({ url: 'javascript:void(0)', author: 'NoLink' }) });
		expect(container.querySelector('span.font-semibold')?.textContent).toBe('NoLink');
	});
});

describe('CommentItem —— 头像', () => {
	it('有 avatar 时 img.src 使用该地址', () => {
		const { container } = renderItem({ c: makeComment({ avatar: 'https://cdn.example.com/a.png' }) });
		expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/a.png');
	});

	it('avatar 为 undefined 时 img 不带 src 属性（不渲染 "undefined"）', () => {
		const c = makeComment();
		delete c.avatar;
		const { container } = renderItem({ c });
		const img = container.querySelector('img');
		expect(img).toBeTruthy();
		expect(img.hasAttribute('src')).toBe(false);
	});

	it('avatar 为 null 时不带 src 属性', () => {
		const { container } = renderItem({ c: makeComment({ avatar: null }) });
		expect(container.querySelector('img').hasAttribute('src')).toBe(false);
	});

	it('avatar 为空串时 src 为空（记录现状）', () => {
		const { container } = renderItem({ c: makeComment({ avatar: '' }) });
		expect(container.querySelector('img').getAttribute('src')).toBe('');
	});

	it('img 始终带 alt="avatar"', () => {
		const { container } = renderItem();
		expect(container.querySelector('img').getAttribute('alt')).toBe('avatar');
	});
});

describe('CommentItem —— 博主徽章', () => {
	it('isBlogger + bloggerBadgeEnabled 时显示文本徽章', () => {
		const { container } = renderItem({
			c: makeComment({ isBlogger: true }),
			bloggerBadgeEnabled: true,
			bloggerBadgeText: '博主',
		});
		expect(container.querySelector('.blogger-badge')?.textContent).toBe('博主');
	});

	it('bloggerBadgeText 为空时显示图标徽章', () => {
		const { container } = renderItem({
			c: makeComment({ isBlogger: true }),
			bloggerBadgeEnabled: true,
			bloggerBadgeText: '',
		});
		expect(container.querySelector('.blogger-badge-icon')).toBeTruthy();
		expect(container.querySelector('.blogger-badge')).toBeNull();
	});

	it('bloggerBadgeEnabled=false 时不显示徽章', () => {
		const { container } = renderItem({
			c: makeComment({ isBlogger: true }),
			bloggerBadgeEnabled: false,
			bloggerBadgeText: '博主',
		});
		expect(container.querySelector('.blogger-badge')).toBeNull();
		expect(container.querySelector('.blogger-badge-icon')).toBeNull();
	});

	it('isBlogger 非真值时即使开关打开也不显示徽章', () => {
		const { container } = renderItem({ c: makeComment(), bloggerBadgeEnabled: true, bloggerBadgeText: '博主' });
		expect(container.querySelector('.blogger-badge')).toBeNull();
	});

	it('自定义徽章文案（英文）', () => {
		const { container } = renderItem({
			c: makeComment({ isBlogger: true }),
			bloggerBadgeEnabled: true,
			bloggerBadgeText: 'Author',
			language: 'en',
		});
		expect(container.querySelector('.blogger-badge')?.textContent).toBe('Author');
	});
});

describe('CommentItem —— 回复表单开关', () => {
	it('replyingToId 不等于本条 id 时不显示表单', () => {
		const { container } = renderItem({ replyingToId: 999 });
		expect(container.querySelector('form')).toBeNull();
	});

	it('replyingToId 等于本条 id 时显示表单', () => {
		const { container } = renderItem({ replyingToId: 1 });
		expect(container.querySelector('form')).toBeTruthy();
		expect(container.querySelector('textarea')).toBeTruthy();
	});

	it('表单包含昵称/邮箱/网站三个输入框，id 带评论号', () => {
		const { container } = renderItem({ c: makeComment({ id: 7 }), replyingToId: 7 });
		expect(container.querySelector('#reply-author-7')).toBeTruthy();
		expect(container.querySelector('#reply-email-7')).toBeTruthy();
		expect(container.querySelector('#reply-url-7')).toBeTruthy();
	});

	it('表单默认不显示管理员密钥输入（adminCommentKeyConfigured=false）', () => {
		const { container } = renderItem({ replyingToId: 1 });
		expect(container.querySelector('#reply-admin-key-1')).toBeNull();
	});

	it('点击回复按钮派发 reply 事件并携带评论 id', async () => {
		const details = [];
		const { container } = renderItem({ c: makeComment({ id: 3 }) }, { reply: (e) => details.push(e.detail) });
		await fireEvent.click(findButton(container, '回复'));
		expect(details).toEqual([3]);
	});

	it('zh-cn 下回复按钮文案是「回复」，en 下是 Reply', () => {
		const zh = renderItem();
		expect(findButton(zh.container, '回复')).toBeTruthy();
		cleanup();
		const en = renderItem({ language: 'en' });
		expect(findButton(en.container, 'Reply')).toBeTruthy();
	});

	it('点击回复后父组件打开表单，输入框被预填用户信息', async () => {
		const { container, rerender } = renderItem({
			author: 'Bob',
			email: 'bob@example.com',
			url: 'https://bob.example.com',
		});
		await fireEvent.click(findButton(container, '回复'));
		await rerender({ replyingToId: 1 });
		expect(container.querySelector('#reply-author-1').value).toBe('Bob');
		expect(container.querySelector('#reply-email-1').value).toBe('bob@example.com');
		expect(container.querySelector('#reply-url-1').value).toBe('https://bob.example.com');
	});

	it('输入昵称会派发 userInfoChange（父组件据此更新用户信息）', async () => {
		const details = [];
		const { container } = renderItem({ replyingToId: 1 }, { userInfoChange: (e) => details.push(e.detail) });
		await fireEvent.input(container.querySelector('#reply-author-1'), { target: { value: 'NewName' } });
		expect(details.at(-1)).toEqual({ author: 'NewName', email: '', url: '' });
	});

	it('点击取消派发 cancel 事件', async () => {
		const cancel = vi.fn();
		const { container } = renderItem({ replyingToId: 1 }, { cancel });
		await fireEvent.click(findButton(container, '取消'));
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it('表单关闭（replyingToId 变回 null）后重新打开，内容被清空', async () => {
		const { container, rerender } = renderItem({ replyingToId: 1 });
		await fireEvent.input(container.querySelector('textarea'), { target: { value: '临时内容' } });
		await rerender({ replyingToId: null });
		await rerender({ replyingToId: 1 });
		expect(container.querySelector('textarea').value).toBe('');
	});
});

describe('CommentItem —— 回复提交', () => {
	async function fillForm(container, { author = 'Bob', email = 'bob@example.com', url = 'https://b.example.com', content = '回复内容' } = {}) {
		await fireEvent.input(container.querySelector('#reply-author-1'), { target: { value: author } });
		await fireEvent.input(container.querySelector('#reply-email-1'), { target: { value: email } });
		await fireEvent.input(container.querySelector('#reply-url-1'), { target: { value: url } });
		await fireEvent.input(container.querySelector('textarea'), { target: { value: content } });
	}

	it('提交合法内容时派发 submit，detail 字段完整', async () => {
		const details = [];
		const { container } = renderItem({ c: makeComment({ id: 1 }), replyingToId: 1 }, { submit: (e) => details.push(e.detail) });
		await fillForm(container);
		await fireEvent.click(container.querySelector('button[type=submit]'));

		expect(details.length).toBe(1);
		expect(details[0]).toMatchObject({
			parentId: 1,
			author: 'Bob',
			email: 'bob@example.com',
			url: 'https://b.example.com',
			content: '回复内容',
			admin_key: undefined,
		});
		expect(details[0].post_url).toBe(window.location.href);
	});

	it('未填写昵称/邮箱时弹出提示且不派发 submit', async () => {
		const alertSpy = stubAlert();
		const submit = vi.fn();
		const { container } = renderItem({ replyingToId: 1 }, { submit });
		await fireEvent.input(container.querySelector('textarea'), { target: { value: 'hi' } });
		await fireEvent.click(container.querySelector('button[type=submit]'));
		expect(submit).not.toHaveBeenCalled();
		expect(alertSpy).toHaveBeenCalledWith('请填写昵称、邮箱和评论内容');
	});

	it('en 语言下必填提示为英文', async () => {
		const alertSpy = stubAlert();
		const { container } = renderItem({ replyingToId: 1, language: 'en' });
		await fireEvent.input(container.querySelector('textarea'), { target: { value: 'hi' } });
		await fireEvent.click(container.querySelector('button[type=submit]'));
		expect(alertSpy).toHaveBeenCalledWith('Please fill in name, email and comment content');
	});

	it('内容超过 2000 字时提交按钮禁用，且不会派发 submit', async () => {
		const submit = vi.fn();
		const { container } = renderItem({ replyingToId: 1 }, { submit });
		await fillForm(container, { content: 'x'.repeat(2001) });
		const button = container.querySelector('button[type=submit]');
		expect(button.disabled).toBe(true);
		await fireEvent.click(button);
		expect(submit).not.toHaveBeenCalled();
	});

	it('内容超过 1000 个单词时也会被限制', async () => {
		const submit = vi.fn();
		const { container } = renderItem({ replyingToId: 1 }, { submit });
		await fillForm(container, { content: 'word '.repeat(1001) });
		expect(container.querySelector('button[type=submit]').disabled).toBe(true);
		await fireEvent.click(container.querySelector('button[type=submit]'));
		expect(submit).not.toHaveBeenCalled();
	});

	it('显示超出限制的红色提示文案', async () => {
		const { container } = renderItem({ replyingToId: 1 });
		await fillForm(container, { content: 'x'.repeat(2001) });
		expect(container.textContent).toContain('评论内容超出限制');
	});

	it('绕过按钮禁用直接提交表单时：提示超限且不派发 submit', async () => {
		const alertSpy = stubAlert();
		const submit = vi.fn();
		const { container } = renderItem({ replyingToId: 1 }, { submit });
		await fillForm(container, { content: 'x'.repeat(2001) });
		await fireEvent.submit(container.querySelector('form'));
		expect(submit).not.toHaveBeenCalled();
		expect(alertSpy).toHaveBeenCalledWith('评论内容超出限制：不超过2000字或1000单词');
	});

	it('正好 2000 字仍然可以提交（边界内）', async () => {
		const details = [];
		const { container } = renderItem({ replyingToId: 1 }, { submit: (e) => details.push(e.detail) });
		await fillForm(container, { content: 'x'.repeat(2000) });
		await fireEvent.click(container.querySelector('button[type=submit]'));
		expect(details.length).toBe(1);
	});

	it('replySubmittingId === c.id 时按钮禁用且显示"发送中..."', () => {
		const { container } = renderItem({ replyingToId: 1, replySubmittingId: 1 });
		const button = container.querySelector('button[type=submit]');
		expect(button.disabled).toBe(true);
		expect(button.textContent.trim()).toBe('发送中...');
	});

	it('replySubmittingId 指向其它评论时本条仍可提交', () => {
		const { container } = renderItem({ replyingToId: 1, replySubmittingId: 2 });
		expect(container.querySelector('button[type=submit]').textContent.trim()).toBe('回复');
	});

	it('提交中再次点击提交按钮不会重复派发（禁用保护）', async () => {
		const submit = vi.fn();
		const { container } = renderItem({ replyingToId: 1, replySubmittingId: 1 }, { submit });
		await fillForm(container);
		await fireEvent.click(container.querySelector('button[type=submit]'));
		await fireEvent.submit(container.querySelector('form'));
		expect(submit).not.toHaveBeenCalled();
	});
});

describe('CommentItem —— Markdown 预览', () => {
	it('空内容时预览按钮禁用', () => {
		const { container } = renderItem({ replyingToId: 1 });
		expect(findButton(container, '预览').disabled).toBe(true);
	});

	it('输入内容后预览按钮可用，点击后渲染解析后的 HTML', async () => {
		const { container } = renderItem({ replyingToId: 1 });
		await fireEvent.input(container.querySelector('textarea'), { target: { value: '# 标题' } });
		await fireEvent.click(findButton(container, '预览'));
		const boxes = [...container.querySelectorAll('.markdown-content')];
		const preview = boxes.at(-1);
		expect(preview.querySelector('h1')?.textContent).toBe('标题');
		expect(findButton(container, '编辑')).toBeTruthy();
	});

	it('预览内容同样经过 DOMPurify 清理', async () => {
		const { container } = renderItem({ replyingToId: 1 });
		await fireEvent.input(container.querySelector('textarea'), { target: { value: '<img src=x onerror="window.__x=1">' } });
		await fireEvent.click(findButton(container, '预览'));
		expect(container.querySelector('textarea')).toBeNull();
		expect(container.querySelector('.markdown-content img')?.hasAttribute('onerror') ?? false).toBe(false);
	});

	it('未闭合代码块显示告警文案', async () => {
		const { container } = renderItem({ replyingToId: 1 });
		await fireEvent.input(container.querySelector('textarea'), { target: { value: '```\ncode' } });
		await fireEvent.click(findButton(container, '预览'));
		expect(container.textContent).toContain('代码块标记 ``` 未闭合');
	});

	it('未闭合行内反引号显示对应告警', async () => {
		const { container } = renderItem({ replyingToId: 1 });
		await fireEvent.input(container.querySelector('textarea'), { target: { value: 'a ` b' } });
		await fireEvent.click(findButton(container, '预览'));
		expect(container.textContent).toContain('行内代码标记 ` 未闭合');
	});

	it('再次点击可切回编辑模式（恢复 textarea 且内容保留）', async () => {
		const { container } = renderItem({ replyingToId: 1 });
		await fireEvent.input(container.querySelector('textarea'), { target: { value: '内容' } });
		await fireEvent.click(findButton(container, '预览'));
		await fireEvent.click(findButton(container, '编辑'));
		expect(container.querySelector('textarea').value).toBe('内容');
	});
});

describe('CommentItem —— 桌面端嵌套回复', () => {
	const withReplies = (replies) => makeComment({ replies });

	it('默认只渲染第一条回复', () => {
		const { container } = renderItem({
			c: withReplies([
				makeComment({ id: 2, author: 'R1', contentText: 'r1' }),
				makeComment({ id: 3, author: 'R2', contentText: 'r2' }),
			]),
		});
		expect(container.querySelector('#comment-2')).toBeTruthy();
		expect(container.querySelector('#comment-3')).toBeNull();
		expect(container.textContent).toContain('查看剩余回复');
	});

	it('只有一条回复时不显示"查看剩余回复"', () => {
		const { container } = renderItem({ c: withReplies([makeComment({ id: 2, author: 'R1' })]) });
		expect(container.querySelector('#comment-2')).toBeTruthy();
		expect(container.textContent).not.toContain('查看剩余回复');
	});

	it('点击"查看剩余回复"展开全部，按钮变成"收起回复"', async () => {
		const { container } = renderItem({
			c: withReplies([
				makeComment({ id: 2, author: 'R1' }),
				makeComment({ id: 3, author: 'R2' }),
				makeComment({ id: 4, author: 'R3' }),
			]),
		});
		await fireEvent.click(findButton(container, '查看剩余回复'));
		expect(container.querySelector('#comment-2')).toBeTruthy();
		expect(container.querySelector('#comment-3')).toBeTruthy();
		expect(container.querySelector('#comment-4')).toBeTruthy();
		expect(findButton(container, '收起回复')).toBeTruthy();
	});

	it('再次点击可以收起', async () => {
		const { container } = renderItem({
			c: withReplies([makeComment({ id: 2, author: 'R1' }), makeComment({ id: 3, author: 'R2' })]),
		});
		await fireEvent.click(findButton(container, '查看剩余回复'));
		await fireEvent.click(findButton(container, '收起回复'));
		expect(container.querySelector('#comment-3')).toBeNull();
	});

	it('子回复会递归渲染孙级回复', () => {
		const { container } = renderItem({
			c: withReplies([
				makeComment({
					id: 2,
					author: 'R1',
					replies: [makeComment({ id: 5, author: 'G1', contentHtml: '', contentText: 'nested' })],
				}),
			]),
		});
		expect(container.querySelector('#comment-5')).toBeTruthy();
		expect(container.textContent).toContain('nested');
	});

	it('空 replies 数组不渲染任何子级', () => {
		const { container } = renderItem({ c: withReplies([]) });
		expect(container.textContent).not.toContain('查看剩余回复');
	});

	it('replies 为 null 不抛错', () => {
		expect(() => renderItem({ c: withReplies(null) })).not.toThrow();
	});
});

describe('CommentItem —— 移动端拍平', () => {
	it('移动端把嵌套回复拍平，并标注"回复 <父作者>"', () => {
		const restore = stubMatchMedia(true);
		try {
			const { container } = renderItem({
				c: makeComment({
					id: 1,
					author: 'Alice',
					replies: [makeComment({ id: 2, author: 'R1' }), makeComment({ id: 3, author: 'R2' })],
				}),
			});
			expect(container.textContent).toContain('回复');
			// 拍平后的子评论带父评论锚点
			const anchor = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '#comment-1');
			expect(anchor?.textContent.trim()).toBe('Alice');
		} finally {
			restore();
		}
	});

	it('移动端默认只显示一条拍平回复，其余折叠', () => {
		const restore = stubMatchMedia(true);
		try {
			const { container } = renderItem({
				c: makeComment({
					replies: [
						makeComment({ id: 2, author: 'R1' }),
						makeComment({ id: 3, author: 'R2' }),
						makeComment({ id: 4, author: 'R3' }),
					],
				}),
			});
			expect(container.querySelector('#comment-2')).toBeTruthy();
			expect(container.querySelector('#comment-3')).toBeNull();
			expect(container.textContent).toContain('查看剩余回复');
		} finally {
			restore();
		}
	});

	it('移动端点击展开后可见全部拍平回复', async () => {
		const restore = stubMatchMedia(true);
		try {
			const { container } = renderItem({
				c: makeComment({
					replies: [makeComment({ id: 2, author: 'R1' }), makeComment({ id: 3, author: 'R2' })],
				}),
			});
			await fireEvent.click(findButton(container, '查看剩余回复'));
			expect(container.querySelector('#comment-3')).toBeTruthy();
		} finally {
			restore();
		}
	});

	it('拍平后的回复按发布时间升序排列', () => {
		const restore = stubMatchMedia(true);
		try {
			const { container } = renderItem({
				c: makeComment({
					replies: [
						makeComment({ id: 2, author: 'Later', pubDate: 1730000200000 }),
						makeComment({ id: 3, author: 'Earlier', pubDate: 1730000100000 }),
					],
				}),
			});
			// 默认只显示第一条（时间最早的那条）
			expect(container.querySelector('#comment-3')).toBeTruthy();
			expect(container.querySelector('#comment-2')).toBeNull();
		} finally {
			restore();
		}
	});

	it('depth !== 0 时不会再拍平（避免重复渲染）', () => {
		const restore = stubMatchMedia(true);
		try {
			const { container } = renderItem({
				c: makeComment({ replies: [makeComment({ id: 2, author: 'R1' })] }),
				depth: 1,
			});
			expect(container.querySelector('#comment-2')).toBeNull();
		} finally {
			restore();
		}
	});

	it('媒体查询变化时实时切换到拍平布局（change 监听生效）', async () => {
		const media = stubMatchMedia(false);
		try {
			const { container } = renderItem({
				c: makeComment({ id: 1, replies: [makeComment({ id: 2, author: 'R1' })] }),
			});
			// 桌面端：子评论是嵌套渲染，没有"回复 <父作者>"锚点
			expect(container.querySelector('a[href="#comment-1"]')).toBeNull();

			media.change(true);
			await tick();

			// 移动端：拍平后出现指向父评论的锚点
			expect(container.querySelector('a[href="#comment-1"]')?.textContent.trim()).toBe('Alice');
		} finally {
			media();
		}
	});

	it('组件销毁时会移除媒体查询监听器', () => {
		const media = stubMatchMedia(false);
		try {
			const { unmount } = renderItem();
			expect(media.listenerCount()).toBe(1);
			unmount();
			expect(media.listenerCount()).toBe(0);
		} finally {
			media();
		}
	});
});

describe('CommentItem —— 拍平后的父评论锚点跳转', () => {
	it('isFlattened + parentAuthorName 时渲染"回复 <作者>"锚点', () => {
		const { container } = renderItem({ isFlattened: true, parentAuthorName: 'Papa', parentCommentId: 99 });
		const anchor = container.querySelector('a[href="#comment-99"]');
		expect(anchor?.textContent.trim()).toBe('Papa');
	});

	it('只有 isFlattened 但缺少父作者名时不渲染锚点', () => {
		const { container } = renderItem({ isFlattened: true, parentCommentId: 99 });
		expect(container.querySelector('a[href="#comment-99"]')).toBeNull();
	});

	it('点击锚点给目标评论加上 highlight-flash 高亮类', async () => {
		const target = document.createElement('div');
		target.id = 'comment-99';
		document.body.appendChild(target);
		try {
			const { container } = renderItem({ isFlattened: true, parentAuthorName: 'Papa', parentCommentId: 99 });
			await fireEvent.click(container.querySelector('a[href="#comment-99"]'));
			expect(target.classList.contains('highlight-flash')).toBe(true);
		} finally {
			target.remove();
		}
	});

	it('目标评论不存在时点击不抛错', async () => {
		const { container } = renderItem({ isFlattened: true, parentAuthorName: 'Papa', parentCommentId: 123456 });
		await expect(fireEvent.click(container.querySelector('a[href="#comment-123456"]'))).resolves.not.toThrow();
	});
});

describe('CommentItem —— 管理员密钥输入', () => {
	it('adminCommentKeyConfigured + 邮箱哈希匹配时显示密钥输入框', async () => {
		const hash = await sha256HexOf('a@b.com');
		const { container } = renderItem({
			replyingToId: 1,
			email: 'a@b.com',
			adminCommentKeyConfigured: true,
			adminEmailHash: hash,
		});
		await waitFor(() => expect(container.querySelector('#reply-admin-key-1')).toBeTruthy());
	});

	it('邮箱大小写/前后空格被归一化后仍能匹配哈希', async () => {
		const hash = await sha256HexOf('a@b.com');
		const { container } = renderItem({
			replyingToId: 1,
			email: '  A@B.com  ',
			adminCommentKeyConfigured: true,
			adminEmailHash: hash,
		});
		await waitFor(() => expect(container.querySelector('#reply-admin-key-1')).toBeTruthy());
	});

	it('哈希不匹配时不显示密钥输入框', async () => {
		const hash = await sha256HexOf('other@example.com');
		const { container } = renderItem({
			replyingToId: 1,
			email: 'a@b.com',
			adminCommentKeyConfigured: true,
			adminEmailHash: hash,
		});
		await tick();
		expect(container.querySelector('#reply-admin-key-1')).toBeNull();
	});

	it('adminCommentKeyConfigured=false 时不显示密钥输入框', async () => {
		const hash = await sha256HexOf('a@b.com');
		const { container } = renderItem({
			replyingToId: 1,
			email: 'a@b.com',
			adminCommentKeyConfigured: false,
			adminEmailHash: hash,
		});
		await tick();
		expect(container.querySelector('#reply-admin-key-1')).toBeNull();
	});

	it('填写密钥后随 submit 一起派发 admin_key', async () => {
		const hash = await sha256HexOf('a@b.com');
		const details = [];
		const { container, rerender } = renderItem(
			{ author: 'Admin', email: 'a@b.com', adminCommentKeyConfigured: true, adminEmailHash: hash },
			{ submit: (e) => details.push(e.detail) }
		);
		// 走真实流程：点回复（用用户信息预填昵称/邮箱）-> 父组件打开表单
		await fireEvent.click(findButton(container, '回复'));
		await rerender({ replyingToId: 1 });
		await waitFor(() => expect(container.querySelector('#reply-admin-key-1')).toBeTruthy());
		await fireEvent.input(container.querySelector('#reply-admin-key-1'), { target: { value: 's3cret' } });
		await fireEvent.input(container.querySelector('textarea'), { target: { value: 'hi' } });
		await fireEvent.click(container.querySelector('button[type=submit]'));

		expect(details.length).toBe(1);
		expect(details[0].admin_key).toBe('s3cret');
		expect(details[0]).toMatchObject({ author: 'Admin', email: 'a@b.com', content: 'hi' });
	});
});

describe('CommentItem —— 子级事件透传（桌面与移动端两条分支）', () => {
	/** 填好某个回复表单并提交 */
	async function fillAndSubmit(container, id, content = '子级回复') {
		await fireEvent.input(container.querySelector(`#reply-author-${id}`), { target: { value: 'R' } });
		await fireEvent.input(container.querySelector(`#reply-email-${id}`), { target: { value: 'r@example.com' } });
		await fireEvent.input(
			[...container.querySelectorAll('textarea')].find((t) => t.closest('form').querySelector(`#reply-author-${id}`)),
			{ target: { value: content } }
		);
		await fireEvent.click(
			[...container.querySelectorAll('button[type=submit]')].find((b) => b.closest('form').querySelector(`#reply-author-${id}`))
		);
	}

	it('桌面端：子评论的回复表单提交会向上透传 submit', async () => {
		const details = [];
		const { container } = renderItem(
			{ c: makeComment({ id: 1, replies: [makeComment({ id: 2, author: 'R1' })] }), replyingToId: 2 },
			{ submit: (e) => details.push(e.detail) }
		);
		await waitFor(() => expect(container.querySelector('#reply-author-2')).toBeTruthy());
		await fillAndSubmit(container, 2);
		expect(details.length).toBe(1);
		expect(details[0].parentId).toBe(2);
	});

	it('桌面端：子评论面板的取消事件会向上透传 cancel', async () => {
		const cancel = vi.fn();
		const { container } = renderItem(
			{ c: makeComment({ id: 1, replies: [makeComment({ id: 2 })] }), replyingToId: 2 },
			{ cancel }
		);
		await waitFor(() => expect(container.querySelector('#reply-author-2')).toBeTruthy());
		await fireEvent.click(findButton(container, '取消'));
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it('桌面端：子评论面板的用户信息变更会向上透传 userInfoChange', async () => {
		const details = [];
		const { container } = renderItem(
			{ c: makeComment({ id: 1, replies: [makeComment({ id: 2 })] }), replyingToId: 2 },
			{ userInfoChange: (e) => details.push(e.detail) }
		);
		await waitFor(() => expect(container.querySelector('#reply-author-2')).toBeTruthy());
		await fireEvent.input(container.querySelector('#reply-author-2'), { target: { value: 'Nested' } });
		expect(details.at(-1)?.author).toBe('Nested');
	});

	it('桌面端：子评论的回复按钮事件会向上透传 reply', async () => {
		const details = [];
		const { container } = renderItem(
			{ c: makeComment({ id: 1, replies: [makeComment({ id: 2, author: 'R1' })] }) },
			{ reply: (e) => details.push(e.detail) }
		);
		// 顶层与子级各有一个"回复"按钮，取最后一个（子级）
		await fireEvent.click([...container.querySelectorAll('button')].filter((b) => b.textContent.trim() === '回复').at(-1));
		expect(details).toEqual([2]);
	});

	it('移动端拍平：子评论的回复表单提交同样会透传 submit', async () => {
		const restore = stubMatchMedia(true);
		try {
			const details = [];
			const { container } = renderItem(
				{ c: makeComment({ id: 1, replies: [makeComment({ id: 2, author: 'R1' })] }), replyingToId: 2 },
				{ submit: (e) => details.push(e.detail) }
			);
			await waitFor(() => expect(container.querySelector('#reply-author-2')).toBeTruthy());
			await fillAndSubmit(container, 2, '移动端回复');
			expect(details.length).toBe(1);
			expect(details[0]).toMatchObject({ parentId: 2, content: '移动端回复' });
		} finally {
			restore();
		}
	});

	it('移动端拍平：子评论的 reply / cancel 事件也会透传', async () => {
		const restore = stubMatchMedia(true);
		try {
			const reply = vi.fn();
			const cancel = vi.fn();
			const { container, rerender } = renderItem(
				{ c: makeComment({ id: 1, replies: [makeComment({ id: 2, author: 'R1' })] }) },
				{ reply, cancel }
			);
			await fireEvent.click([...container.querySelectorAll('button')].filter((b) => b.textContent.trim() === '回复').at(-1));
			expect(reply.mock.calls[0][0].detail).toBe(2);

			await rerender({ replyingToId: 2 });
			await fireEvent.click(findButton(container, '取消'));
			expect(cancel).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});
});

describe('CommentItem —— 语言切换的响应性（记录现状）', () => {
	it('rerender 修改 language 后：日期会跟着切换，但 i18n 文案不会', async () => {
		const { container, rerender } = renderItem({ c: makeComment({ pubDate: 1730000000000 }), language: 'zh-cn' });
		expect(container.textContent).toContain('2024 年 10 月 27 日');
		expect(findButton(container, '回复')).toBeTruthy();

		await rerender({ language: 'en' });

		// 日期是模板里直接调用 formatFullDate(..., language)，因此会更新
		expect(container.textContent).toContain('Oct 27, 2024');
		// 但 t 是 const t = i18nit(language) 只在初始化执行一次，文案仍是中文
		expect(findButton(container, '回复')).toBeTruthy();
		expect(findButton(container, 'Reply')).toBeUndefined();
	});
});
