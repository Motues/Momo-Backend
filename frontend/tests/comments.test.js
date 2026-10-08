import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import Comments from '../src/comment/Comments.svelte';
import { makeComment, jsonResponse, stubAlert, findButton, sha256HexOf, patchHappyDomAnimation } from './helpers';

beforeAll(patchHappyDomAnimation);

const POST_SLUG = '/posts/demo';
const API_URL = 'https://api.example.com';

/** 默认 props */
function renderComments(props = {}) {
	return render(Comments, {
		props: { postSlug: POST_SLUG, apiUrl: API_URL, postTitle: '演示文章', ...props },
	});
}

/** 评论列表接口的响应体 */
function listBody(comments = [], extra = {}) {
	return { data: { comments, pagination: { totalPage: 1 }, ...extra } };
}

/** 主输入表单（DOM 中第一个 form，评论列表里的回复表单在其后） */
const mainForm = (container) => container.querySelector('form');
/** 主内容输入框（第一个 textarea） */
const mainTextarea = (container) => container.querySelector('textarea');
/** 底部「发送」按钮 */
const sendButton = (container) => [...container.querySelectorAll('button[type=submit]')][0];

/** 填好主表单并提交 */
async function submitMainForm(container, { author = 'Me', email = 'me@example.com', url = '', content = '你好' } = {}) {
	if (author !== null) await fireEvent.input(container.querySelector('#author'), { target: { value: author } });
	if (email !== null) await fireEvent.input(container.querySelector('#email'), { target: { value: email } });
	if (url) await fireEvent.input(container.querySelector('#url'), { target: { value: url } });
	await fireEvent.input(mainTextarea(container), { target: { value: content } });
	await fireEvent.submit(mainForm(container));
}

/** 记录所有 fetch 调用的替身 */
function fetchMock(handler) {
	const calls = [];
	const mock = vi.fn(async (url, init) => {
		calls.push({ url, init, method: init?.method ?? 'GET' });
		return handler(url, init, calls.length);
	});
	mock.calls = calls;
	vi.stubGlobal('fetch', mock);
	return mock;
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	cleanup();
});

describe('Comments —— 初始加载', () => {
	it('挂载后立即请求第 1 页，URL 参数完整且 post_slug 被编码', async () => {
		const fetch = fetchMock(async () => jsonResponse(listBody([makeComment()])));
		renderComments({ postSlug: '/posts/中文 slug' });
		await waitFor(() => expect(fetch.calls.length).toBe(1));
		expect(fetch.calls[0].url).toBe(
			`${API_URL}/api/comments?post_slug=${encodeURIComponent('/posts/中文 slug')}&nested=true&page=1&limit=20`
		);
		expect(fetch.calls[0].method).toBe('GET');
	});

	it('请求返回前显示加载中提示', () => {
		fetchMock(() => new Promise(() => {}));
		const { container } = renderComments();
		expect(container.textContent).toContain('正在加载评论...');
	});

	it('加载成功后显示评论总数与内容', async () => {
		fetchMock(async () => jsonResponse(listBody([makeComment({ author: 'Alice' })])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));
		expect(container.textContent).toContain('Alice');
	});

	it('嵌套回复会被计入总数', async () => {
		fetchMock(async () =>
			jsonResponse(
				listBody([
					makeComment({
						id: 1,
						replies: [makeComment({ id: 2, replies: [makeComment({ id: 3 })] })],
					}),
				])
			)
		);
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('3 条评论'));
	});

	it('空列表显示 0 条评论', async () => {
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
	});

	it('data.comments 缺失时按空列表处理', async () => {
		fetchMock(async () => jsonResponse({ data: {} }));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
	});

	it('响应体没有 data 字段时不抛错', async () => {
		fetchMock(async () => jsonResponse({}));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
	});

	it('列表为空时没有"加载更多"按钮', async () => {
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		expect(container.textContent).not.toContain('加载更多');
	});

	it('totalPage 大于当前页时显示"加载更多"', async () => {
		fetchMock(async () => jsonResponse({ data: { comments: [makeComment()], pagination: { totalPage: 3 } } }));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('加载更多'));
	});

	it('totalPage 为 0/缺失/字符串时不显示加载更多', async () => {
		for (const pagination of [{ totalPage: 0 }, {}, { totalPage: null }]) {
			fetchMock(async () => jsonResponse({ data: { comments: [makeComment()], pagination } }));
			const { container } = renderComments();
			await waitFor(() => expect(container.textContent).toContain('1 条评论'));
			expect(container.textContent, JSON.stringify(pagination)).not.toContain('加载更多');
			cleanup();
		}
	});
});

