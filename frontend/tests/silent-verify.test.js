import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { jsonResponse, stubMatchMedia, patchHappyDomAnimation } from './helpers';

beforeAll(patchHappyDomAnimation);

/*
 * 协议 v2 的解题走 HashWX（真挖矿），测试里不可能真算，所以把 ./hashwx 整个模块换成替身。
 *
 * 两个错误类必须一并提供：组件用 `e instanceof PowUnsupportedError` 判定失败类型，
 * 若替身里缺了它们，`instanceof undefined` 会直接抛 TypeError，把预期分支走成普通失败。
 * （vi.hoisted 是为了让工厂能引用这两个类；vi.mock 的工厂本身会被提升到 import 之前。）
 */
const powMock = vi.hoisted(() => {
	class PowCancelledError extends Error {
		constructor() {
			super('verification cancelled');
			this.name = 'PowCancelledError';
		}
	}
	class PowUnsupportedError extends Error {
		constructor() {
			super('当前浏览器不支持 WebAssembly，无法完成验证');
			this.name = 'PowUnsupportedError';
		}
	}
	return { solvePow: vi.fn(), PowCancelledError, PowUnsupportedError };
});

vi.mock('../src/verify/hashwx', () => ({
	solvePow: powMock.solvePow,
	PowCancelledError: powMock.PowCancelledError,
	PowUnsupportedError: powMock.PowUnsupportedError,
}));

import SilentVerify from '../src/verify/SilentVerify.svelte';

const API_URL = 'https://api.example.com';

/** 记录所有 fetch 调用的替身 */
function fetchMock(handler) {
	const calls = [];
	const mock = vi.fn(async (url, init) => {
		calls.push({ url, init, method: init?.method ?? 'GET' });
		return handler(url, init);
	});
	mock.calls = calls;
	vi.stubGlobal('fetch', mock);
	return mock;
}

/** 后端已关闭验证时的统一响应 */
const challengeDisabled = async (url) =>
	url.includes('/api/verify/challenge') ? jsonResponse({ data: { enabled: false } }) : jsonResponse({});

/** 替身默认返回的 nonces：与 4 个子挑战一一对应 */
const SUB_NONCES = ['11', '22', '33', '44'];

/** 协议 v2 的挑战响应：参数在 data.pow 里，缺失即视为后端过旧 */
const challengeBody = (overrides = {}) =>
	jsonResponse({
		data: {
			enabled: true,
			version: 2,
			post_slug: '/posts/demo',
			prefix: 'prefix-x',
			sig: 'sig-x',
			expires_in: 600,
			pow: { algo: 'hashwx', c: 'a'.repeat(64), d: 250, n: 65536, count: 4 },
			...overrides,
		},
	});

const renderVerify = (props = {}) =>
	render(SilentVerify, { props: { apiUrl: API_URL, postSlug: '/posts/demo', ...props } });

/** 取出 solution 请求体 */
const solutionRequestBody = (fetch) =>
	JSON.parse(fetch.calls.find((c) => c.url.includes('/api/verify/solution')).init.body);

const solutionCallCount = (fetch) =>
	fetch.calls.filter((c) => c.url.includes('/api/verify/solution')).length;

beforeEach(() => {
	// afterEach 的 restoreAllMocks 会清掉 vi.fn() 的实现，每个用例都要重新装上
	powMock.solvePow.mockReset();
	powMock.solvePow.mockResolvedValue([...SUB_NONCES]);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	cleanup();
});

