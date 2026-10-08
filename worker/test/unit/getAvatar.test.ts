/**
 * src/utils/getAvatar.ts —— Cravatar 头像地址生成（MD5）。
 *
 * 说明：Cloudflare Workers 的 WebCrypto 支持非标准的 MD5，因此这里可以直接断言真实哈希；
 * 若哪天运行时去掉了 MD5，本文件会立刻失败（getComments 的 try/catch 会把失败吞成空头像）。
 */
import { describe, it, expect } from 'vitest';
import { getCravatar } from '../../src/utils/getAvatar';

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

describe('getCravatar', () => {
	it('固定邮箱的 MD5 与 URL 完全可复现', async () => {
		// MD5('a@b.c') 已用独立工具（PowerShell Get-FileHash）核对
		expect(await getCravatar('a@b.c')).toBe(url('5d60d4e28066df254d5452f92c910092'));
	});

	it('邮箱会被去空格并转小写', async () => {
		const expected = url(await md5Hex('alice@example.com'));
		expect(await getCravatar('  Alice@Example.COM  ')).toBe(expected);
		expect(await getCravatar('ALICE@EXAMPLE.COM')).toBe(expected);
	});

	it('URL 模板为 cravatar + beam 变体', async () => {
		const result = await getCravatar('someone@example.com');
		expect(result).toMatch(/^https:\/\/open\.motues\.top\/avatar\?name=[0-9a-f]{32}&mode=cravatar&variant=beam$/);
	});

	it('不同邮箱得到不同哈希', async () => {
		expect(await getCravatar('a@example.com')).not.toBe(await getCravatar('b@example.com'));
	});

	it('空字符串仍然产出 32 位十六进制哈希', async () => {
		expect(await getCravatar('')).toBe(url(await md5Hex('')));
	});

	it('非 ASCII 邮箱按 UTF-8 字节哈希', async () => {
		const result = await getCravatar('中文@example.com');
		expect(result).toBe(url(await md5Hex('中文@example.com')));
	});

	it('哈希恒为 32 位小写十六进制', async () => {
		const hash = (await getCravatar('probe@example.com')).match(/name=([0-9a-f]+)/)?.[1];
		expect(hash).toHaveLength(32);
	});
});