describe('Comments —— 加载失败处理', () => {
	it('HTTP 非 2xx 时显示状态码', async () => {
		fetchMock(async () => jsonResponse({}, { ok: false, status: 500 }));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('加载失败'));
		expect(container.textContent).toContain('HTTP 500');
	});

	it('404 同样进入错误态', async () => {
		fetchMock(async () => jsonResponse({}, { ok: false, status: 404 }));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('HTTP 404'));
	});

	it('fetch 抛错时展示异常消息', async () => {
		fetchMock(async () => {
			throw new Error('network down');
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('network down'));
	});

	it('错误态下不再渲染评论列表（"加载失败"与文案之间没有分隔符，见最终报告）', async () => {
		fetchMock(async () => jsonResponse({}, { ok: false, status: 500 }));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('加载失败'));
		expect(container.textContent).toContain('加载失败HTTP 500');
		expect(container.textContent).not.toContain('条评论');
	});

	it('加载失败后提交评论成功会重新加载并清除错误态', async () => {
		let fail = true;
		stubAlert();
		fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
			if (fail) throw new Error('network down');
			return jsonResponse(listBody([makeComment()]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('network down'));

		fail = false;
		await submitMainForm(container);
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));
		expect(container.textContent).not.toContain('network down');
	});

	it('JSON 解析失败（响应体损坏）时不抛错', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => {
					throw new Error('bad json');
				},
			}))
		);
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('bad json'));
	});
});

describe('Comments —— 加载更多', () => {
	it('点击后请求 page=2 并追加到列表尾部', async () => {
		const fetch = fetchMock(async (url) => {
			const page = new URL(url).searchParams.get('page');
			return jsonResponse({
				data: {
					comments: [makeComment({ id: Number(page), author: `第${page}页` })],
					pagination: { totalPage: 2 },
				},
			});
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));

		await fireEvent.click(findButton(container, '加载更多'));
		await waitFor(() => expect(container.textContent).toContain('2 条评论'));
		expect(fetch.calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2']);
		expect(container.textContent).toContain('第1页');
		expect(container.textContent).toContain('第2页');
	});

	it('到达最后一页后按钮消失', async () => {
		fetchMock(async () => jsonResponse({ data: { comments: [makeComment()], pagination: { totalPage: 2 } } }));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('加载更多'));
		await fireEvent.click(findButton(container, '加载更多'));
		await waitFor(() => expect(container.textContent).toContain('2 条评论'));
		expect(container.textContent).not.toContain('加载更多');
	});

	it('"加载更多"失败：页码不推进，错误态会顶掉整个列表（记录现状）', async () => {
		let calls = 0;
		fetchMock(async () => {
			calls++;
			if (calls === 1) throw new Error('boom-1');
			if (calls === 2) return jsonResponse({ data: { comments: [makeComment()], pagination: { totalPage: 2 } } });
			throw new Error('page2-failed');
		});
		const { container } = renderComments();
		// 首次失败 -> 错误态；随后成功一次恢复列表
		await waitFor(() => expect(container.textContent).toContain('boom-1'));

		cleanup();
		calls = 1;
		const second = renderComments();
		await waitFor(() => expect(second.container.textContent).toContain('1 条评论'));
		await fireEvent.click(findButton(second.container, '加载更多'));
		await waitFor(() => expect(second.container.textContent).toContain('page2-failed'));
		// 现状：加载更多失败会把已渲染的列表整体替换成错误提示
		expect(second.container.textContent).not.toContain('条评论');
	});
});