describe('SilentVerify —— 基础渲染', () => {
	it('初始为加载中状态（role=status + aria-live）', () => {
		fetchMock(() => new Promise(() => {}));
		const { container } = renderVerify();		const box = container.querySelector('.verify-box');
		expect(box.getAttribute('role')).toBe('status');
		expect(box.getAttribute('aria-live')).toBe('polite');
		expect(container.textContent).toContain('验证中...');
	});

	it('挑战请求体为 { post_slug }', async () => {
		const fetch = fetchMock(challengeBody);
		renderVerify();
		await waitFor(() => expect(fetch.calls.length).toBeGreaterThan(0));
		expect(fetch.calls[0].url).toBe(`${API_URL}/api/verify/challenge`);
		expect(fetch.calls[0].method).toBe('POST');
		expect(JSON.parse(fetch.calls[0].init.body)).toEqual({ post_slug: '/posts/demo' });
	});

	it('postSlug 为空时不发起任何请求', async () => {
		const fetch = fetchMock(challengeDisabled);
		renderVerify({ postSlug: '' });
		await new Promise((r) => setTimeout(r, 30));
		expect(fetch.calls.length).toBe(0);
	});

	it('默认不渲染蜜罐字段', async () => {
		fetchMock(challengeDisabled);
		const { container } = renderVerify();
		await waitFor(() => expect(container.querySelector('.verify-box')).toBeTruthy());
		expect(container.querySelector('input')).toBeNull();
	});

	it('honeypotField 存在时渲染隐藏输入框（机器可读但人不可见）', async () => {
		fetchMock(challengeDisabled);
		const { container } = renderVerify({ honeypotField: 'hp_abc' });
		await waitFor(() => expect(container.querySelector('input.verify-honeypot')).toBeTruthy());
		const input = container.querySelector('input.verify-honeypot');
		expect(input.getAttribute('name')).toBe('hp_abc');
		expect(input.getAttribute('tabindex')).toBe('-1');
		expect(input.getAttribute('aria-hidden')).toBe('true');
		expect(input.getAttribute('autocomplete')).toBe('off');
	});
});

describe('SilentVerify —— 后端关闭验证时放行', () => {
	it('challenge 返回 enabled:false 时回调空票据字符串', async () => {
		const onTicket = vi.fn();
		fetchMock(challengeDisabled);
		renderVerify({ onTicket });
		await waitFor(() => expect(onTicket).toHaveBeenCalledWith(''));
	});

	it('放行后状态为成功（绿色勾选，不再请求 solution）', async () => {
		const onTicket = vi.fn();
		const fetch = fetchMock(challengeDisabled);
		const { container } = renderVerify({ onTicket });
		await waitFor(() => expect(onTicket).toHaveBeenCalledWith(''));
		await waitFor(() => expect(container.textContent).toContain('验证成功'));
		expect(solutionCallCount(fetch)).toBe(0);
	});

	it('solution 返回 data.enabled === false 时同样放行', async () => {
		const onTicket = vi.fn();
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) return challengeBody();
			return jsonResponse({ data: { enabled: false } });
		});
		renderVerify({ onTicket });
		await waitFor(() => expect(onTicket).toHaveBeenCalledWith(''));
		expect(powMock.solvePow).toHaveBeenCalledTimes(1);
	});

	it('onTicket 未传时也不抛错', async () => {
		fetchMock(challengeDisabled);
		const { container } = renderVerify();
		await waitFor(() => expect(container.textContent).toContain('验证成功'));
	});
});

