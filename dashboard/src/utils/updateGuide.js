import { compareVersions, normalizeVersion } from './version';

/**
 * 「发现新版本」浮窗的静态引导数据。
 *
 * 面板只能拿到版本号，无法知道后端实际部署方式，也不解析 Release notes，
 * 所以这里只内置「会产生数据库变更 / 需要额外迁移」的版本节点，用来告诉
 * 用户从当前版本跨到最新版本时需要留意什么。版本阈值与 doc/update.md
 * 的「数据库更新记录」保持一致，更新该文档时请同步这里。
 */

export const UPDATE_DOC_URL =
	'https://github.com/Motues/Momo-Backend/blob/main/doc/update.md';

/** 按版本从旧到新排列，浮窗按时间顺序展示升级路径 */
export const DATABASE_CHANGES = [
	{
		version: '1.3.0',
		summary: '新增 Settings 表，用于保存系统设置。',
	},
	{
		version: '1.4.0',
		summary: '新增 EmailVerification 表；Node.js 从 Prisma 迁移到 Drizzle，需要执行 Settings 表迁移脚本。',
		manual: true,
	},
	{
		version: '1.6.0',
		summary: '新增 VerifyRecord 表；人机验证升级为两层，前端、后端与评论组件需配套升级。',
	},
	{
		version: '1.6.1',
		summary: 'VerifyRecord 增加 origin 列，用于记录来源域名。',
	},
	{
		version: '1.8.0',
		summary:
			'新增 LinkSyncRequest、TrustedLink、DormantNotice、MailLog 四张表，并给 TrustedLink 增加 source 列。',
	},
];

/**
 * 根据服务端 OS / 架构选择 Go 的 Release 包。
 * 当前 release.yml 只产出 linux/windows 的 amd64 包。
 */
export function getGoReleaseTarget(os = 'unknown', arch = 'unknown') {
	const platform = String(os ?? '').trim().toLowerCase();
	const cpu = String(arch ?? '').trim().toLowerCase();

	if (cpu !== 'amd64') {
		return { supported: false, asset: '', binary: '', windows: false };
	}
	if (platform === 'windows') {
		return {
			supported: true,
			asset: 'go-windows-amd64.zip',
			binary: 'momo-backend-windows-amd64.exe',
			windows: true,
		};
	}
	if (platform === 'linux') {
		return {
			supported: true,
			asset: 'go-linux-amd64.tar.gz',
			binary: 'momo-backend-linux-amd64',
			windows: false,
		};
	}
	return { supported: false, asset: '', binary: '', windows: false };
}

/**
 * 生成当前部署方式的升级步骤。
 * 只依赖部署类型和（Go 需要的）OS / 架构，不执行任何命令。
 */
export function buildUpgradeSteps({ deployment, runtime = '', os = 'unknown', arch = 'unknown' } = {}) {
	switch (deployment) {
		case 'worker':
			return workerSteps();
		case 'node':
			return nodeSteps();
		case 'go':
			return goSteps(os, arch);
		case 'docker':
			return dockerSteps(runtime);
		default:
			return [];
	}
}

function workerSteps() {
	return [
		{
			title: '下载升级包',
			text: '从 Release 页面下载 Worker 的升级包。',
			command: 'worker.zip',
		},
		{
			title: '替换文件',
			text: '解压后覆盖旧项目中的 src、schemas、public、package.json 和 pnpm-lock.yaml。',
			note: '保留 wrangler.jsonc 和 .dev.vars；发布包里只有 wrangler.example.jsonc，它是示例，不是你的线上配置。',
		},
		{
			title: '安装依赖并部署',
			command: 'pnpm install && pnpm run deploy',
		},
		{
			title: '确认数据库',
			text: 'Worker 会在首次请求时自动迁移数据库，通常无需手工执行 SQL。',
			note: '如果部署后报数据库错误，可在 D1 控制台执行 worker/schemas/comment.sql。',
		},
	];
}

function nodeSteps() {
	return [
		{
			title: '下载升级包',
			text: '从 Release 页面下载 Node.js 的升级包。',
			command: 'nodejs.zip',
		},
		{
			title: '替换代码与静态资源',
			text: '解压后覆盖 src、public、package.json、pnpm-lock.yaml；scripts、vendor 有更新时一并替换。',
		},
		{
			title: '保留配置与数据',
			text: '保留 .env 和 data/ 数据库目录，不要用发布包覆盖。',
			note: '.env 里是端口、DATABASE_URL 等本机配置；如果改过数据库路径，以实际路径为准。',
		},
		{
			title: '安装依赖并构建',
			command: 'pnpm install && pnpm build',
		},
		{
			title: '重启进程',
			text: '用原来的方式重启，例如 pnpm start、pm2 restart 或 systemd restart。',
		},
	];
}

function goSteps(os, arch) {
	const target = getGoReleaseTarget(os, arch);
	const steps = [];

	if (target.supported) {
		steps.push({
			title: '下载升级包',
			text: '从 Release 页面下载与服务器匹配的压缩包。',
			command: target.asset,
			note: target.windows
				? 'Windows 包解压后是 go-release/ 目录。'
				: 'Linux 包解压后直接是二进制、momo.bash 和 public/。',
		});
		steps.push({
			title: '替换程序与静态资源',
			text: `替换旧的 ${target.binary} 和 public/ 目录。`,
		});
	} else {
		steps.push({
			title: '下载升级包',
			text: '当前 Release 只提供 Linux / Windows 的 amd64 包；请下载与服务器匹配的包，或按仓库文档自行编译。',
			command: 'go-linux-amd64.tar.gz / go-windows-amd64.zip',
		});
		steps.push({
			title: '替换程序与静态资源',
			text: '替换旧的二进制文件和 public/ 目录。',
		});
	}

	steps.push({
		title: '保留配置与数据',
		text: '保留 config/config.yaml 和 data/ 数据库目录，不要用发布包覆盖。',
		note: 'config/config.yaml 里是 PORT 等配置；data/ 是 SQLite 数据库。',
	});
	steps.push({
		title: '重启服务',
		text: target.windows
			? '重新启动 momo-backend-windows-amd64.exe 或对应的 Windows 服务。'
			: target.supported
				? 'Linux 可运行 ./momo.bash 重启；如果使用 systemd，执行对应的 restart 命令。'
				: '重启原来的二进制或系统服务。',
	});
	return steps;
}

function dockerSteps(runtime) {
	const note =
		runtime === 'node'
			? '官方 Docker 镜像为 Go 版；如果你使用自建 Node.js 镜像，请按自己的 Dockerfile 重新构建并替换镜像。'
			: '保留 data 卷；如还挂载了 /app/config，也一起保留。用 docker run 启动的，请用相同参数重新创建容器。';

	return [
		{
			title: '拉取新镜像',
			command: 'docker compose pull',
		},
		{
			title: '重建容器',
			command: 'docker compose up -d',
			note,
		},
		{
			title: '确认状态',
			text: '稍等片刻后检查容器状态和健康检查结果。',
			command: 'docker compose ps',
		},
	];
}

/**
 * 找出「当前版本 < 变更版本 <= 最新版本」的数据库变更。
 * latest 为空或无法解析时不做上限过滤，避免漏掉提示。
 */
export function getDatabaseChanges(currentVersion, latestVersion = '') {
	const latest = normalizeVersion(latestVersion);
	return DATABASE_CHANGES.filter((change) => {
		if (compareVersions(currentVersion, change.version) >= 0) return false;
		return !latest || compareVersions(change.version, latest) <= 0;
	});
}
