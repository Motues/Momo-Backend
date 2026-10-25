import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import {
	DATABASE_CHANGES,
	UPDATE_DOC_URL,
	buildUpgradeSteps,
	getDatabaseChanges,
	getGoReleaseTarget,
} from '../src/utils/updateGuide.js';
import { compareVersions } from '../src/utils/version.js';
import UpdateGuideModal from '../src/components/UpdateGuideModal.vue';

const RELEASE_URL = 'https://github.com/Motues/Momo-Backend/releases/tag/v1.8.2';

const jsonResponse = (body, init = {}) => ({
	ok: true,
	status: 200,
	json: async () => body,
	...init,
});

const healthData = (overrides = {}) => ({
	status: 'ok',
	database: 'ok',
	runtime: 'worker',
	container: false,
	os: 'cloudflare',
	arch: 'unknown',
	...overrides,
});

const mockHealth = (overrides = {}) =>
	vi.fn(async () => jsonResponse({ code: 200, message: 'ok', data: healthData(overrides) }));

/** 浮窗用了 Teleport，测试里 stub 掉让内容留在 wrapper 内便于断言 */
const mountModal = async (props = {}) => {
	const wrapper = mount(UpdateGuideModal, {
		props: {
			visible: true,
			currentVersion: '1.7.0',
			latestVersion: '1.8.2',
			releaseUrl: RELEASE_URL,
			...props,
		},
		global: { stubs: { teleport: true } },
	});
	await flushPromises();
	return wrapper;
};

beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal('fetch', mockHealth());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('getDatabaseChanges', () => {
	it('当前版本已经包含所有变更时返回空列表', () => {
		const newestKnown = DATABASE_CHANGES[DATABASE_CHANGES.length - 1].version;
		expect(getDatabaseChanges(newestKnown, '99.0.0')).toEqual([]);
	});

	it('只列出当前版本之后、且不晚于最新版本的变更', () => {
		expect(getDatabaseChanges('1.7.0', '1.8.2').map((item) => item.version)).toEqual(['1.8.0']);
		expect(getDatabaseChanges('1.5.0', '1.6.5').map((item) => item.version)).toEqual([
			'1.6.0',
			'1.6.1',
		]);
	});

	it('从很旧的版本升级时按时间顺序列出所有跨过的变更', () => {
		expect(getDatabaseChanges('1.2.0', '1.8.2').map((item) => item.version)).toEqual([
			'1.3.0',
			'1.4.0',
			'1.6.0',
			'1.6.1',
			'1.8.0',
		]);
	});

	it('latest 缺失时不做上限过滤，避免漏掉提示', () => {
		expect(getDatabaseChanges('1.7.0').map((item) => item.version)).toEqual(['1.8.0']);
	});

	it('静态数据保持按版本升序，且每条都有说明', () => {
		for (let i = 1; i < DATABASE_CHANGES.length; i += 1) {
			expect(compareVersions(DATABASE_CHANGES[i - 1].version, DATABASE_CHANGES[i].version)).toBe(
				-1
			);
		}
		for (const item of DATABASE_CHANGES) expect(item.summary.length).toBeGreaterThan(0);
	});
});

describe('各部署方式的升级步骤', () => {
	it('Worker：替换文件、保留 wrangler.jsonc、安装并部署', () => {
		const text = JSON.stringify(buildUpgradeSteps({ deployment: 'worker' }));
		expect(text).toContain('worker.zip');
		expect(text).toContain('wrangler.jsonc');
		expect(text).toContain('pnpm install && pnpm run deploy');
	});

	it('Node.js：替换源码、保留 .env 与 data、构建后重启', () => {
		const text = JSON.stringify(buildUpgradeSteps({ deployment: 'node' }));
		expect(text).toContain('nodejs.zip');
		expect(text).toContain('.env');
		expect(text).toContain('pnpm install && pnpm build');
	});

	it('Go：按 Linux / Windows 与 amd64 选择具体包名', () => {
		expect(getGoReleaseTarget('linux', 'amd64')).toMatchObject({
			supported: true,
			asset: 'go-linux-amd64.tar.gz',
		});
		expect(getGoReleaseTarget('windows', 'amd64')).toMatchObject({
			supported: true,
			asset: 'go-windows-amd64.zip',
			windows: true,
		});
		expect(getGoReleaseTarget('linux', 'arm64').supported).toBe(false);

		const linuxText = JSON.stringify(
			buildUpgradeSteps({ deployment: 'go', os: 'linux', arch: 'amd64' })
		);
		expect(linuxText).toContain('go-linux-amd64.tar.gz');
		expect(linuxText).toContain('config/config.yaml');
		expect(linuxText).toContain('data/');

		const windowsText = JSON.stringify(
			buildUpgradeSteps({ deployment: 'go', os: 'windows', arch: 'amd64' })
		);
		expect(windowsText).toContain('go-windows-amd64.zip');
		expect(windowsText).toContain('momo-backend-windows-amd64.exe');
	});

	it('Docker：只给 pull / up 步骤，并保留数据卷', () => {
		const text = JSON.stringify(buildUpgradeSteps({ deployment: 'docker', runtime: 'go' }));
		expect(text).toContain('docker compose pull');
		expect(text).toContain('docker compose up -d');
		expect(text).toContain('data');
	});

	it('未知部署方式返回空步骤', () => {
		expect(buildUpgradeSteps({ deployment: '' })).toEqual([]);
	});
});