describe('SilentVerify —— 完整解题流程（协议 v2）', () => {
	it('把 data.pow 解析成挑战参数交给 solvePow，并提交 v2 解题请求体', async () => {
		const onTicket = vi.fn();
		const fetch = fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) return challengeBody();
			return jsonResponse({ data: { ticket: 'TICKET-A' } });
		});
		renderVerify({ onTicket });
		await waitFor(() => expect(onTicket).toHaveBeenCalledWith('TICKET-A'));

		// 组件把 data.pow 的字符串/数字统一转成数字后交给 solvePow
		expect(powMock.solvePow).toHaveBeenCalledTimes(1);
		const [challenge, options] = powMock.solvePow.mock.calls[0];
		expect(challenge).toEqual({ c: 'a'.repeat(64), d: 250, n: 65536, count: 4 });
		expect(typeof options.isCancelled).toBe('function');

		const body = solutionRequestBody(fetch);
		expect(body.post_slug).toBe('/posts/demo');
		expect(body.prefix).toBe('prefix-x');
		expect(body.sig).toBe('sig-x');
		// nonces 与子挑战一一对应，且是十进制字符串（64 位放不进 JS number）
		expect(body.nonces).toEqual(SUB_NONCES);
		expect(body.nonces.every((n) => typeof n === 'string')).toBe(true);
		// v1 的单个 nonce 字段已经不存在
		expect('nonce' in body).toBe(false);
		// v1 那个 320ms 人工等待已删除，elapsed_ms 只反映真实耗时
		expect(typeof body.elapsed_ms).toBe('number');
		expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
		// 没有蜜罐字段时不带 hp
		expect('hp' in body).toBe(false);
	});

	it('字符串形式的 pow 参数会被转成数字后传给 solvePow', async () => {
		const onTicket = vi.fn();
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) {
				return challengeBody({
					pow: { algo: 'hashwx', c: 'b'.repeat(64), d: '250', n: '65536', count: '4' },
				});
			}
			return jsonResponse({ data: { ticket: 'T-str' } });
		});
		renderVerify({ onTicket });
		await waitFor(() => expect(onTicket).toHaveBeenCalledWith('T-str'));

		const [challenge] = powMock.solvePow.mock.calls[0];
		expect(challenge).toEqual({ c: 'b'.repeat(64), d: 250, n: 65536, count: 4 });
	});

	it('蜜罐字段被脚本填写时，提交的 hp 会带上该值', async () => {
		const onTicket = vi.fn();
		// 解题挂着不返回，模拟真实挖矿耗时，好让「脚本填表」发生在提交之前
		let release;
		powMock.solvePow.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

		const fetch = fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) return challengeBody({ prefix: 'p2', sig: 's2' });
			return jsonResponse({ data: { ticket: 'T2' } });
		});
		const { container } = renderVerify({ onTicket, honeypotField: 'hp_field' });
		await waitFor(() => expect(container.querySelector('input.verify-honeypot')).toBeTruthy());
		await waitFor(() => expect(powMock.solvePow).toHaveBeenCalled());

		await fireEvent.input(container.querySelector('input.verify-honeypot'), { target: { value: 'bot-filled' } });
		release([...SUB_NONCES]);

		await waitFor(() => expect(onTicket).toHaveBeenCalledWith('T2'));
		expect(solutionRequestBody(fetch).hp).toBe('bot-filled');
	});

	it('solution 返回 data 但没有 ticket 时进入错误态', async () => {
		const onTicket = vi.fn();
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) return challengeBody({ prefix: 'p4', sig: 's4' });
			return jsonResponse({ data: { ok: true } });
		});
		const { container } = renderVerify({ onTicket });
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		expect(onTicket).toHaveBeenLastCalledWith(null);
	});

	it('solution 响应体损坏（非 JSON）时进入错误态', async () => {
		const onTicket = vi.fn();
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) return challengeBody({ prefix: 'p5', sig: 's5' });
			return {
				ok: true,
				status: 200,
				json: async () => {
					throw new Error('bad json');
				},
			};
		});
		const { container } = renderVerify({ onTicket });
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		expect(onTicket).toHaveBeenLastCalledWith(null);
	});
});

describe('SilentVerify —— 失败态文案（协议 v2 分三种）', () => {
	it('挑战响应缺少 pow 时提示「验证服务版本过旧」且不显示重试', async () => {
		const onTicket = vi.fn();
		// v1 的挑战响应：没有 pow
		const fetch = fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) {
				return jsonResponse({ data: { enabled: true, prefix: 'p', sig: 's', difficulty: 1 } });
			}
			return jsonResponse({ data: { ticket: '不该走到这里' } });
		});
		const { container } = renderVerify({ onTicket });

		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		const button = container.querySelector('button.verify-box');
		expect(button.getAttribute('title')).toBe('验证服务版本过旧，请联系博主升级');
		expect(button.textContent).toContain('验证服务版本过旧');
		// 重试无用，因此不显示「点击重试」
		expect(button.textContent).not.toContain('点击重试');
		expect(powMock.solvePow).not.toHaveBeenCalled();
		expect(solutionCallCount(fetch)).toBe(0);
	});

	it('solution 返回 PROTOCOL_OUTDATED 时提示「验证服务版本过旧」且不显示重试', async () => {
		const onTicket = vi.fn();
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) return challengeBody();
			return jsonResponse(
				{ code: 403, message: 'Verification failed', reason: 'PROTOCOL_OUTDATED' },
				{ ok: false, status: 403 }
			);
		});
		const { container } = renderVerify({ onTicket });

		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		const button = container.querySelector('button.verify-box');
		expect(button.getAttribute('title')).toBe('验证服务版本过旧，请联系博主升级');
		expect(button.textContent).toContain('验证服务版本过旧');
		expect(button.textContent).not.toContain('点击重试');
		// 挑战是合法的，确实解了题才被后端拒
		expect(powMock.solvePow).toHaveBeenCalledTimes(1);
	});

	it('solvePow 抛 PowUnsupportedError 时提示「浏览器版本过低」且不显示重试', async () => {
		const onTicket = vi.fn();
		powMock.solvePow.mockImplementation(async () => {
			throw new powMock.PowUnsupportedError();
		});
		const fetch = fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) return challengeBody();
			return jsonResponse({ data: { ticket: '不该走到这里' } });
		});
		const { container } = renderVerify({ onTicket });

		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		const button = container.querySelector('button.verify-box');
		expect(button.getAttribute('title')).toBe('浏览器版本过低，不支持验证');
		expect(button.textContent).toContain('浏览器版本过低');
		expect(button.textContent).not.toContain('点击重试');
		// 解不出来就不该发 solution
		expect(solutionCallCount(fetch)).toBe(0);
	});

	it('solvePow 抛普通错误时进入「验证失败 · 点击重试」', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onTicket = vi.fn();
		powMock.solvePow.mockImplementation(async () => {
			throw new Error('solver exploded');
		});
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) return challengeBody();
			return jsonResponse({ data: { ticket: 'x' } });
		});
		const { container } = renderVerify({ onTicket });

		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		const button = container.querySelector('button.verify-box');
		expect(button.getAttribute('title')).toBe('验证失败 · 点击重试');
		expect(button.textContent).toContain('验证失败');
		expect(button.textContent).toContain('点击重试');
		expect(warn.mock.calls[0][0]).toBe('人机验证失败:');
	});

	it('solvePow 抛 PowCancelledError 时不进入错误态', async () => {
		const onTicket = vi.fn();
		powMock.solvePow.mockImplementation(async () => {
			throw new powMock.PowCancelledError();
		});
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) return challengeBody();
			return jsonResponse({ data: { ticket: 'x' } });
		});
		const { container } = renderVerify({ onTicket });

		await waitFor(() => expect(powMock.solvePow).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 30));
		// 取消不是失败：不弹错误态，也不回调票据
		expect(container.querySelector('button.verify-box')).toBeNull();
		expect(onTicket).toHaveBeenLastCalledWith(null);
	});
});

