import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import SilentVerify from '../src/verify/SilentVerify.svelte';
import { jsonResponse, stubMatchMedia, patchHappyDomAnimation } from './helpers';

beforeAll(patchHappyDomAnimation);

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

const renderVerify = (props = {}) =>
	render(SilentVerify, { props: { apiUrl: API_URL, postSlug: '/posts/demo', ...props } });

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	cleanup();
});

describe('SilentVerify —— 基础渲染', () => {
	it('初始为加载中状态（role=status + aria-live）', () => {
		fetchMock(() => new Promise(() => {}));
		const { container } = renderVerify();
		const box = container.querySelector('.verify-box');
		expect(box.getAttribute('role')).toBe('status');
		expect(box.getAttribute('aria-live')).toBe('polite');
		expect(container.textContent).toContain('验证中...');
	});

	it('挑战请求体为 { post_slug }', async () => {
		const fetch = fetchMock(challengeDisabled);
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
		expect(fetch.calls.every((c) => !c.url.includes('/api/verify/solution'))).toBe(true);
	});

	it('solution 返回 data.enabled === false 时同样放行', async () => {
		const onTicket = vi.fn();
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) {
				return jsonResponse({ data: { enabled: true, prefix: 'p', sig: 's', difficulty: 1 } });
			}
			return jsonResponse({ data: { enabled: false } });
		});
		renderVerify({ onTicket });
		await waitFor(() => expect(onTicket).toHaveBeenCalledWith(''), { timeout: 3000 });
	}, 15000);

	it('onTicket 未传时也不抛错', async () => {
		fetchMock(challengeDisabled);
		const { container } = renderVerify();
		await waitFor(() => expect(container.textContent).toContain('验证成功'));
	});
});

describe('SilentVerify —— 完整解题流程', () => {
	it('解出 nonce 后提交 solution，并在 320ms 阈值后回调票据', async () => {
		const onTicket = vi.fn();
		const fetch = fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) {
				return jsonResponse({ data: { enabled: true, prefix: 'prefix-x', sig: 'sig-x', difficulty: 1 } });
			}
			return jsonResponse({ data: { ticket: 'TICKET-A' } });
		});
		renderVerify({ onTicket });
		await waitFor(() => expect(onTicket).toHaveBeenCalledWith('TICKET-A'), { timeout: 3000 });

		const solution = fetch.calls.find((c) => c.url.includes('/api/verify/solution'));
		const body = JSON.parse(solution.init.body);
		expect(body.post_slug).toBe('/posts/demo');
		expect(body.prefix).toBe('prefix-x');
		expect(body.sig).toBe('sig-x');
		expect(typeof body.nonce).toBe('number');
		// 后端要求总耗时高于 300ms，太快会被当成脚本
		expect(body.elapsed_ms).toBeGreaterThanOrEqual(320);
		// 没有蜜罐字段时不带 hp
		expect('hp' in body).toBe(false);
	}, 15000);

	it('蜜罐字段被脚本填写时，提交的 hp 会带上该值', async () => {
		const onTicket = vi.fn();
		const fetch = fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) {
				return jsonResponse({ data: { enabled: true, prefix: 'p2', sig: 's2', difficulty: 1 } });
			}
			return jsonResponse({ data: { ticket: 'T2' } });
		});
		const { container } = renderVerify({ onTicket, honeypotField: 'hp_field' });
		await waitFor(() => expect(container.querySelector('input.verify-honeypot')).toBeTruthy());
		await fireEvent.input(container.querySelector('input.verify-honeypot'), { target: { value: 'bot-filled' } });
		await waitFor(() => expect(onTicket).toHaveBeenCalledWith('T2'), { timeout: 3000 });

		const body = JSON.parse(fetch.calls.find((c) => c.url.includes('/api/verify/solution')).init.body);
		expect(body.hp).toBe('bot-filled');
	}, 15000);

	it('difficulty 缺失/为 0/非法时回退到默认难度且仍能解出', async () => {
		for (const difficulty of [undefined, 0, null, 'abc']) {
			const onTicket = vi.fn();
			fetchMock(async (url) => {
				if (url.includes('/api/verify/challenge')) {
					return jsonResponse({ data: { enabled: true, prefix: 'p3', sig: 's3', difficulty } });
				}
				return jsonResponse({ data: { ticket: `T-${difficulty}` } });
			});
			renderVerify({ onTicket });
			await waitFor(() => expect(onTicket).toHaveBeenCalledWith(`T-${difficulty}`), { timeout: 5000 });
			cleanup();
		}
	}, 30000);

	it('solution 返回 data 但没有 ticket 时进入错误态', async () => {
		const onTicket = vi.fn();
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) {
				return jsonResponse({ data: { enabled: true, prefix: 'p4', sig: 's4', difficulty: 1 } });
			}
			return jsonResponse({ data: { ok: true } });
		});
		const { container } = renderVerify({ onTicket });
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy(), { timeout: 3000 });
		expect(onTicket).toHaveBeenLastCalledWith(null);
	}, 15000);

	it('solution 响应体损坏（非 JSON）时进入错误态', async () => {
		const onTicket = vi.fn();
		fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) {
				return jsonResponse({ data: { enabled: true, prefix: 'p5', sig: 's5', difficulty: 1 } });
			}
			return {
				ok: true,
				status: 200,
				json: async () => {
					throw new Error('bad json');
				},
			};
		});
		const { container } = renderVerify({ onTicket });
		await waitFor(() => expect(container.querySelector('button.verify-box')).toBeTruthy(), { timeout: 3000 });
		expect(onTicket).toHaveBeenLastCalledWith(null);
	}, 15000);
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

	it('组件销毁后不再继续提交 solution（定时器被清理）', async () => {
		const fetch = fetchMock(async (url) => {
			if (url.includes('/api/verify/challenge')) {
				return jsonResponse({ data: { enabled: true, prefix: 'p6', sig: 's6', difficulty: 1 } });
			}
			return jsonResponse({ data: { ticket: 'T6' } });
		});
		const { unmount } = renderVerify({});
		await waitFor(() => expect(fetch.calls.length).toBe(1));
		unmount();
		await new Promise((r) => setTimeout(r, 450));
		expect(fetch.calls.filter((c) => c.url.includes('/api/verify/solution')).length).toBe(0);
	}, 15000);
});
