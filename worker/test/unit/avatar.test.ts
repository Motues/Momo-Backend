/**
 * src/utils/avatar.ts —— 头像地址生成（Worker 侧用 WebCrypto 的 MD5）。
 *
 * 说明：Cloudflare Workers 的 WebCrypto 支持非标准的 MD5，因此这里可以直接断言真实哈希；
 * 若哪天运行时去掉了 MD5，本文件会立刻失败（getComments 的兜底会把失败吞成空头像）。
 */
import { describe, it, expect } from 'vitest';
import { buildAvatarUrl, resolveAvatarConfig } from '../../src/utils/avatar';

/** 独立复算 MD5，避免与实现共用同一条代码路径 */
async function md5Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function url(hash: string): string {
	return `https://open.motues.top/avatar?name=${hash}&mode=cravatar&variant=beam`;
}

/** 默认源（历史行为）：整页评论复用同一份解析后的配置 */
const DEFAULT_CONFIG = resolveAvatarConfig(null, null);

const build = (email: string, author = '', config = DEFAULT_CONFIG) =>
	buildAvatarUrl(config, email, author);

describe('avatar — buildAvatarUrl（默认源）', () => {
	it('固定邮箱的 MD5 与 URL 完全可复现', async () => {
		// MD5('a@b.c') 已用独立工具（PowerShell Get-FileHash）核对
		expect(await build('a@b.c')).toBe(url('5d60d4e28066df254d5452f92c910092'));
	});

	it('邮箱会被去空格并转小写', async () => {
		const expected = url(await md5Hex('alice@example.com'));
		expect(await build('  Alice@Example.COM  ')).toBe(expected);
		expect(await build('ALICE@EXAMPLE.COM')).toBe(expected);
	});

	it('URL 模板为 cravatar + beam 变体', async () => {
		const result = await build('someone@example.com');
		expect(result).toMatch(/^https:\/\/open\.motues\.top\/avatar\?name=[0-9a-f]{32}&mode=cravatar&variant=beam$/);
	});

	it('不同邮箱得到不同哈希', async () => {
		expect(await build('a@example.com')).not.toBe(await build('b@example.com'));
	});

	it('空字符串仍然产出 32 位十六进制哈希', async () => {
		expect(await build('')).toBe(url(await md5Hex('')));
	});

	it('非 ASCII 邮箱按 UTF-8 字节哈希', async () => {
		const result = await build('中文@example.com');
		expect(result).toBe(url(await md5Hex('中文@example.com')));
	});

	it('哈希恒为 32 位小写十六进制', async () => {
		const hash = (await build('probe@example.com')).match(/name=([0-9a-f]+)/)?.[1];
		expect(hash).toHaveLength(32);
	});
});

describe('avatar — buildAvatarUrl（自定义来源，doc/avatar.md）', () => {
	it('gravatar 预设', async () => {
		expect(await build('test@example.com', '', resolveAvatarConfig('gravatar', ''))).toBe(
			'https://gravatar.com/avatar/55502f40dc8b7c769880b10874abc9d0?s=200&d=identicon'
		);
	});

	it('qq 预设：QQ 邮箱使用 qlogo 地址', async () => {
		expect(await build('12345@qq.com', '', resolveAvatarConfig('qq', ''))).toBe(
			'https://q1.qlogo.cn/g?b=qq&nk=12345&s=100'
		);
	});

	it('qq 预设：非 QQ 邮箱回落默认源', async () => {
		expect(await build('a@b.c', '', resolveAvatarConfig('qq', ''))).toBe(
			url('5d60d4e28066df254d5452f92c910092')
		);
	});

	it('自定义模板支持 {author} 与 percent-encode', async () => {
		const config = resolveAvatarConfig(
			'custom',
			'https://cdn.example.com/{hash}/{author}?mail={email}'
		);
		expect(await build('a+b@example.com', '张 三', config)).toBe(
			'https://cdn.example.com/4709dfd443b6cca9b5a01b3324124203/%E5%BC%A0%20%E4%B8%89?mail=a%2Bb%40example.com'
		);
	});

	it('非法自定义模板在读取时回落默认源', async () => {
		expect(await build('a@b.c', '', resolveAvatarConfig('custom', 'javascript:alert(1)'))).toBe(
			url('5d60d4e28066df254d5452f92c910092')
		);
	});
});