describe('SilentVerify —— 失败与重试', () => {
	it('挑战接口抛错时进入错误态并告警', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onTicket = vi.fn();
		fetchMock(async () => {
			throw new Error('net down');
		});
		const { container } = renderVerify({ onTicket });
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		expect(onTicket).toHaveBeenLastCalledWith(null);
		expect(warn.mock.calls[0][0]).toBe('人机验证失败:');
	});

	it('挑战接口返回非 2xx 时进入错误态', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onTicket = vi.fn();
		fetchMock(async () => jsonResponse({}, { ok: false, status: 500 }));
		const { container } = renderVerify({ onTicket });
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		expect(onTicket).toHaveBeenLastCalledWith(null);
	});

	it('错误态显示"验证失败 · 点击重试"，title 同时提供提示', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock(async () => {
			throw new Error('net down');
		});
		const { container } = renderVerify();
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		const button = container.querySelector('button.verify-box');
		expect(button.textContent).toContain('验证失败');
		expect(button.textContent).toContain('点击重试');
		expect(button.getAttribute('title')).toBe('验证失败 · 点击重试');
	});

	it('点击错误态按钮会重新发起挑战', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		let challenges = 0;
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) {
				challenges++;
				throw new Error('still down');
			}
			return jsonResponse({});
		});
		const { container } = renderVerify();
		await waitFor(() => expect(challenges).toBe(1));
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		await fireEvent.click(container.querySelector('button.verify-box'));
		await waitFor(() => expect(challenges).toBe(2));
	});

	it('重试成功后从错误态恢复为成功态', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onTicket = vi.fn();
		let first = true;
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) {
				if (first) {
					first = false;
					throw new Error('down');
				}
				return jsonResponse({ data: { enabled: false } });
			}
			return jsonResponse({});
		});
		const { container } = renderVerify({ onTicket });
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		await fireEvent.click(container.querySelector('button.verify-box'));
		await waitFor(() => expect(container.textContent).toContain('验证成功'));
		expect(onTicket).toHaveBeenLastCalledWith('');
	});
});

