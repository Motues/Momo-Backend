import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 深色模式的回归守卫。
 *
 * `src/style/main.css` 是**普通 CSS**（main.ts 直接 import，由 Vite 输出），
 * 不是 Svelte `<style>` —— 在这里写 `:global(...)` 会原样进产物，浏览器当作未知伪类，
 * 整个选择器块被丢弃：深色默认值（白字 / 深色边框）曾经因此从未生效。
 */
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
/** 去掉注释再断言，避免「注释里提到 :global(」也被判成违规 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const rawCss = read('../src/style/main.css');
const css = stripComments(rawCss);
const picker = read('../src/emoji/EmojiPicker.svelte');

describe('主题样式 —— 深色模式', () => {
	it('普通 CSS 里不出现 Svelte 的 :global(...)（否则整条规则会被浏览器丢弃）', () => {
		expect(css).not.toContain(':global(');
		expect(css).toMatch(/\[data-theme="dark"\]\s+\.comment-container\s*\{/);
	});

	it('深色默认值给出可读的浅色文字、深色边框与亮色链接', () => {
		const dark = css.slice(css.indexOf('[data-theme="dark"]'));
		expect(dark).toContain('--text-color: var(--momo-text-color, #ffffff)');
		expect(dark).toContain('--button-border-color: var(--momo-button-border-color, #3d3d3d)');
		expect(dark).toContain('--button-hover-bg-color: var(--momo-button-hover-bg-color, #262626)');
		expect(dark).toContain('--link-color: var(--momo-link-color, #57ace7)');
	});

	it('浅色默认值仍是深色文字（深色规则不能反过来污染浅色）', () => {
		expect(css).toContain('--text-color: var(--momo-text-color, #000000)');
	});
});

describe('主题样式 —— 无感验证成功态（绿色跟随浅色 / 深色）', () => {
	it('浅色与深色各给一套绿色，宿主可用 --momo-verify-success-* 覆盖', () => {
		expect(css).toContain('--verify-success-color: var(--momo-verify-success-color, #15803d)');
		expect(css).toContain(
			'--verify-success-border-color: var(--momo-verify-success-border-color, rgba(22, 163, 74, 0.5))',
		);
		const dark = css.slice(css.indexOf('[data-theme="dark"]'));
		expect(dark).toContain('--verify-success-color: var(--momo-verify-success-color, #4ade80)');
		expect(dark).toContain(
			'--verify-success-border-color: var(--momo-verify-success-border-color, rgba(74, 222, 128, 0.45))',
		);
	});

	it('没有主题标记时跟随系统深色，且 data-theme="light" 能锁回浅色', () => {
		const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
		expect(media).not.toBe('');
		expect(media).toMatch(/\.comment-container\s*\{[\s\S]*?--verify-success-color/);
		expect(media).toContain('[data-theme="light"] .comment-container');
	});

	it('组件改用主题变量上色，不再写死单一 tailwind 绿', () => {
		const verify = read('../src/verify/SilentVerify.svelte');
		expect(verify).toContain('.verify-success');
		expect(verify).toContain('color: var(--verify-success-color, #15803d)');
		expect(verify).toContain('border-color: var(--verify-success-border-color, rgba(22, 163, 74, 0.5))');
		// 用正则而不是字面量：Tailwind 会扫描源码里的类名候选，字面量会把废弃的绿色类打进产物
		expect(verify).not.toMatch(/text-green-6\d\d/);
		expect(verify).not.toMatch(/dark:text-green-4\d\d/);
	});
});

describe('主题样式 —— 表情面板（portal 到 body 后的文字颜色）', () => {
	it('面板根节点显式落 color：自定义属性会随内联样式搬走，继承的 color 不会', () => {
		expect(picker).toMatch(/\.emoji-panel\s*\{[\s\S]*?color:\s*var\(--text-color\)/);
	});

	it('颜文字（文本表情）与兜底文本自己带文字色，不依赖宿主 body 的 color', () => {
		// 颜文字按钮
		expect(picker).toMatch(/emoji-text-item[^"]*text-\[var\(--text-color\)\]/);
		// 图片包里的兜底字符（没有 shortcode 的分支）
		expect(picker).toMatch(/<span class="text-base leading-none text-\[var\(--text-color\)\]">/);
	});
});