describe('UpdateGuideModal', () => {
	it('显示版本跨度、跨过的数据库变更和对应 Release 链接', async () => {
		const wrapper = await mountModal();
		const text = wrapper.text();

		expect(text).toContain('v1.7.0');
		expect(text).toContain('v1.8.2');
		expect(text).toContain('v1.8.0');
		expect(text).toContain('LinkSyncRequest');
		expect(text).not.toContain('不涉及已知的数据库结构变更');

		const link = wrapper.get('[data-test="update-guide-release-link"]');
		expect(link.attributes('href')).toBe(RELEASE_URL);
		expect(link.attributes('target')).toBe('_blank');
		expect(link.attributes('rel')).toContain('noopener');
		expect(link.text()).toContain('查看 Release 页面');
	});

	it('没有跨过数据库变更时显示「直接替换文件」提示', async () => {
		const wrapper = await mountModal({ currentVersion: '1.8.1', latestVersion: '1.8.3' });
		expect(wrapper.text()).toContain('本次升级不涉及已知的数据库结构变更');
		expect(wrapper.find('[data-test="update-guide-release-link"]').exists()).toBe(true);
	});

	it('没有具体 Release 地址时按版本号拼出对应页面', async () => {
		const wrapper = await mountModal({ releaseUrl: '' });
		expect(wrapper.get('[data-test="update-guide-release-link"]').attributes('href')).toBe(
			RELEASE_URL
		);
	});

	it('自动识别 Worker 后只展示 Worker 一套步骤', async () => {
		const wrapper = await mountModal();
		const text = wrapper.text();

		expect(wrapper.get('[data-test="update-guide-deployment"]').text()).toContain(
			'Cloudflare Worker'
		);
		expect(text).toContain('worker.zip');
		expect(text).toContain('wrangler.jsonc');
		expect(text).toContain('pnpm install && pnpm run deploy');
		expect(text).not.toContain('nodejs.zip');
		expect(text).not.toContain('docker compose pull');
	});

	it('自动识别 Node.js 后展示源码替换与 .env 保留提示', async () => {
		vi.stubGlobal(
			'fetch',
			mockHealth({ runtime: 'node', container: false, os: 'linux', arch: 'amd64' })
		);
		const wrapper = await mountModal();
		const text = wrapper.text();

		expect(wrapper.get('[data-test="update-guide-deployment"]').text()).toContain(
			'Node.js · linux / amd64'
		);
		expect(text).toContain('nodejs.zip');
		expect(text).toContain('.env');
		expect(text).toContain('pnpm install && pnpm build');
		expect(text).not.toContain('worker.zip');
	});

	it('自动识别 Go 后按 Linux 平台给出具体包名', async () => {
		vi.stubGlobal(
			'fetch',
			mockHealth({ runtime: 'go', container: false, os: 'linux', arch: 'amd64' })
		);
		const wrapper = await mountModal();
		const text = wrapper.text();

		expect(wrapper.get('[data-test="update-guide-deployment"]').text()).toContain(
			'Go · linux / amd64'
		);
		expect(text).toContain('go-linux-amd64.tar.gz');
		expect(text).toContain('momo-backend-linux-amd64');
		expect(text).toContain('config/config.yaml');
		expect(text).toContain('data/');
	});

	it('自动识别 Go + Docker 后只展示容器升级步骤', async () => {
		vi.stubGlobal(
			'fetch',
			mockHealth({ runtime: 'go', container: true, os: 'linux', arch: 'amd64' })
		);
		const wrapper = await mountModal();
		const text = wrapper.text();

		expect(wrapper.get('[data-test="update-guide-deployment"]').text()).toContain(
			'Docker · Go 镜像'
		);
		expect(text).toContain('docker compose pull');
		expect(text).toContain('docker compose up -d');
		expect(text).not.toContain('go-linux-amd64.tar.gz');
	});

	it('自动识别失败时给出手动选择，选择后展示对应步骤并记住', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('offline');
			})
		);
		const wrapper = await mountModal();
		expect(wrapper.find('[data-test="update-guide-manual"]').exists()).toBe(true);

		const goButton = wrapper.findAll('button').find((button) => button.text() === 'Go');
		await goButton.trigger('click');

		expect(wrapper.get('[data-test="update-guide-deployment"]').text()).toContain('手动选择');
		expect(wrapper.text()).toContain('go-linux-amd64.tar.gz / go-windows-amd64.zip');
		expect(localStorage.getItem('momo_deploy_type')).toBe('go');

		const reselectButton = wrapper
			.findAll('button')
			.find((button) => button.text() === '重新选择');
		await reselectButton.trigger('click');
		expect(wrapper.find('[data-test="update-guide-manual"]').exists()).toBe(true);
		expect(localStorage.getItem('momo_deploy_type')).toBeNull();
	});

	it('旧版后端没有 runtime 字段时回退手动选择', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({ code: 200, data: { status: 'ok', database: 'ok' } }))
		);
		const wrapper = await mountModal();
		expect(wrapper.find('[data-test="update-guide-manual"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('当前后端未返回部署方式');
	});

	it('始终展示完整文档入口', async () => {
		const wrapper = await mountModal();
		const docLinks = wrapper.findAll(`a[href="${UPDATE_DOC_URL}"]`);
		expect(docLinks.length).toBeGreaterThanOrEqual(1);
	});

	it('点击关闭按钮或按 Esc 都会抛出 close', async () => {
		const wrapper = await mountModal();
		await wrapper.get('[data-test="update-guide-close"]').trigger('click');
		expect(wrapper.emitted('close')).toHaveLength(1);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(wrapper.emitted('close')).toHaveLength(2);
	});

	it('visible=false 时不渲染浮窗内容，也不请求 /health', async () => {
		const fetchImpl = vi.fn();
		vi.stubGlobal('fetch', fetchImpl);
		const wrapper = await mountModal({ visible: false });
		expect(wrapper.find('[data-test="update-guide-modal"]').exists()).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
