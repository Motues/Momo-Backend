import { describe, it, expect } from 'vitest';
import { parseMarkdown, validateMarkdown } from '../src/utils/markdown';

describe('parseMarkdown —— 空值/空白输入', () => {
	it('空字符串返回空串', () => {
		expect(parseMarkdown('')).toBe('');
	});

	it('只有空白字符返回空串', () => {
		expect(parseMarkdown('   ')).toBe('');
		expect(parseMarkdown('\n\t ')).toBe('');
	});

	it('undefined / null 等假值返回空串，不抛错', () => {
		expect(parseMarkdown(undefined)).toBe('');
		expect(parseMarkdown(null)).toBe('');
		expect(parseMarkdown(0)).toBe('');
	});
});

describe('parseMarkdown —— 基础语法', () => {
	it('标题：h1', () => {
		expect(parseMarkdown('# Title')).toBe('<h1>Title</h1>\n');
	});

	it('标题：h2', () => {
		expect(parseMarkdown('## 二级标题')).toBe('<h2>二级标题</h2>\n');
	});

	it('粗体', () => {
		expect(parseMarkdown('**bold**')).toBe('<p><strong>bold</strong></p>\n');
	});

	it('斜体', () => {
		expect(parseMarkdown('*italic*')).toBe('<p><em>italic</em></p>\n');
	});

	it('粗体 + 斜体嵌套', () => {
		expect(parseMarkdown('***both***')).toBe('<p><em><strong>both</strong></em></p>\n');
	});

	it('删除线（GFM）', () => {
		expect(parseMarkdown('~~del~~')).toBe('<p><del>del</del></p>\n');
	});

	it('链接', () => {
		expect(parseMarkdown('[link](https://e.com)')).toBe('<p><a href="https://e.com">link</a></p>\n');
	});

	it('图片', () => {
		expect(parseMarkdown('![img](https://e.com/a.png)')).toBe(
			'<p><img src="https://e.com/a.png" alt="img"></p>\n'
		);
	});

	it('裸链接自动识别（GFM autolink）', () => {
		expect(parseMarkdown('https://e.com')).toBe(
			'<p><a href="https://e.com">https://e.com</a></p>\n'
		);
	});

	it('围栏代码块带语言标记', () => {
		expect(parseMarkdown('```js\nconst a = 1;\n```')).toBe(
			'<pre><code class="language-js">const a = 1;\n</code></pre>\n'
		);
	});

	it('未闭合的围栏代码块也能产出 pre/code（不抛错）', () => {
		const out = parseMarkdown('```\ncode');
		expect(out).toContain('<pre>');
		expect(out).toContain('code');
	});

	it('行内代码', () => {
		expect(parseMarkdown('inline `code` here')).toBe('<p>inline <code>code</code> here</p>\n');
	});

	it('引用块', () => {
		const out = parseMarkdown('> quote');
		expect(out).toContain('<blockquote>');
		expect(out).toContain('quote');
	});

	it('无序列表', () => {
		expect(parseMarkdown('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');
	});

	it('有序列表', () => {
		const out = parseMarkdown('1. a\n2. b');
		expect(out).toContain('<ol>');
		expect(out).toContain('<li>a</li>');
	});

	it('任务列表渲染成 checkbox 且默认 disabled', () => {
		const out = parseMarkdown('- [ ] done');
		expect(out).toContain('type="checkbox"');
		expect(out).toContain('disabled');
		expect(out).toContain('done');
	});

	it('表格（GFM）', () => {
		const out = parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
		expect(out).toContain('<table>');
		expect(out).toContain('<th>a</th>');
		expect(out).toContain('<td>1</td>');
	});

	it('单个换行变成 <br>（breaks: true）', () => {
		expect(parseMarkdown('line1\nline2')).toBe('<p>line1<br>line2</p>\n');
	});

	it('中文段落原样保留', () => {
		expect(parseMarkdown('中文段落')).toBe('<p>中文段落</p>\n');
	});
});

describe('parseMarkdown —— HTML 处理（转义而非透传）', () => {
	it('原始 <script> 被转义，输出中不含可执行的 script 标签', () => {
		const out = parseMarkdown('<script>alert(1)</script>');
		expect(out).not.toContain('<script');
		expect(out).toContain('&lt;script&gt;');
	});

	it('行内原始 HTML 标签被转义', () => {
		expect(parseMarkdown('<b>raw html</b>')).toBe('<p>&lt;b&gt;raw html&lt;/b&gt;</p>\n');
	});

	it('<br> 也被转义（HTML 透传被禁用）', () => {
		expect(parseMarkdown('a<br>b')).toBe('<p>a&lt;br&gt;b</p>\n');
	});

	it('& < > 特殊字符被正确转义', () => {
		expect(parseMarkdown('&amp; & < >')).toBe('<p>&amp; &amp; &lt; &gt;</p>\n');
	});

	it('img onerror 这类事件属性同样被转义，不会形成真实标签', () => {
		const out = parseMarkdown('<img src=x onerror="alert(1)">');
		expect(out).not.toContain('<img');
		expect(out).toContain('&lt;img');
	});
});

describe('parseMarkdown —— 安全性说明（需配合 DOMPurify）', () => {
	it('parseMarkdown 自身不清理 javascript: 链接，渲染层必须再过 DOMPurify', () => {
		// 记录现状：markdown 解析不做 URI 白名单，组件里靠 DOMPurify.sanitize 兜底
		const out = parseMarkdown('[x](javascript:alert(1))');
		expect(out).toContain('javascript:alert(1)');
	});
});

describe('parseMarkdown —— 超长/异常输入', () => {
	it('20 万字符输入不抛错且产出对应长度', () => {
		const input = '# h\n\n' + 'x'.repeat(200000);
		const out = parseMarkdown(input);
		expect(typeof out).toBe('string');
		expect(out.length).toBeGreaterThan(200000);
	});

	it('大量空行不抛错', () => {
		expect(() => parseMarkdown('\n'.repeat(5000))).not.toThrow();
	});

	it('连续调用结果稳定（marked 配置不会被污染）', () => {
		const input = '# T\n\n**b**';
		expect(parseMarkdown(input)).toBe(parseMarkdown(input));
	});
});

describe('validateMarkdown —— 代码围栏检测', () => {
	it('空串无告警', () => {
		expect(validateMarkdown('')).toEqual([]);
	});

	it('普通文本无告警', () => {
		expect(validateMarkdown('plain')).toEqual([]);
	});

	it('未闭合的三反引号报 codeFence', () => {
		expect(validateMarkdown('```\ncode')).toEqual(['codeFence']);
	});

	it('成对的三反引号无告警', () => {
		expect(validateMarkdown('```\ncode\n```')).toEqual([]);
	});

	it('5 个反引号按奇数处理，报 codeFence', () => {
		expect(validateMarkdown('`````')).toEqual(['codeFence']);
	});

	it('6 个反引号是偶数，且整行被视为围栏起始，无告警', () => {
		expect(validateMarkdown('``````')).toEqual([]);
	});

	it('行尾 5 个反引号：既报 codeFence 又报 inlineCode', () => {
		expect(validateMarkdown('a`````')).toEqual(['codeFence', 'inlineCode']);
	});

	it('三行三反引号：奇数 -> codeFence', () => {
		expect(validateMarkdown('```\n```\n```')).toEqual(['codeFence']);
	});
});

describe('validateMarkdown —— 行内反引号检测', () => {
	it('未闭合的行内反引号报 inlineCode', () => {
		expect(validateMarkdown('a ` b')).toEqual(['inlineCode']);
	});

	it('成对的行内反引号无告警', () => {
		expect(validateMarkdown('a `b` c')).toEqual([]);
	});

	it('单个反引号报 inlineCode', () => {
		expect(validateMarkdown('`')).toEqual(['inlineCode']);
	});

	it('围栏内部的单反引号不计入（不会误报）', () => {
		expect(validateMarkdown('```js\n`a`\n```')).toEqual([]);
	});

	it('围栏外部残留的单反引号仍会被检出', () => {
		expect(validateMarkdown('```\nx\n```\n`y')).toEqual(['inlineCode']);
	});

	it('不在一行开头的三反引号会同时触发两种告警', () => {
		expect(validateMarkdown('a ``` b')).toEqual(['codeFence', 'inlineCode']);
	});

	it('多个未闭合反引号为奇数时只报一次 inlineCode', () => {
		expect(validateMarkdown('`a`b`')).toEqual(['inlineCode']);
	});
});

describe('validateMarkdown —— 返回值契约', () => {
	it('返回值只会是 codeFence / inlineCode 两种代码', () => {
		const all = ['', '`', '```', 'a ``` b', '```\n```\n`', 'x'].flatMap((s) => validateMarkdown(s));
		for (const w of all) expect(['codeFence', 'inlineCode']).toContain(w);
	});

	it('每次返回新数组，外部修改不会污染下一次调用', () => {
		const first = validateMarkdown('`');
		first.push('hacked');
		expect(validateMarkdown('`')).toEqual(['inlineCode']);
	});

	it('告警顺序固定：codeFence 在 inlineCode 之前', () => {
		expect(validateMarkdown('a ``` b')).toEqual(['codeFence', 'inlineCode']);
	});

	it('超长输入不抛错', () => {
		expect(() => validateMarkdown('`'.repeat(10001))).not.toThrow();
	});
});
