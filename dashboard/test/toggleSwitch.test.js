import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 开关（toggle switch）标记的样式契约。
 *
 * 旋钮是由轨道 div 的 `after:` 伪元素画的，而绝对定位伪元素的包含块是
 * 「最近的定位祖先」，所以：
 *   1. 轨道 div 必须带 `relative`，否则伪元素会相对 `<label>` 定位——
 *      一旦标签被长文案挤压导致状态文字换行、标签变高，圆点就会跑出轨道；
 *   2. `<label>` 同样必须带 `relative`：可视隐藏的 `<input class="sr-only peer">`
 *      是绝对定位的，若它没有任何定位祖先，包含块就会变成视口（ICB），
 *      这个 1px 的隐形输入框便按「文档坐标」定位、不再随滚动容器滚动。
 *      当开关位于首屏之外（安全设置页点开开关后才出现的第二层开关就是这样），
 *      它会撑大整个文档的滚动高度，页面下方因此多出一片空白和第二条滚动条；
 *   3. 标签还必须 `shrink-0`（配合状态文字的 `whitespace-nowrap`），
 *      否则 flex 布局会把标签压窄，状态文字换行并再次触发第 1 条问题。
 *
 * 开关标记在 4 个设置页里是复制粘贴的（没有抽成组件），所以这里直接扫描源码，
 * 一次性守住全部 10 个开关。
 */
const VIEWS = ['BasicSettings', 'EmailSettings', 'SecuritySettings', 'SiteSettings'];

const sourceOf = (name) => readFileSync(resolve(__dirname, `../src/views/${name}.vue`), 'utf8');

const TRACK_PATTERN = /<div class="([^"]*\bw-11 h-6\b[^"]*)"/g;
const LABEL_PATTERN = /<label class="([^"]*)">\s*\n\s*<input type="checkbox"/g;
const STATUS_TEXT_PATTERN = /<span class="([^"]*ms-3 text-sm font-medium[^"]*)"/g;

describe.each(VIEWS)('%s 的开关样式契约', (name) => {
	const source = sourceOf(name);

	it('至少存在一个开关', () => {
		expect([...source.matchAll(LABEL_PATTERN)]).not.toHaveLength(0);
	});

	it('轨道 div 自带 relative（after 伪元素以轨道为包含块）', () => {
		const tracks = [...source.matchAll(TRACK_PATTERN)].map((match) => match[1]);
		expect(tracks.length).toBeGreaterThan(0);
		tracks.forEach((classes) => {
			expect(classes.split(/\s+/)).toContain('relative');
		});
	});

	it('标签自带 relative（sr-only 输入框不得以视口为包含块）', () => {
		const labels = [...source.matchAll(LABEL_PATTERN)].map((match) => match[1]);
		expect(labels.length).toBeGreaterThan(0);
		labels.forEach((classes) => {
			expect(classes.split(/\s+/)).toContain('relative');
		});
	});

	it('标签不参与收缩（状态文字不会被迫换行）', () => {
		const labels = [...source.matchAll(LABEL_PATTERN)].map((match) => match[1]);
		expect(labels.length).toBeGreaterThan(0);
		labels.forEach((classes) => {
			expect(classes.split(/\s+/)).toContain('shrink-0');
		});
	});

	it('状态文字保持单行', () => {
		const spans = [...source.matchAll(STATUS_TEXT_PATTERN)].map((match) => match[1]);
		expect(spans.length).toBeGreaterThan(0);
		spans.forEach((classes) => {
			expect(classes.split(/\s+/)).toContain('whitespace-nowrap');
		});
	});
});