describe('SilentVerify —— 移动端与多语言', () => {
	it('移动端只显示图标，不显示文字', async () => {
		const restore = stubMatchMedia(true);
		try {
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			fetchMock(async () => {
				throw new Error('down');
			});
			const { container } = renderVerify();
			await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
			expect(container.querySelector('button.verify-box').textContent.trim()).toBe('');
		} finally {
			restore();
		}
	});

	it('移动端加载态也不显示"验证中..."', () => {
		const restore = stubMatchMedia(true);
		try {
			fetchMock(() => new Promise(() => {}));
			const { container } = renderVerify();
			expect(container.textContent).not.toContain('验证中');
		} finally {
			restore();
		}
	});

	it('移动端「浏览器版本过低」态同样不显示文字', async () => {
		const restore = stubMatchMedia(true);
		try {
			powMock.solvePow.mockImplementation(async () => {
				throw new powMock.PowUnsupportedError();
			});
			fetchMock(async (url) => (url.includes('/api/verify/challenge') ? challengeBody() : jsonResponse({})));
			const { container } = renderVerify();
			await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
			expect(container.querySelector('button.verify-box').textContent.trim()).toBe('');
		} finally {
			restore();
		}
	});

	it('language="en" 时错误态文案为英文', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock(async () => {
			throw new Error('down');
		});
		const { container } = renderVerify({ language: 'en' });
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		expect(container.textContent).toContain('Verification failed');
		expect(container.textContent).toContain('Click to retry');
	});

	it('language="en" 时成功态文案为 Verified', async () => {
		fetchMock(challengeDisabled);
		const { container } = renderVerify({ language: 'en' });
		await waitFor(() => expect(container.textContent).toContain('Verified'));
	});

	it('language="en" 时「后端过旧」与「浏览器过低」文案为英文', async () => {
		// 后端过旧（挑战里没有 pow）
		fetchMock(async (url) =>
			url.includes('/api/verify/challenge')
				? jsonResponse({ data: { enabled: true, prefix: 'p', sig: 's' } })
				: jsonResponse({})
		);
		const first = renderVerify({ language: 'en' });
		await waitFor(() => expect(first.container.querySelector('button.verify-box')).toBeTruthy());
		expect(first.container.querySelector('button.verify-box').textContent).toContain(
			'The verification service is outdated'
		);
		cleanup();

		// 浏览器不支持 WebAssembly
		powMock.solvePow.mockImplementation(async () => {
			throw new powMock.PowUnsupportedError();
		});
		fetchMock(async (url) => (url.includes('/api/verify/challenge') ? challengeBody() : jsonResponse({})));
		const second = renderVerify({ language: 'en' });
		await waitFor(() => expect(second.container.querySelector('button.verify-box')).toBeTruthy());
		expect(second.container.querySelector('button.verify-box').textContent).toContain('Your browser is too old');
	});
});

describe('SilentVerify —— 生命周期', () => {
	it('切换 postSlug 会针对新文章重新验证', async () => {
		const fetch = fetchMock(challengeDisabled);
		const { rerender } = renderVerify();
		await waitFor(() => expect(fetch.calls.length).toBe(1));
		await rerender({ postSlug: '/posts/other' });
		await waitFor(() => expect(fetch.calls.length).toBe(2));
		expect(JSON.parse(fetch.calls[1].init.body)).toEqual({ post_slug: '/posts/other' });
	});

	it('postSlug 未变化时不会重复验证', async () => {
		const fetch = fetchMock(challengeDisabled);
		const { rerender } = renderVerify();
		await waitFor(() => expect(fetch.calls.length).toBe(1));
		await rerender({ postSlug: '/posts/demo' });
		await new Promise((r) => setTimeout(r, 30));
		expect(fetch.calls.length).toBe(1);
	});

	it('组件卸载后不再继续提交 solution', async () => {
		// 让解题挂着不返回：卸载发生在「解题中」，随后放行也不该再提交
		let release;
		powMock.solvePow.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
		const fetch = fetchMock(async (url) =>
			url.includes('/api/verify/challenge') ? challengeBody({ prefix: 'p6', sig: 's6' }) : jsonResponse({ data: { ticket: 'T6' } })
		);

		const { unmount } = renderVerify({});
		await waitFor(() => expect(powMock.solvePow).toHaveBeenCalled());
		unmount();
		release([...SUB_NONCES]);
		await new Promise((r) => setTimeout(r, 50));

		expect(solutionCallCount(fetch)).toBe(0);
	});

	it('切换文章后旧挑战的解题结果不会被提交', async () => {
		const pending = [];
		powMock.solvePow.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
		const fetch = fetchMock(async (url) =>
			url.includes('/api/verify/challenge') ? challengeBody() : jsonResponse({ data: { ticket: 'T-B' } })
		);

		const { rerender } = renderVerify();
		await waitFor(() => expect(powMock.solvePow).toHaveBeenCalledTimes(1));

		await rerender({ postSlug: '/posts/other' });
		await waitFor(() => expect(powMock.solvePow).toHaveBeenCalledTimes(2));

		// 先放行当前文章的解题结果
		pending[1]([...SUB_NONCES]);
		await waitFor(() => expect(solutionCallCount(fetch)).toBe(1));

		// 再放行已过期文章的结果：必须被丢弃
		pending[0](['99', '99', '99', '99']);
		await new Promise((r) => setTimeout(r, 50));

		expect(solutionCallCount(fetch)).toBe(1);
		expect(solutionRequestBody(fetch).post_slug).toBe('/posts/other');
	});
});

