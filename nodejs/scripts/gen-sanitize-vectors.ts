#!/usr/bin/env node
/**
 * 生成「文章标识净化 + 截断」的跨语言固定向量
 *
 * 为什么需要：post_slug 会被签进挑战载荷，签发端与校验端（以及三套后端之间）
 * 只要净化或截断口径有一点差异，就会出现「同一篇文章的挑战兑换自己的票据却被拒」
 * 或「签出的票据永远兑不掉」的假失败。把输入→输出钉死，任何一端漂移都会被测试抓住。
 *
 * 生成口径刻意**独立复算**（不调用实现），这样 fixture 同时是对实现的一次复核。
 *
 * 用法（在 nodejs 目录下）:
 *   npx ts-node scripts/gen-sanitize-vectors.ts
 */

import fs from "fs";
import path from "path";

/** 与三端实现逐条对齐的规则序列（独立复算副本） */
function checkContentLocal(content: string): string {
  if (!content) return content;
  return content
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, "")
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:href|src|action|formaction)\s*=\s*"(?:javascript|vbscript):[^"]*"/gi, "")
    .replace(/(?:href|src|action|formaction)\s*=\s*'(?:javascript|vbscript):[^']*'/gi, "")
    .replace(/(?:href|src|action|formaction)\s*=\s*(?:javascript|vbscript):[^\s>"]+/gi, "")
    .replace(/(?:javascript|vbscript):\s*/gi, "")
    .replace(/<\/?(?:iframe|object|embed|frame|link|base|form|input|meta)\b[^>]*>/gi, "");
}

/** 按 Unicode 码点截断（独立复算副本） */
function truncateCodePointsLocal(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

const MAX = 200;

/** 内容净化用例（覆盖三端必须共同遵守的每一条规则） */
const checkContentCases: Array<[string, string]> = [
  ["script 块与内容", "<script>alert(1)</script>hello"],
  ["style 块与内容", "<style>body{}</style>ok"],
  ["事件处理器属性（双引号）", '<a onclick="evil()">x</a>'],
  ["事件处理器属性（无引号）", "<img src=x onerror=alert(1)>"],
  ["javascript: 属性（双引号）", '<a href="javascript:alert(1)">x</a>'],
  ["javascript: 属性（单引号）", "<a href='javascript:alert(1)'>x</a>"],
  ["javascript: 属性（无引号）", "<a href=javascript:alert(1)>x</a>"],
  ["vbscript: 属性（双引号）", '<a href="vbscript:msgbox(1)">x</a>'],
  ["formaction 属性", '<button formaction="javascript:alert(1)">x</button>'],
  ["大小写混写", '<a HREF="JaVaScRiPt:alert(1)">x</a>'],
  ["独立 javascript: 文本", "see javascript:alert(1) here"],
  ["独立 vbscript: 文本", "vbscript:msgbox(1)"],
  ["危险标签：iframe", '<iframe src="x"></iframe>ok'],
  ["危险标签：form + input", '<form action="/x"><input></form>ok'],
  ["危险标签：meta / link / base", '<meta charset="x"><link rel="x"><base href="/">ok'],
  ["组合攻击", '<iframe src="javascript:alert(1)"></iframe><a href="javascript:x">y</a>'],
  ["未闭合的 script（块规则需要闭合标签，因此不匹配）", "<script>alert(1)"],
  ["普通文章标识（必须是无操作路径）", "/posts/hello-world"],
  ["中文文章标识（必须是无操作路径）", "/文章/2024/标题"],
  ["空串", ""],
];

/** 截断用例（含 UTF-16 码元与码点的差异边界） */
const truncateCases: Array<[string, string]> = [
  ["200 个 ASCII", "a".repeat(200)],
  ["201 个 ASCII", "a".repeat(201)],
  ["300 个 ASCII", "a".repeat(300)],
  ["200 个中文（=600 字节）", "中".repeat(200)],
  ["201 个中文（=603 字节，按字节截会切坏）", "中".repeat(201)],
  ["200 个 emoji（=400 个 UTF-16 码元）", "😀".repeat(200)],
  ["201 个 emoji", "😀".repeat(201)],
  ["199 个 ASCII + 1 个 emoji（=201 码元、200 码点）", "a".repeat(199) + "😀"],
  ["199 个 ASCII + emoji + 尾巴（必须切在 emoji 之后）", "a".repeat(199) + "😀" + "TAIL"],
  ["净化后再截断（script 块 + 210 个中文）", "<script>x</script>" + "中".repeat(210)],
  ["前缀 + emoji 刚好到边界", "/posts/" + "😀".repeat(200)],
  ["普通短标识", "/posts/hello-world"],
  ["空串", ""],
];

const payload = {
  _comment:
    "由 nodejs/scripts/gen-sanitize-vectors.ts 生成，请勿手工编辑。" +
    "post_slug 的净化与截断口径（Node / Go / Worker 三端必须完全一致）。" +
    "maxPostSlug 的单位是 Unicode 码点，不是 UTF-16 码元、也不是字节。",
  maxPostSlug: MAX,
  checkContent: checkContentCases.map(([name, input]) => ({
    name,
    input,
    output: checkContentLocal(input),
  })),
  sanitizePostSlug: truncateCases.map(([name, input]) => ({
    name,
    input,
    output: truncateCodePointsLocal(checkContentLocal(input), MAX),
  })),
};

const outPath = path.resolve(__dirname, "..", "..", "doc", "vectors", "sanitize-v2.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");

console.log(`[gen-sanitize-vectors] 已写入 ${path.relative(process.cwd(), outPath)}`);
console.log(`  checkContent 用例 ${payload.checkContent.length} 条，截断用例 ${payload.sanitizePostSlug.length} 条`);
for (const c of payload.sanitizePostSlug) {
  const cp = Array.from(c.output).length;
  const units = c.output.length;
  const bytes = Buffer.byteLength(c.output, "utf8");
  console.log(`  ${c.name}: 码点=${cp} 码元=${units} 字节=${bytes}`);
}