describe('Comments —— 多语言文案', () => {
	it('language="en" 时表单与列表文案为英文', async () => {
		fetchMock(async () => jsonResponse(listBody([makeComment()], { pagination: { totalPage: 2 } })));
		const { container } = renderComments({ language: 'en' });
		await waitFor(() => expect(container.textContent).toContain('1 Comments'));
		expect(container.textContent).toContain('Name');
		expect(container.textContent).toContain('Email');
		expect(container.textContent).toContain('Send');
		expect(container.textContent).toContain('Load more');
	});

	it('language="en" 时加载中提示为英文', () => {
		fetchMock(() => new Promise(() => {}));
		const { container } = renderComments({ language: 'en' });
		expect(container.textContent).toContain('Loading comments...');
	});

	it('language="en" 时错误提示为英文', async () => {
		fetchMock(async () => jsonResponse({}, { ok: false, status: 500 }));
		const { container } = renderComments({ language: 'en' });
		await waitFor(() => expect(container.textContent).toContain('Failed to load'));
	});

	it('未知语言回退到中文文案', async () => {
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments({ language: 'fr' });
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
	});

	it('rerender 切换 language 不会改变 i18n 文案（t 在初始化时固定，见最终报告）', async () => {
		fetchMock(async () => jsonResponse(listBody([makeComment()])));
		const { container, rerender } = renderComments({ language: 'zh-cn' });
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));
		await rerender({ language: 'en' });
		// 记录现状：静态文案不会跟着 language 走（日期等模板内直接使用 language 的部分会变）
		expect(container.textContent).toContain('1 条评论');
		expect(container.textContent).toContain('发送');
	});
});

describe('Comments —— 后端下发的展示配置', () => {
	it('placeholder_* 会作为输入框占位符', async () => {
		fetchMock(async () =>
			jsonResponse(
				listBody([], {
					placeholder_name: '你的昵称',
					placeholder_email: 'you@example.com',
					placeholder_content: '说点什么',
					placeholder_url: 'https://your.site',
				})
			)
		);
		const { container } = renderComments();
		await waitFor(() => expect(container.querySelector('#author').placeholder).toBe('你的昵称'));
		expect(container.querySelector('#email').placeholder).toBe('you@example.com');
		expect(mainTextarea(container).placeholder).toBe('说点什么');
		expect(container.querySelector('#url').placeholder).toBe('https://your.site');
	});

	it('placeholder 缺失时回退到默认文案', async () => {
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.querySelector('#author').placeholder).toBe('必填'));
		expect(mainTextarea(container).placeholder).toBe('欢迎评论');
	});

	it('blogger_badge_enabled="true"（字符串）时启用博主徽章', async () => {
		fetchMock(async () =>
			jsonResponse(listBody([makeComment({ isBlogger: true })], { blogger_badge_enabled: 'true', blogger_badge_text: '博主' }))
		);
		const { container } = renderComments();
		await waitFor(() => expect(container.querySelector('.blogger-badge')).toBeTruthy());
		expect(container.querySelector('.blogger-badge').textContent).toBe('博主');
	});

	it('blogger_badge_enabled 为布尔 true 时不启用（只认字符串，记录现状）', async () => {
		fetchMock(async () =>
			jsonResponse(listBody([makeComment({ isBlogger: true })], { blogger_badge_enabled: true, blogger_badge_text: '博主' }))
		);
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));
		expect(container.querySelector('.blogger-badge')).toBeNull();
	});

	it('admin_comment_key_configured="true" 且邮箱哈希匹配时显示管理员密钥输入框', async () => {
		const hash = await sha256HexOf('admin@example.com');
		fetchMock(async () =>
			jsonResponse(listBody([], { admin_comment_key_configured: 'true', admin_email_hash: hash }))
		);
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		expect(container.querySelector('#admin-key')).toBeNull();
		await fireEvent.input(container.querySelector('#email'), { target: { value: 'ADMIN@example.com' } });
		await waitFor(() => expect(container.querySelector('#admin-key')).toBeTruthy());
	});

	it('admin_comment_key_configured="false" 时不显示管理员密钥输入框', async () => {
		const hash = await sha256HexOf('admin@example.com');
		fetchMock(async () =>
			jsonResponse(listBody([], { admin_comment_key_configured: 'false', admin_email_hash: hash }))
		);
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await fireEvent.input(container.querySelector('#email'), { target: { value: 'admin@example.com' } });
		await new Promise((r) => setTimeout(r, 20));
		expect(container.querySelector('#admin-key')).toBeNull();
	});
});

