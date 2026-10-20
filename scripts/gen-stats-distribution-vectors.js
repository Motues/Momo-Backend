#!/usr/bin/env node
/**
 * 生成 `doc/vectors/stats-distribution-v1.json` —— 管理后台**数据统计页的客户端分布**口径。
 *
 * 背景：`Comment.browser` / `Comment.os` / `Comment.device` 存的是原始解析结果
 * （见 `nodejs/src/api/public/postComment.ts`）：
 *   - `os` / `browser`：`<名称> <版本号>`，例如 `Chrome 145.0.0.0`、`Windows 10`；
 *   - `device`：`model || type || vendor`，桌面端通常是空串，移动端是机型（`ABR-AL60`）。
 *
 * 直接按原值分组会让「Chrome 145」「Chrome 144」「Chrome 143」各占一档，榜单毫无信息量，
 * 而且旧版本写进库的原始 UA 字符串（`Mozilla/5.0 (…) AppleWebKit/…`）会独占榜首。
 * 因此三端在 SQL 分组之后统一做一次**归一化**：去掉版本号得到「家族名」，
 * 原始 UA 归入「未知」，设备归成「桌面 / 移动 / 平板 / 未知」四类。
 *
 * 这份 fixture 就是该归一化的验收基准：Node / Go / Worker 各自读取同一份文件复算，
 * 任何一端改了正则、去版本号的边界或设备分类的优先级都会立刻暴露
 * （三端返回不同的排行榜，同一份数据在不同部署形态下显示不同的图）。
 *
 * 运行：`node scripts/gen-stats-distribution-vectors.js`（纯 Node，零依赖）。
 */

const fs = require('fs');
const path = require('path');

/**
 * 归一化时认可的全部空白字符。
 *
 * 刻意写成**显式字符类**，而不是依赖各语言自带的「空白」概念（`\s` / `trim()`）：
 * JS 的 `\s` 含 NBSP 与 U+FEFF，Go 的 RE2 `\s` 只认 ASCII 空白、`strings.TrimSpace`
 * 又不含 U+FEFF —— 只靠语言默认口径，从导入的脏数据里就会得到不同的家族名。
 * 三端（Node / Go / Worker）必须使用同一个字符集。
 */
const WS_CLASS =
  '[ \\t\\n\\r\\f\\v\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';

/** 同时吃掉首尾空白 */
const TRIM_RE = new RegExp(`^${WS_CLASS}+|${WS_CLASS}+$`, 'g');

/** 尾部的「空白 + 以数字开头的 token」就是版本号 */
const VERSION_RE = new RegExp(`${WS_CLASS}+[0-9][0-9A-Za-z_.]*$`);

/** 旧版本 / 导入的历史数据可能是整条原始 UA，无法解析出家族名 */
const isRawUserAgent = (text) => /^Mozilla\//i.test(text) || /AppleWebKit/i.test(text);

const trimWhitespace = (text) => text.replace(TRIM_RE, '');

/** 去掉尾部版本号：`Chrome 145.0.0.0` → `Chrome`，`Mobile Safari 17.0` → `Mobile Safari` */
function stripVersion(text) {
  return trimWhitespace(text.replace(VERSION_RE, ''));
}

/** 浏览器 / 操作系统的家族名；空值与原始 UA 一律归入「未知」 */
function normalizeFamily(raw) {
  if (raw === null || raw === undefined) return '未知';
  const text = trimWhitespace(String(raw));
  if (text === '' || isRawUserAgent(text)) return '未知';
  const family = stripVersion(text);
  return family === '' ? '未知' : family;
}

/**
 * 设备类型：`device` 存的是 `model || type || vendor`。
 *
 * 判定优先级（三端必须一致）：
 *   1. 空（含 null）→ 桌面 —— ua-parser 对桌面端不下发 device，这是它的正常取值；
 *   2. 原始 UA → 未知（无法识别）；
 *   3. iPad / tablet → 平板；
 *   4. 移动关键词 → 移动（**必须排在桌面关键词之前**：`Windows Phone` 同时含 `windows` 与 `phone`，
 *      先判桌面会把它算成桌面；反过来不会误伤任何桌面取值）；
 *   5. 桌面关键词 → 桌面；
 *   6. 其余非空值是具体机型码（`ABR-AL60` / `V2507A`）→ 移动。
 *
 * 已知局限：Android 平板只留下机型（如 `Nexus 7`）时会被算作「移动」，
 * 因为此时 ua-parser 已经丢掉了 `tablet` 这个类型信息。
 */
function normalizeDevice(raw) {
  if (raw === null || raw === undefined) return '桌面';
  const text = trimWhitespace(String(raw));
  if (text === '') return '桌面';
  if (isRawUserAgent(text)) return '未知';
  if (/ipad|tablet/i.test(text)) return '平板';
  if (/mobile|android|iphone|ipod|phone/i.test(text)) return '移动';
  if (/desktop|macintosh|windows|linux|mac os|chrome os|ubuntu/i.test(text)) return '桌面';
  return '移动';
}

