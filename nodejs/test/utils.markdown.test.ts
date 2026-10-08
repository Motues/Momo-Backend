import { describe, it, expect } from "vitest";
import { parseMarkdown } from "../src/utils/markdown";

describe("utils/markdown — parseMarkdown", () => {
  it("空内容返回空串", async () => {
    expect(await parseMarkdown("")).toBe("");
  });

  it("标题渲染为 h1", async () => {
    expect(await parseMarkdown("# Title")).toBe("<h1>Title</h1>\n");
  });

  it("段落 + 粗体", async () => {
    expect(await parseMarkdown("a **b** c")).toBe("<p>a <strong>b</strong> c</p>\n");
  });

  it("breaks: true —— 单个换行渲染为 <br>", async () => {
    expect(await parseMarkdown("a\nb")).toBe("<p>a<br>b</p>\n");
  });

  it("链接渲染为 <a href>", async () => {
    expect(await parseMarkdown("[x](https://a.com)")).toBe(
      '<p><a href="https://a.com">x</a></p>\n'
    );
  });

  it("图片渲染为 <img>", async () => {
    expect(await parseMarkdown("![a](b.png)")).toBe('<p><img src="b.png" alt="a"></p>\n');
  });

  it("行内代码与代码块", async () => {
    expect(await parseMarkdown("`code`")).toBe("<p><code>code</code></p>\n");
    expect(await parseMarkdown("```js\nlet x = 1;\n```")).toContain('class="language-js"');
  });

  it("引用与删除线", async () => {
    expect(await parseMarkdown("> quote")).toContain("<blockquote>");
    expect(await parseMarkdown("~~del~~")).toBe("<p><del>del</del></p>\n");
  });

  it("GFM 表格与列表", async () => {
    expect(await parseMarkdown("| a | b |\n| - | - |\n| 1 | 2 |")).toContain("<table>");
    expect(await parseMarkdown("- a\n- b")).toBe("<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n");
    expect(await parseMarkdown("1. one\n2. two")).toContain("<ol>");
  });

  it("原始 HTML 被转义（防 XSS）", async () => {
    // 块级 HTML
    expect(await parseMarkdown("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
    expect(await parseMarkdown("<div>block</div>")).toBe("&lt;div&gt;block&lt;/div&gt;");
    // 行内 HTML
    expect(await parseMarkdown("hello <b>world</b>")).toBe(
      "<p>hello &lt;b&gt;world&lt;/b&gt;</p>\n"
    );
  });

  it("尖括号与 & 被转义（引号保持原样，仍是文本节点）", async () => {
    // 行内 HTML 会被包进段落
    expect(await parseMarkdown('<a href="x">y</a>')).toBe('<p>&lt;a href="x"&gt;y&lt;/a&gt;</p>\n');
    expect(await parseMarkdown("a & b")).toBe("<p>a &amp; b</p>\n");
  });
});