describe('Comments —— 提交评论', () => {
	it('POST 请求体字段完整且为 snake_case', async () => {
		stubAlert();
		const fetch = fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));

		await submitMainForm(container, { author: 'Me', email: 'me@example.com', url: 'https://me.example.com', content: '你好' });
		await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST')));

		const post = fetch.calls.find((c) => c.method === 'POST');
		expect(post.url).toBe(`${API_URL}/api/comments`);
		expect(post.init.headers['Content-Type']).toBe('application/json');
		const body = JSON.parse(post.init.body);
		expect(body).toEqual({
			post_slug: POST_SLUG,
			author: 'Me',
			email: 'me@example.com',
			url: 'https://me.example.com',
			content: '你好',
			parent_id: null,
			post_url: window.location.href,
			post_title: '演示文章',
		});
	});

	it('未填 URL 时 url 为 null', async () => {
		stubAlert();
		const fetch = fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await submitMainForm(container, { url: '' });
		await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST')));
		const body = JSON.parse(fetch.calls.find((c) => c.method === 'POST').init.body);
		expect(body.url).toBeNull();
	});

	it('提交成功后清空输入框并清除草稿、保存用户信息', async () => {
		const alertSpy = stubAlert();
		fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await submitMainForm(container);
		await waitFor(() => expect(alertSpy).toHaveBeenCalled());

		expect(mainTextarea(container).value).toBe('');
		expect(localStorage.getItem('momo_comment_draft')).toBeNull();
		expect(JSON.parse(localStorage.getItem('momo_comment_user_info'))).toEqual({
			author: 'Me',
			email: 'me@example.com',
			url: '',
		});
	});

	it('提交成功后使用后端返回的 message 弹提示', async () => {
		const alertSpy = stubAlert();
		fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: '评论已提交' });
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await submitMainForm(container);
		await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('评论已提交'));
	});

	it('后端提示需要邮箱认证时拼接提醒文案', async () => {
		const alertSpy = stubAlert();
		fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'Verification email sent' });
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await submitMainForm(container);
		await waitFor(() => expect(alertSpy).toHaveBeenCalled());
		expect(alertSpy.mock.calls[0][0]).toBe('提交成功 邮箱需要认证，请查收验证邮件');
	});

	it('缺少昵称/邮箱/内容时不发请求并提示', async () => {
		const alertSpy = stubAlert();
		const fetch = fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));

		await fireEvent.submit(mainForm(container));
		expect(alertSpy).toHaveBeenCalledWith('请填写昵称、邮箱和评论内容');
		expect(fetch.calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('内容超过限制时（绕过按钮禁用直接提交）不发请求并提示', async () => {
		const alertSpy = stubAlert();
		const fetch = fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));

		await submitMainForm(container, { content: 'x'.repeat(2001) });
		expect(alertSpy).toHaveBeenCalledWith('评论内容超出限制：不超过2000字或1000单词');
		expect(fetch.calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('内容超过限制时显示红色提示且发送按钮禁用', async () => {
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await fireEvent.input(mainTextarea(container), { target: { value: 'x'.repeat(2001) } });
		expect(container.textContent).toContain('内容超出限制');
		expect(sendButton(container).disabled).toBe(true);
	});

	it('提交失败时保留已输入内容并提示后端消息', async () => {
		const alertSpy = stubAlert();
		fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 500, message: '服务器错误' }, { ok: false, status: 500 });
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await submitMainForm(container, { content: '别丢了我' });
		await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('服务器错误'));
		expect(mainTextarea(container).value).toBe('别丢了我');
	});

	it('HTTP 200 但 code 非 200 时视为失败', async () => {
		const alertSpy = stubAlert();
		fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 1001, message: '参数错误' });
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await submitMainForm(container, { content: '内容保留' });
		await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('参数错误'));
		expect(mainTextarea(container).value).toBe('内容保留');
	});

	it('响应体不是 JSON 时按 HTTP 状态判断为成功', async () => {
		const alertSpy = stubAlert();
		fetchMock(async (url, init) => {
			if (init?.method === 'POST') {
				return {
					ok: true,
					status: 200,
					json: async () => {
						throw new Error('bad json');
					},
				};
			}
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await submitMainForm(container);
		await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('提交成功'));
		expect(mainTextarea(container).value).toBe('');
	});

	it('提交期间再次提交不会重复发送（submitting 保护）', async () => {
		stubAlert();
		let resolvePost;
		const fetch = fetchMock(async (url, init) => {
			if (init?.method === 'POST') {
				return new Promise((resolve) => {
					resolvePost = () => resolve(jsonResponse({ code: 200, message: 'ok' }));
				});
			}
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await submitMainForm(container);
		expect(sendButton(container).disabled).toBe(true);
		await fireEvent.submit(mainForm(container));
		expect(fetch.calls.filter((c) => c.method === 'POST').length).toBe(1);
		resolvePost();
	});

	it('提交请求抛错（网络异常）时提示提交失败', async () => {
		const alertSpy = stubAlert();
		fetchMock(async (url, init) => {
			if (init?.method === 'POST') throw new Error('network down');
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await submitMainForm(container);
		await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('提交失败，请稍后再试'));
	});

	it('提交成功后重新拉取第 1 页', async () => {
		stubAlert();
		const fetch = fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
			return jsonResponse(listBody([makeComment()]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));
		await submitMainForm(container);
		await waitFor(() => expect(fetch.calls.filter((c) => c.method === 'GET').length).toBe(2));
		expect(new URL(fetch.calls.at(-1).url).searchParams.get('page')).toBe('1');
	});
});

describe('Comments —— 人机验证（SilentVerify 集成）', () => {
	const challengeDisabled = async (url) => {
		if (url.includes('/api/verify/challenge')) return jsonResponse({ data: { enabled: false } });
		return jsonResponse(listBody([], { verify_enabled: 'true', verify_honeypot: 'hp_field' }));
	};

	it('verify_enabled="true" 时渲染验证框与蜜罐字段', async () => {
		fetchMock(challengeDisabled);
		const { container } = renderComments();
		await waitFor(() => expect(container.querySelector('.verify-box')).toBeTruthy());
		await waitFor(() => expect(container.querySelector('input.verify-honeypot')).toBeTruthy());
		expect(container.querySelector('input.verify-honeypot').getAttribute('name')).toBe('hp_field');
	});

	it('verify_enabled="false" 时不渲染验证框', async () => {
		fetchMock(async () => jsonResponse(listBody([], { verify_enabled: 'false' })));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		expect(container.querySelector('.verify-box')).toBeNull();
	});

	it('verify_enabled 为布尔 true 时同样启用（Boolean 走 parseBool）', async () => {
		fetchMock(async (url) =>
			url.includes('/api/verify/challenge')
				? jsonResponse({ data: { enabled: false } })
				: jsonResponse(listBody([], { verify_enabled: true }))
		);
		const { container } = renderComments();
		await waitFor(() => expect(container.querySelector('.verify-box')).toBeTruthy());
	});

	it('验证挑战返回 enabled:false 时发送按钮仍然被禁用（记录现状：票据 "" 是假值）', async () => {
		fetchMock(challengeDisabled);
		const { container } = renderComments();
		await waitFor(() => expect(container.querySelector('.verify-box')).toBeTruthy());
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		// SilentVerify 通过 onTicket('') 表示「后端已关闭验证，放行」，
		// 但模板里的 !verifyTicket 把 '' 当成未通过，导致按钮永远禁用
		await new Promise((r) => setTimeout(r, 50));
		expect(sendButton(container).disabled).toBe(true);
	});

	it('拿到票据后发送按钮可用，且提交时携带 verify_ticket', async () => {
		const alertSpy = stubAlert();
		const fetch = fetchMock(async (url, init) => {
			if (url.includes('/api/verify/challenge')) {
				return jsonResponse({ data: { enabled: true, prefix: 'pfx', sig: 'sig', difficulty: 1 } });
			}
			if (url.includes('/api/verify/solution')) return jsonResponse({ data: { ticket: 'TICKET-1' } });
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
			return jsonResponse(listBody([], { verify_enabled: 'true' }));
		});
		const { container } = renderComments();
		// SilentVerify 会在提交解之前等待 320ms 的「人类耗时」阈值
		await waitFor(() => expect(fetch.calls.some((c) => c.url.includes('/api/verify/solution'))), { timeout: 3000 });
		await waitFor(() => expect(container.textContent).toContain('验证成功'), { timeout: 3000 });
		// 有票据后，填了内容的发送按钮才应可用
		await fireEvent.input(mainTextarea(container), { target: { value: '内容' } });
		expect(sendButton(container).disabled).toBe(false);

		await submitMainForm(container, { content: '内容' });
		await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/comments'))));
		const post = fetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/comments'));
		expect(JSON.parse(post.init.body).verify_ticket).toBe('TICKET-1');
		expect(alertSpy).toHaveBeenCalled();
	}, 15000);

	it('403 VERIFY_REQUIRED 时提示重试、保留内容且不重新加载列表', async () => {
		const alertSpy = stubAlert();
		const fetch = fetchMock(async (url, init) => {
			if (init?.method === 'POST') {
				return jsonResponse({ reason: 'VERIFY_REQUIRED' }, { ok: false, status: 403 });
			}
			return jsonResponse(listBody([]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await submitMainForm(container, { content: '保留我' });
		await waitFor(() => expect(alertSpy).toHaveBeenCalled());
		expect(alertSpy.mock.calls[0][0]).toBe('验证失败，点击重试');
		expect(mainTextarea(container).value).toBe('保留我');
		expect(fetch.calls.filter((c) => c.method === 'GET').length).toBe(1);
	});

	it('403 VERIFY_REQUIRED 且验证框存在时会重新发起挑战', async () => {
		stubAlert();
		let challenges = 0;
		fetchMock(async (url, init) => {
			if (url.includes('/api/verify/challenge')) {
				challenges++;
				return jsonResponse({ data: { enabled: false } });
			}
			if (init?.method === 'POST') return jsonResponse({ code: 'VERIFY_REQUIRED' }, { ok: false, status: 403 });
			return jsonResponse(listBody([], { verify_enabled: 'true' }));
		});
		const { container } = renderComments();
		await waitFor(() => expect(challenges).toBe(1));
		await submitMainForm(container);
		await waitFor(() => expect(challenges).toBe(2));
	}, 15000);
});

describe('Comments —— 本地存储', () => {
	it('从 localStorage 恢复用户信息与草稿', async () => {
		localStorage.setItem(
			'momo_comment_user_info',
			JSON.stringify({ author: 'Stored', email: 's@example.com', url: 'https://s.example.com' })
		);
		localStorage.setItem('momo_comment_draft', '未完成的草稿');
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));

		expect(container.querySelector('#author').value).toBe('Stored');
		expect(container.querySelector('#email').value).toBe('s@example.com');
		expect(container.querySelector('#url').value).toBe('https://s.example.com');
		expect(mainTextarea(container).value).toBe('未完成的草稿');
	});

	it('用户信息 JSON 损坏时忽略并告警，不抛错', async () => {
		localStorage.setItem('momo_comment_user_info', '{不是 JSON');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		expect(container.querySelector('#author').value).toBe('');
		expect(warn.mock.calls.map((c) => c[0])).toContain('Failed to load user info from localStorage:');
	});

	it('用户信息字段缺失时按空串处理', async () => {
		localStorage.setItem('momo_comment_user_info', JSON.stringify({ author: 'OnlyName' }));
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		expect(container.querySelector('#author').value).toBe('OnlyName');
		expect(container.querySelector('#email').value).toBe('');
	});

	it('localStorage 写入被禁用（隐私模式）时不中断，提交仍能清空输入框', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stubAlert();
		// 注意：happy-dom 的 localStorage 是代理对象，方法并不来自 Storage.prototype，
		// 因此必须在实例上打桩（打 Storage.prototype 不会生效）
		const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new Error('storage denied');
		});
		try {
			fetchMock(async (url, init) => {
				if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
				return jsonResponse(listBody([]));
			});
			const { container } = renderComments();
			await waitFor(() => expect(container.textContent).toContain('0 条评论'));
			await submitMainForm(container, { content: '要清空的内容' });
			await waitFor(() => expect(container.querySelector('textarea').value).toBe(''));
			expect(warn.mock.calls.map((c) => c[0])).toContain('Failed to persist comment draft:');
			expect(warn.mock.calls.map((c) => c[0])).toContain('Failed to save user info to localStorage:');
		} finally {
			spy.mockRestore();
		}
	});
});

describe('Comments —— 预览', () => {
	it('空内容时预览按钮禁用', async () => {
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		expect(findButton(container, '预览').disabled).toBe(true);
	});

	it('点击预览渲染 Markdown 并清理 HTML', async () => {
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await fireEvent.input(mainTextarea(container), { target: { value: '# 标题\n\n<script>bad()</script>' } });
		await fireEvent.click(findButton(container, '预览'));
		expect(container.querySelector('.markdown-preview h1')?.textContent).toBe('标题');
		expect(container.querySelector('.markdown-preview script')).toBeNull();
		expect(findButton(container, '编辑')).toBeTruthy();
	});

	it('预览时显示 Markdown 未闭合告警', async () => {
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await fireEvent.input(mainTextarea(container), { target: { value: '```\n未闭合' } });
		await fireEvent.click(findButton(container, '预览'));
		expect(container.textContent).toContain('代码块标记 ``` 未闭合');
	});

	it('切回编辑模式后内容保留', async () => {
		fetchMock(async () => jsonResponse(listBody([])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('0 条评论'));
		await fireEvent.input(mainTextarea(container), { target: { value: '内容' } });
		await fireEvent.click(findButton(container, '预览'));
		await fireEvent.click(findButton(container, '编辑'));
		expect(mainTextarea(container).value).toBe('内容');
	});
});

describe('Comments —— 回复评论', () => {
	it('点击某条评论的回复按钮后出现回复表单，并预填用户信息', async () => {
		fetchMock(async () => jsonResponse(listBody([makeComment({ id: 5 })])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));

		await fireEvent.input(container.querySelector('#author'), { target: { value: 'Me' } });
		await fireEvent.input(container.querySelector('#email'), { target: { value: 'me@example.com' } });
		await fireEvent.input(container.querySelector('#url'), { target: { value: 'https://me.example.com' } });

		await fireEvent.click(findButton(container, '回复'));
		await waitFor(() => expect(container.querySelector('#reply-author-5')).toBeTruthy());
		expect(container.querySelector('#reply-author-5').value).toBe('Me');
		expect(container.querySelector('#reply-email-5').value).toBe('me@example.com');
		expect(container.querySelector('#reply-url-5').value).toBe('https://me.example.com');
	});

	it('提交回复时 parent_id 为目标评论 id', async () => {
		stubAlert();
		const fetch = fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
			return jsonResponse(listBody([makeComment({ id: 5 })]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));
		await fireEvent.click(findButton(container, '回复'));
		await waitFor(() => expect(container.querySelector('form:nth-of-type(2)') ?? container.querySelector('#reply-author-5')).toBeTruthy());

		await fireEvent.input(container.querySelector('#reply-author-5'), { target: { value: 'Replyer' } });
		await fireEvent.input(container.querySelector('#reply-email-5'), { target: { value: 'r@example.com' } });
		const replyTextarea = [...container.querySelectorAll('textarea')].at(-1);
		await fireEvent.input(replyTextarea, { target: { value: '回复内容' } });
		await fireEvent.click([...container.querySelectorAll('button[type=submit]')].at(-1));

		await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST')).toBe(true));
		const body = JSON.parse(fetch.calls.find((c) => c.method === 'POST').init.body);
		expect(body.parent_id).toBe(5);
		expect(body.content).toBe('回复内容');
		expect(body.author).toBe('Replyer');
	});

	it('回复提交成功后关闭回复表单', async () => {
		stubAlert();
		fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
			return jsonResponse(listBody([makeComment({ id: 5 })]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));
		await fireEvent.click(findButton(container, '回复'));
		await waitFor(() => expect(container.querySelector('#reply-author-5')).toBeTruthy());
		await fireEvent.input(container.querySelector('#reply-author-5'), { target: { value: 'R' } });
		await fireEvent.input(container.querySelector('#reply-email-5'), { target: { value: 'r@example.com' } });
		await fireEvent.input([...container.querySelectorAll('textarea')].at(-1), { target: { value: 'hi' } });
		await fireEvent.click([...container.querySelectorAll('button[type=submit]')].at(-1));
		await waitFor(() => expect(container.querySelector('#reply-author-5')).toBeNull());
	});

	it('点击取消关闭回复表单', async () => {
		fetchMock(async () => jsonResponse(listBody([makeComment({ id: 5 })])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));
		await fireEvent.click(findButton(container, '回复'));
		await waitFor(() => expect(container.querySelector('#reply-author-5')).toBeTruthy());
		await fireEvent.click(findButton(container, '取消'));
		await waitFor(() => expect(container.querySelector('#reply-author-5')).toBeNull());
	});

	it('回复表单里修改昵称会同步回主表单并写入 localStorage', async () => {
		fetchMock(async () => jsonResponse(listBody([makeComment({ id: 5 })])));
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));
		await fireEvent.click(findButton(container, '回复'));
		await waitFor(() => expect(container.querySelector('#reply-author-5')).toBeTruthy());
		await fireEvent.input(container.querySelector('#reply-author-5'), { target: { value: '同步过来的昵称' } });
		await waitFor(() => expect(container.querySelector('#author').value).toBe('同步过来的昵称'));
		await waitFor(() =>
			expect(JSON.parse(localStorage.getItem('momo_comment_user_info')).author).toBe('同步过来的昵称')
		);
	});

	it('localStorage 删除被禁用时不中断提交（清空草稿的兜底）', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const alertSpy = stubAlert();
		const spy = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
			throw new Error('remove denied');
		});
		try {
			fetchMock(async (url, init) => {
				if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
				return jsonResponse(listBody([]));
			});
			const { container } = renderComments();
			await waitFor(() => expect(container.textContent).toContain('0 条评论'));
			await submitMainForm(container, { content: '要清空的内容' });
			await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('ok'));
			expect(warn.mock.calls.map((c) => c[0])).toContain('Failed to clear draft from localStorage:');
			expect(container.querySelector('textarea').value).toBe('');
		} finally {
			spy.mockRestore();
		}
	});
});