const RAW_UA_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const RAW_UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

const BROWSER_CASES = [
  // 正常形态：`<名称> <版本>` → 家族名
  'Chrome 145.0.0.0',
  'Mobile Chrome 122.0.0.0',
  'Edge 147.0.0.0',
  'Safari 17.0',
  'Mobile Safari 17.0',
  'Firefox 121.0',
  'Samsung Internet 23.0',
  'Chrome 142',
  // 只有名称（没有版本）时原样保留
  'Chrome',
  // 首尾空白要吃掉
  '  Chrome 120.0.0.0  ',
  'Mobile Safari  17.0  ',
  // 空白口径必须三端一致：NBSP / 表意空格 / 细空格 / BOM 都要能吃掉。
  // 这里刻意不用语言自带的 \s / trim()（JS 与 Go 的集合不同），而用显式字符类。
  'Chrome\u00a0120.0.0.0',
  '\ufeffChrome 120.0.0.0\u3000',
  'Chrome\u2009120.0.0.0',
  '\u00a0',
  // 空值 / 纯空白 / null → 未知
  '',
  '   ',
  null,
  // 历史脏数据：整条原始 UA → 未知，而不是拿 UA 去截版本号
  RAW_UA_EDGE,
  RAW_UA_IPHONE,
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  // 名称末尾自带数字但不能被当成版本号切掉的情况：只切「空格 + 数字开头」的 token
  'Opera 9.80',
];

const OS_CASES = [
  'Windows 10',
  'Windows 10.0',
  'Windows 11',
  'macOS 10.15.7',
  'iOS 17.7.2',
  'Android 10',
  'Android 12',
  'HarmonyOS ',
  'Ubuntu',
  'Linux',
  'Chrome OS 120.0.0.0',
  // 同上：空白口径按显式字符集处理
  'Windows\u00a010',
  '\u3000macOS 10.15.7',
  '',
  null,
  RAW_UA_EDGE,
];

const DEVICE_CASES = [
  // 空 = 桌面（ua-parser 桌面端不下发 device）
  null,
  '',
  '   ',
  // 纯空白（含 NBSP / BOM）同样算空值
  '\u00a0',
  '\ufeff',
  // 桌面关键词
  'Desktop',
  'Macintosh',
  'Windows 10',
  // 平板（优先级高于桌面关键词）
  'iPad',
  'tablet',
  'Tablet',
  'iPad\u00a0',
  // 移动关键词
  'iPhone',
  'mobile',
  'Android 13',
  'Windows Phone',
  // 只有机型码：无法识别品牌时也算移动
  'ABR-AL60',
  'V2507A',
  'SM-G991B',
  'K',
  // 原始 UA → 未知
  RAW_UA_EDGE,
];

const cases = (values, normalize) => values.map((raw) => ({ raw, expected: normalize(raw) }));

const fixture = {
  version: 1,
  generatedBy: 'scripts/gen-stats-distribution-vectors.js',
  description:
    '数据统计页客户端分布（设备 / 浏览器 / 操作系统）的归一化口径：原始值 → 展示用家族名。',
  rules: {
    whitespace:
      '首尾空白按**显式字符集**去除（ASCII 空白 + NBSP + U+1680 + U+2000-U+200A + U+2028/9 + U+202F + U+205F + U+3000 + U+FEFF）；' +
      '版本号前的分隔空白也用同一集合。刻意不用各语言的 \\s / trim()：JS 与 Go 的空白集合不同（Go RE2 的 \\s 只认 ASCII、TrimSpace 不含 U+FEFF）',
    versionSuffix: '去掉尾部「空白集 + 以数字开头的 token」；其余部分 trim 后即为家族名',
    rawUserAgent: '以 Mozilla/ 开头或含 AppleWebKit 的值判为历史脏数据 → 未知',
    empty: 'null / 空串 / 纯空白 → 浏览器与操作系统为「未知」，设备为「桌面」',
    deviceOrder: ['原始UA→未知', 'iPad|tablet→平板', '移动关键词→移动', '桌面关键词→桌面', '其余机型码→移动'],
    deviceEmpty: '设备的空值视为桌面：ua-parser 对桌面端就是不下发 device',
  },
  browser: cases(BROWSER_CASES, normalizeFamily),
  os: cases(OS_CASES, normalizeFamily),
  device: cases(DEVICE_CASES, normalizeDevice),
};

const target = path.join(__dirname, '..', 'doc', 'vectors', 'stats-distribution-v1.json');
fs.writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

console.log(`已写入 ${path.relative(process.cwd(), target)}`);
console.log(JSON.stringify({ browser: fixture.browser, os: fixture.os, device: fixture.device }, null, 2));
