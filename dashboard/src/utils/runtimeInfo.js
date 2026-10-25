import { normalizeApiUrl } from './apiUrl';

/**
 * 读取后端 /health 的运行时字段并判断部署方式。
 *
 * 三端 /health 现在都会返回：
 *   runtime   node | go | worker
 *   container 是否运行在 Docker / Podman 中
 *   os/arch   服务端平台
 *
 * 面板只知道自己的版本号，无法仅凭域名或响应头可靠区分 Node / Go / Worker，
 * 因此部署方式以后端返回的字段为准；字段缺失（旧版后端）时由调用方回退到手动选择。
 */

export const DEPLOYMENT_LABELS = {
	node: 'Node.js',
	go: 'Go',
	worker: 'Cloudflare Worker',
	docker: 'Docker',
};

/** 手动兜底时展示的顺序 */
export const MANUAL_DEPLOYMENTS = ['node', 'go', 'worker', 'docker'];

const RUNTIMES = new Set(['node', 'go', 'worker']);
const CONTAINER_RUNTIMES = new Set(['node', 'go']);

function safeStorage() {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function currentOrigin() {
	try {
		return globalThis.window?.location?.origin || '';
	} catch {
		return '';
	}
}

/** 平台名归一化：兼容 Node 的 win32、macOS 的 darwin / macos 等写法 */
export function normalizeOs(raw) {
	const value = String(raw ?? '').trim().toLowerCase();
	if (!value) return 'unknown';
	if (value === 'win32' || value === 'windows') return 'windows';
	if (value === 'mac' || value === 'macos' || value === 'osx' || value === 'darwin') {
		return 'darwin';
	}
	return value;
}

/** 架构名归一化：兼容 Node 的 x64 / ia32 与 Go 的 amd64 / 386 */
export function normalizeArch(raw) {
	const value = String(raw ?? '').trim().toLowerCase();
	if (!value) return 'unknown';
	if (value === 'x64' || value === 'x86_64' || value === 'amd64') return 'amd64';
	if (value === 'aarch64' || value === 'arm64') return 'arm64';
	if (value === 'x86' || value === 'i386' || value === 'ia32' || value === '386') return '386';
	return value;
}

/**
 * 校验并归一化 /health 的 data；旧版后端缺少 runtime 时返回 null。
 */
export function normalizeRuntimeInfo(payload) {
	const data = payload && typeof payload === 'object' ? payload : null;
	if (!data) return null;

	const runtime = typeof data.runtime === 'string' ? data.runtime.trim().toLowerCase() : '';
	if (!RUNTIMES.has(runtime)) return null;

	return {
		runtime,
		container: CONTAINER_RUNTIMES.has(runtime) && data.container === true,
		os: normalizeOs(data.os),
		arch: normalizeArch(data.arch),
	};
}

/** 由运行时信息得出升级步骤使用的部署方式；Worker 永远不按容器处理 */
export function deploymentFor(info) {
	if (!info) return '';
	if (info.runtime === 'worker') return 'worker';
	if (info.container) return 'docker';
	return info.runtime;
}

/** 当前面板应请求的 API 根地址：优先 localStorage.apiUrl，否则当前源 */
export function resolveApiBaseUrl({ storage = safeStorage(), origin = currentOrigin() } = {}) {
	let stored = null;
	try {
		stored = storage?.getItem('apiUrl') ?? null;
	} catch {
		stored = null;
	}
	const normalized = stored ? normalizeApiUrl(stored) : null;
	return (normalized || origin || 'http://localhost').replace(/\/+$/, '');
}

/** /health 在 API 根路径上，不在 /api 前缀下 */
export function healthUrl(baseUrl = resolveApiBaseUrl()) {
	const origin = currentOrigin() || 'http://localhost';
	return new URL('/health', new URL(baseUrl, origin)).toString();
}

/**
 * 请求 /health 并返回运行时信息。
 * HTTP 503 也接受：数据库不可用时后端仍会带上 runtime 字段。
 */
export async function fetchRuntimeInfo(options = {}) {
	const {
		fetchImpl = globalThis.fetch,
		baseUrl = resolveApiBaseUrl(),
		timeoutMs = 5000,
	} = options;
	if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持 fetch');

	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
	try {
		const res = await fetchImpl(healthUrl(baseUrl), {
			signal: controller ? controller.signal : undefined,
			headers: { Accept: 'application/json' },
			cache: 'no-store',
		});

		let body;
		try {
			body = await res.json();
		} catch {
			throw new Error('健康检查响应不是 JSON');
		}

		const info = normalizeRuntimeInfo(body?.data);
		if (!info) throw new Error('当前后端未返回部署方式');
		return info;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
