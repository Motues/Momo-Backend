import { computed, ref } from 'vue';
import {
	APP_VERSION,
	fetchLatestVersion,
	isCacheFresh,
	isNewerVersion,
	readCache,
	writeCache,
} from '../utils/version';

/** storage 不可用（隐私模式 / 站点数据被屏蔽）时退化为一次性内存存储 */
function safeStorage() {
	try {
		const probe = globalThis.localStorage;
		probe?.getItem('__momo_probe__');
		return probe ?? null;
	} catch {
		return null;
	}
}

/**
 * 「检查更新」的响应式封装。
 *
 * 行为约定：
 *  - 命中有效缓存（6 小时内）时直接使用，不发请求；
 *  - force=true 时忽略缓存强制请求（手动点击「检查更新」走这条）；
 *  - 请求失败时若仍有旧缓存，则沿用旧缓存的结论（不把「检查不到」当成「已是最新」），
 *    同时把错误写进 error 供界面提示。
 */
export function useVersionCheck(options = {}) {
	const {
		current = APP_VERSION,
		storage = safeStorage(),
		fetcher = fetchLatestVersion,
		now = () => Date.now(),
	} = options;

	const currentVersion = ref(current);
	const latestVersion = ref('');
	const releaseUrl = ref('');
	const source = ref('');
	const checkedAt = ref(0);
	const checking = ref(false);
	const error = ref('');

	const hasUpdate = computed(() => isNewerVersion(latestVersion.value, currentVersion.value));

	function apply(entry) {
		latestVersion.value = entry?.latest ?? '';
		releaseUrl.value = entry?.url ?? '';
		source.value = entry?.source ?? '';
		checkedAt.value = entry?.checkedAt ?? 0;
	}

	async function check({ force = false } = {}) {
		if (checking.value) return hasUpdate.value;

		const cached = storage ? readCache(storage) : null;
		if (cached) apply(cached);

		if (!force && cached && isCacheFresh(cached, now())) {
			error.value = '';
			return hasUpdate.value;
		}

		checking.value = true;
		error.value = '';
		try {
			const result = await fetcher();
			const entry = {
				latest: result.version,
				url: result.url ?? '',
				source: result.source ?? '',
				checkedAt: now(),
			};
			if (storage) writeCache(entry, storage);
			apply(entry);
			return hasUpdate.value;
		} catch (e) {
			error.value = e?.message || '检查更新失败';
			return hasUpdate.value;
		} finally {
			checking.value = false;
		}
	}

	return {
		currentVersion,
		latestVersion,
		releaseUrl,
		source,
		checkedAt,
		checking,
		error,
		hasUpdate,
		check,
	};
}