describe('Comments —— 评论项的子事件透传', () => {
	it('评论项内部的回复表单提交同样会带上 parent_id', async () => {
		stubAlert();
		const fetch = fetchMock(async (url, init) => {
			if (init?.method === 'POST') return jsonResponse({ code: 200, message: 'ok' });
			return jsonResponse(listBody([makeComment({ id: 1 })]));
		});
		const { container } = renderComments();
		await waitFor(() => expect(container.textContent).toContain('1 条评论'));
		await fireEvent.click(findButton(container, '回复'));
		await waitFor(() => expect(container.querySelector('#reply-author-1')).toBeTruthy());
		expect(container.querySelector('#reply-author-1')).toBeTruthy();
		const replyTextarea = [...container.querySelectorAll('textarea')].at(-1);
		await fireEvent.input(container.querySelector('#reply-author-1'), { target: { value: 'A' } });
		await fireEvent.input(container.querySelector('#reply-email-1'), { target: { value: 'a@example.com' } });
		await fireEvent.input(replyTextarea, { target: { value: 'hello' } });
		await fireEvent.click([...container.querySelectorAll('button[type=submit]')].at(-1));
		await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST')).toBe(true));
		expect(JSON.parse(fetch.calls.find((c) => c.method === 'POST').init.body).parent_id).toBe(1);
	});
});
