#!/usr/bin/env node
/**
 * HashWX 内联模块生成脚本
 *
 * 把 vendor/hashwx/hashwx.wasm 转成 src/verify/hashwxWasm.ts。
 *
 * 为什么必须内联：本包以单个 IIFE 文件（dist/momo-comment.min.js）通过 CDN 分发，
 * 没有资源管线可挂载外部 .wasm；内联后 CDN 用法和本地编译产物行为完全一致。
 * 代价是 npm 包内同时保留 vendor/ 目录与 LGPL 许可证文本（见 package.json 的 files）。
 *
 * 使用方法:
 *   node scripts/vendor-hashwx.js
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'vendor', 'hashwx');
const WASM_PATH = path.join(VENDOR_DIR, 'hashwx.wasm');
const COMMIT_PATH = path.join(VENDOR_DIR, 'hashwx-COMMIT.txt');
const OUT_PATH = path.join(ROOT, 'src', 'verify', 'hashwxWasm.ts');

/** 与 vendor/hashwx/README.md、nodejs/scripts/vendor-hashwx.js 保持一致 */
const EXPECTED_SHA256 = 'b1a0dbb3ef444d3c7069e0a5e0a0273ffa4cf8fef62cbbe43761c02f7cd6aff5';

const CHUNK = 96;

function fail(message) {
	console.error(`[vendor-hashwx] ${message}`);
	process.exit(1);
}

if (!fs.existsSync(WASM_PATH)) fail(`找不到 ${WASM_PATH}`);
if (!fs.existsSync(COMMIT_PATH)) fail(`找不到 ${COMMIT_PATH}`);

const wasm = fs.readFileSync(WASM_PATH);
const commit = fs.readFileSync(COMMIT_PATH, 'utf8').trim();
const digest = crypto.createHash('sha256').update(wasm).digest('hex');

if (digest !== EXPECTED_SHA256) {
	fail(
		`sha256 与脚本内记录的不一致，已中止。\n  实际: ${digest}\n  预期: ${EXPECTED_SHA256}\n` +
			'如果这是有意的升级，请同步更新脚本内的 EXPECTED_SHA256、vendor/hashwx/README.md，并重跑官方 KAT。'
	);
}

const base64 = wasm.toString('base64');
const chunks = [];
for (let i = 0; i < base64.length; i += CHUNK) {
	chunks.push(`  "${base64.slice(i, i + CHUNK)}"`);
}

const output = `/**
 * 本文件由 scripts/vendor-hashwx.js 生成，请勿手工编辑。
 *
 * 上游: https://github.com/tevador/hashwx @ ${commit}（v1.0.0）
 * 许可: LGPL-3.0，完整文本见 vendor/hashwx/hashwx-LICENSE.txt
 * 构建: 上游 Emscripten 构建，WebAssembly 1.0（MVP）
 * sha256: ${digest}
 * 体积: ${wasm.length} 字节
 *
 * 真实性由 tests/hashwx.test.js 的官方 KAT 向量保证。
 */

export const HASHWX_WASM_SHA256 =
  "${digest}";

export const HASHWX_WASM_BASE64 =
${chunks.join(' +\n')};
`;

fs.writeFileSync(OUT_PATH, output);
console.log(`[vendor-hashwx] 已写入 ${path.relative(process.cwd(), OUT_PATH)}`);
console.log(`  上游 commit : ${commit}`);
console.log(`  wasm        : ${wasm.length} 字节，sha256 ${digest}`);
console.log(`  base64      : ${base64.length} 字符`);