/* ------------------------------------------------------------------ *
 * 第二层：Instrumentation 环境质询
 *
 * 这里不 mock ./instrumentation —— 组件用的是真实实现。
 * happy-dom 没有布局引擎，会走「宿主页面隐藏容器」的降级路径，
 * 但 DOM 建树/读写/回走都能真跑，因此寄存器仍然算得出来（数值是否正确由
 * instrumentation.test.js 用共享 fixture 对着服务端影子模型逐位钉住）。
 * ------------------------------------------------------------------ */
describe('SilentVerify —— 第二层环境质询', () => {
	/** 与 doc/vectors/instrumentation-v2.json 的第一个向量同源的一段程序 */
	const INSTR_OPS = [
		0, 0, 12345, // CONST r0 = 12345
		14, 0, 0, // DOM_CREATE div
		15, 0, 0, // DOM_APPEND
		17, 0, 0, // DOM_SET_ATTR r0
		0, 1, 0, // CONST r1 = 0
		19, 1, 0, // DOM_READ_ATTR r1
		21, 0, 0, // DOM_REMOVE
		22, 2, 0, // PROTO_JOIN r2
		23, 3, 0, // PROTO_CHARCODE r3
	];

	it('挑战下发 instr 时，提交体携带环境质询结果', async () => {
		const fetch = fetchMock(async (url) =>
			url.includes('/api/verify/challenge')
				? challengeBody({ instr: { ops: INSTR_OPS, fonts: 17 } })
				: jsonResponse({ data: { ticket: 'T-INSTR' } })
		);

		renderVerify();
		await waitFor(() => expect(solutionCallCount(fetch)).toBe(1));

		const body = solutionRequestBody(fetch);
		expect(body.instr).toBeTruthy();
		expect(body.instr.regs).toHaveLength(4);
		expect(body.instr.regs.every((v) => Number.isInteger(v))).toBe(true);
		// 程序里把 r0 写成 12345 再读回属性，因此 r0、r1 都必须是 12345
		expect(body.instr.regs[0]).toBe(12345);
		expect(body.instr.regs[1]).toBe(12345);
		expect(body.instr.env).toBeTruthy();
		expect(Array.isArray(body.instr.tm)).toBe(true);
		expect(body.instr.lw).toBe(body.instr.env.lw);
		expect(body.instr.lh).toBe(body.instr.env.lh);
		// 执行完不留痕迹
		expect(document.querySelectorAll('[data-momo-verify-root]').length).toBe(0);
	});

	it('后端未开启第二层时，提交体不带 instr', async () => {
		const fetch = fetchMock(async (url) =>
			url.includes('/api/verify/challenge')
				? challengeBody()
				: jsonResponse({ data: { ticket: 'T-NOINSTR' } })
		);

		renderVerify();
		await waitFor(() => expect(solutionCallCount(fetch)).toBe(1));
		expect('instr' in solutionRequestBody(fetch)).toBe(false);
	});

	it('下发了 instr 但程序结构非法 → 判为后端协议过旧，不发解答请求', async () => {
		const fetch = fetchMock(async (url) =>
			url.includes('/api/verify/challenge')
				? challengeBody({ instr: { ops: [1, 2], fonts: 17 } })
				: jsonResponse({ data: { ticket: 'x' } })
		);

		const { container } = renderVerify();
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		expect(container.textContent).toContain('验证服务版本过旧');
		expect(solutionCallCount(fetch)).toBe(0);
		// 协议不配套时重试无用，按钮必须处于禁用态
		expect(container.querySelector('button.verify-box').disabled).toBe(true);
	});

	it('空 ops 同样判为后端协议过旧', async () => {
		const fetch = fetchMock(async (url) =>
			url.includes('/api/verify/challenge')
				? challengeBody({ instr: { ops: [], fonts: 17 } })
				: jsonResponse({ data: { ticket: 'x' } })
		);

		const { container } = renderVerify();
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy());
		expect(solutionCallCount(fetch)).toBe(0);
	});
});
