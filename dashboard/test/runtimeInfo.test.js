import { describe, it, expect, vi } from 'vitest';
import {
	deploymentFor,
	fetchRuntimeInfo,
	healthUrl,
	normalizeArch,
	normalizeOs,
	normalizeRuntimeInfo,
	resolveApiBaseUrl,
} from '../src/utils/runtimeInfo.js';

const jsonResponse = (body, init = {}) => ({
	ok: true,
	status: 200,
	json: async () => body,
	...init,
});

const healthData = (overrides = {}) => ({
	status: 'ok',
	database: 'ok',
	runtime: 'go',
	container: false,
	os: 'linux',
	arch: 'amd64',
	...overrides,
});

describe('运行时字段归一化', () => {
	it('兼容 Node / macOS 的平台与架构写法', () => {
		expect(normalizeOs('win32')).toBe('windows');
		expect(normalizeOs('Windows')).toBe('windows');
		expect(normalizeOs('macos')).toBe('darwin');
		expect(normalizeOs('')).toBe('unknown');
		expect(normalizeArch('x64')).toBe('amd64');
		expect(normalizeArch('aarch64')).toBe('arm64');
		expect(normalizeArch('ia32')).toBe('386');
		expect(normalizeArch(undefined)).toBe('unknown');
	});

	it('接受合法的 runtime / container / os / arch', () => {
		expect(normalizeRuntimeInfo(healthData())).toEqual({
			runtime: 'go',
			container: false,
			os: 'linux',
			arch: 'amd64',
		});
		expect(normalizeRuntimeInfo(healthData({ runtime: 'worker', os: 'cloudflare', arch: 'unknown' }))).toEqual({
			runtime: 'worker',
			container: false,
			os: 'cloudflare',
			arch: 'unknown',
		});
	});

	it('旧版后端缺少 runtime 或 runtime 非法时返回 null', () => {
		expect(normalizeRuntimeInfo({ status: 'ok', database: 'ok' })).toBeNull();
		expect(normalizeRuntimeInfo(healthData({ runtime: 'php' }))).toBeNull();
		expect(normalizeRuntimeInfo(null)).toBeNull();
	});

	it('Worker 永远不按容器处理', () => {
		const info = normalizeRuntimeInfo(
			healthData({ runtime: 'worker', container: true, os: 'cloudflare', arch: 'unknown' })
		);
		expect(deploymentFor(info)).toBe('worker');
	});

	it('容器内的 Node / Go 归为 Docker，裸机保留语言类型', () => {
		expect(deploymentFor(normalizeRuntimeInfo(healthData({ runtime: 'go', container: true })))).toBe(
			'docker'
		);
		expect(deploymentFor(normalizeRuntimeInfo(healthData({ runtime: 'node', container: true })))).toBe(
			'docker'
		);
		expect(deploymentFor(normalizeRuntimeInfo(healthData({ runtime: 'node', container: false })))).toBe(
			'node'
		);
		expect(deploymentFor(null)).toBe('');
	});
});

describe('API 地址与 /health 请求', () => {
	it('优先使用合法的 localStorage.apiUrl，否则回落到当前源', () => {
		expect(
			resolveApiBaseUrl({
				storage: { getItem: () => 'https://api.example.com/' },
				origin: 'https://panel.example.com',
			})
		).toBe('https://api.example.com');
		expect(resolveApiBaseUrl({ storage: { getItem: () => '' }, origin: 'https://panel.example.com' })).toBe(
			'https://panel.example.com'
		);
		expect(
			resolveApiBaseUrl({
				storage: { getItem: () => 'javascript:alert(1)' },
				origin: 'https://panel.example.com',
			})
		).toBe('https://panel.example.com');
	});

	it('healthUrl 始终落在 API 根的 /health 上', () => {
		expect(healthUrl('https://api.example.com')).toBe('https://api.example.com/health');
		expect(healthUrl('https://api.example.com/momo/')).toBe('https://api.example.com/health');
	});

	it('解析 200 响应', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ code: 200, message: 'ok', data: healthData() }));
		const info = await fetchRuntimeInfo({ fetchImpl, baseUrl: 'https://api.example.com' });

		expect(info).toEqual({ runtime: 'go', container: false, os: 'linux', arch: 'amd64' });
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://api.example.com/health',
			expect.objectContaining({ headers: { Accept: 'application/json' } })
		);
	});

	it('数据库不可用的 503 也接受，只要带 runtime', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(
				{ code: 503, message: 'database unavailable', data: healthData({ status: 'error', database: 'error' }) },
				{ ok: false, status: 503 }
			)
		);
		const info = await fetchRuntimeInfo({ fetchImpl, baseUrl: 'https://api.example.com' });
		expect(info.runtime).toBe('go');
	});

	it('旧版后端或非 JSON 响应会抛错，交给调用方回退手动选择', async () => {
		const old = vi.fn(async () => jsonResponse({ code: 200, data: { status: 'ok', database: 'ok' } }));
		await expect(fetchRuntimeInfo({ fetchImpl: old, baseUrl: 'https://api.example.com' })).rejects.toThrow(
			'未返回部署方式'
		);

		const notJson = vi.fn(async () => ({
			ok: true,
			json: async () => {
				throw new Error('bad json');
			},
		}));
		await expect(
			fetchRuntimeInfo({ fetchImpl: notJson, baseUrl: 'https://api.example.com' })
		).rejects.toThrow('不是 JSON');
	});
});
