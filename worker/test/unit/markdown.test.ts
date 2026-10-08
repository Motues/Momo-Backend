/**
 * src/utils/markdown.ts —— markdown 渲染与二次净化。
 *
 * 安全关键点：marked 的 html renderer 被覆写为转义原始 HTML，
 * 之后 sanitizeHtml 再把 javascript:/vbscript:/data: 链接改成 href="#"。
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdown, sanitizeHtml } from '../../src/utils/markdown';

describe('parseMarkdown —— 基础语法', () => {
	it('空内容返回空串', () => {
		expect(parseMarkdown('')).toBe('');
	});

	it('段落 / 粗体 / 斜体', () => {
		expect(parseMarkdown('hello')).toBe('<p>hello</p>\n');
		expect(parseMarkdown('**bold**')).toBe('<p><strong>bold</strong></p>\n');
		expect(parseMarkdown('*italic*')).toBe('<p><em>italic</em></p>\n');
	});

	it('启用 GFM 表格', () => {
		const html = parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
		expect(html).toContain('<table>');
		expect(html).toContain('<th>a</th>');
		expect(html).toContain('<td>1</td>');
	});

	it('启用 breaks（单个换行渲染为 <br>）', () => {
		expect(parseMarkdown('a\nb')).toBe('<p>a<br>b</p>\n');
	});

	it('引用与有序 / 无序列表', () => {
		expect(parseMarkdown('> quote')).toBe('<blockquote>\n<p>quote</p>\n</blockquote>\n');
		expect(parseMarkdown('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');
		expect(parseMarkdown('1. one\n2. two')).toBe('<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n');
	});

	it('围栏代码块保留语言标记', () => {
		expect(parseMarkdown('```js\nconst a=1\n```')).toBe(
			'<pre><code class="language-js">const a=1\n</code></pre>\n'
		);
	});

	it('行内代码中的 HTML 被转义', () => {
		expect(parseMarkdown('`<b>`')).toContain('&lt;b&gt;');
	});
});

describe('parseMarkdown —— 原始 HTML 被转义', () => {
	it('script 标签不会以标签形式存活', () => {
		const html = parseMarkdown('<script>alert(1)</script>');
		expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toContain('<script>');
	});

	it('带事件属性的标签整体被转义', () => {
		const html = parseMarkdown('<img src=x onerror=alert(1)>');
		expect(html).toBe('&lt;img src=x onerror=alert(1)&gt;');
		expect(html).not.toContain('<img');
	});

	it('块级 HTML 同样被转义', () => {
		const html = parseMarkdown('<div onclick="x">hi</div>');
		expect(html).toBe('&lt;div onclick="x"&gt;hi&lt;/div&gt;');
	});

	it('& < > 被正确转义', () => {
		expect(parseMarkdown('<a>')).toBe('&lt;a&gt;');
		expect(parseMarkdown('a & b')).toContain('&amp;');
	});
});

describe('parseMarkdown —— 危险链接被替换', () => {
	it('javascript: 链接被改成 href="#"', () => {
		const html = parseMarkdown('[x](javascript:alert(1))');
		expect(html).toBe('<p><a href="#">x</a></p>\n');
		expect(html).not.toContain('javascript:');
	});

	it('data: 图片地址被改写（不残留 data: 协议）', () => {
		const html = parseMarkdown('![i](javascript:alert(1))');
		expect(html).not.toContain('javascript:');
		expect(html).toContain('href="#"');
	});

	it('正常 https 链接保持原样', () => {
		expect(parseMarkdown('[x](https://ok.com)')).toBe('<p><a href="https://ok.com">x</a></p>\n');
	});
});

describe('sanitizeHtml', () => {
	it('双引号形式：href/src/action/formaction 的 javascript/vbscript/data 被替换', () => {
		expect(sanitizeHtml('<a href="data:text/html,x">y</a>')).toBe('<a href="#">y</a>');
		expect(sanitizeHtml('<a href="javascript:alert(1)">y</a>')).toBe('<a href="#">y</a>');
		expect(sanitizeHtml('<form action="vbscript:x">y</form>')).toBe('<form href="#">y</form>');
	});

	it('单引号形式被替换', () => {
		expect(sanitizeHtml("<a href='vbscript:x'>y</a>")).toBe("<a href='#'>y</a>");
	});

	it('无引号形式被替换', () => {
		expect(sanitizeHtml('<a href=javascript:alert(1)>y</a>')).toBe('<a href="#">y</a>');
	});

	it('大小写不敏感', () => {
		expect(sanitizeHtml('<a HREF="JavaScript:alert(1)">y</a>')).toBe('<a href="#">y</a>');
	});

	it('安全 HTML 原样返回', () => {
		expect(sanitizeHtml('<p>hello</p>')).toBe('<p>hello</p>');
		expect(sanitizeHtml('<a href="https://a.com?x=data:y">y</a>')).toBe(
			'<a href="https://a.com?x=data:y">y</a>'
		);
	});
});
