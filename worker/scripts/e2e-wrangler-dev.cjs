#!/usr/bin/env node
/**
 * `wrangler dev` 端到端验证脚本（临时工具）
 *
 * 目的：验证 Worker 生产代码里 **静态导入的 hashwx.wasm** 真的能在 workerd 里实例化并执行 ——
 * 这是 `vitest-pool-workers` 覆盖不到的唯一一段（测试池里用纯 JS 替身替换了哈希原语）。
 *
 * 顺带在真实运行时验证「挑战绑定文章」这个安全修复：为文章 A 签发的挑战，
 * 用文章 B 兑换必须被拒（reason: slug mismatch）。
 *
 * 用法（先在另一个终端把 wrangler dev 跑起来）：
 *   node scripts/e2e-wrangler-dev.cjs
 * 可用 BASE 环境变量覆盖地址，默认 http://127.0.0.1:8799
 */

const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8799';
const SLUG = '/posts/e2e';
const OTHER_SLUG = '/posts/e2e-other';

// 用 Node 侧的同一份实现解题：它跑的是**同一个 hashwx.wasm 二进制**，
// 所以只要能解开，就说明 Worker 侧的解释模式校验与这里的口径一致。
const hashwx = require(path.resolve(__dirname, '..', '..', 'nodejs', 'dist', 'utils', 'hashwx.js'));

let failures = 0;
function check(label, ok, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
	if (!ok) failures++;
}

async function call(method, pathname, body, token) {
	const headers = {};
	if (body !== undefined) headers['content-type'] = 'application/json';
	if (token) headers['authorization'] = `Bearer ${token}`;
	const res = await fetch(`${BASE}${pathname}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		/* 非 JSON（例如 HTML 错误页） */
	}
	return { status: res.status, body: parsed, raw: text };
}

/** 本地求解 HashWX（与三端同口径） */
function solve(spec) {
	const challenge = Buffer.from(spec.c, 'hex');
	const target = hashwx.hashwxTarget(spec.d);
	const n = BigInt(spec.n);
	const nonces = [];
	for (let i = 0; i < spec.count; i++) {
		let nonce = 0n;
		for (; nonce < 20_000_000n; nonce++) {
			if (hashwx.hashwxHash(hashwx.hashwxBlockSeed(challenge, i, nonce / n), nonce) <= target) break;
		}
		if (nonce >= 20_000_000n) throw new Error(`子挑战 ${i} 求解超限`);
		nonces.push(nonce.toString());
	}
	return nonces;
}

(async () => {
	console.log(`目标: ${BASE}\n`);

	// 1. 管理员登录（默认凭据 momo/momo）
	const login = await call('POST', '/admin/login', { name: 'momo', password: 'momo' });
	check('管理员登录', login.status === 200 && !!login.body?.token, `status=${login.status} raw=${login.raw.slice(0, 120)}`);
	if (login.status !== 200 || !login.body?.token) {
		console.log('\n登录失败，后续用例无法继续。');
		process.exit(1);
	}
	const token = login.body.token;

	// 2. 开启验证并把难度降到 1000（端到端要跑得快）
	const enable = await call('PUT', '/admin/settings', {
		comment_verify_enabled: 'true',
		comment_verify_difficulty: '1000',
	}, token);
	check('开启无感验证（难度 1000）', enable.status === 200 && enable.body?.code === 200, `status=${enable.status} body=${JSON.stringify(enable.body).slice(0, 160)}`);

	// 3. 签发挑战 —— 这一步会用到 hashwx.wasm 派生挑战
	const challengeRes = await call('POST', '/api/verify/challenge', { post_slug: SLUG });
	const challenge = challengeRes.body?.data;
	check('签发挑战（Worker 已实例化 hashwx.wasm）', challengeRes.status === 200 && challenge?.enabled === true && !!challenge?.pow, `status=${challengeRes.status} body=${JSON.stringify(challengeRes.body).slice(0, 200)}`);
	if (!challenge?.pow) {
		console.log('\n挑战签发失败，后续用例无法继续。');
		process.exit(1);
	}

	// 挑战载荷必须带 slug，且等于请求里的 post_slug
	const payload = JSON.parse(Buffer.from(challenge.prefix.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
	check('挑战载荷包含 slug 且与请求一致', payload.slug === SLUG, `payload=${JSON.stringify(payload)}`);

	// 4. 本地用真实二进制解题
	const started = Date.now();
	const nonces = solve(challenge.pow);
	console.log(`       （本地解题用时 ${Date.now() - started}ms，nonces=[${nonces.join(', ')}]）`);

	// 5. 换文章兑换 —— 必须被拒（本次安全修复的核心断言）
	const crossPost = await call('POST', '/api/verify/solution', {
		post_slug: OTHER_SLUG,
		prefix: challenge.prefix,
		sig: challenge.sig,
		nonces,
		elapsed_ms: 1000,
	});
	check('跨文章兑换被拒（slug mismatch）', crossPost.status === 403 && crossPost.body?.reason === 'slug mismatch', `status=${crossPost.status} reason=${crossPost.body?.reason}`);

	// 6. 同一文章兑换 —— 应当拿到票据（证明上一步不是被别的原因顺带拦下的）
	const solved = await call('POST', '/api/verify/solution', {
		post_slug: SLUG,
		prefix: challenge.prefix,
		sig: challenge.sig,
		nonces,
		elapsed_ms: 1000,
	});
	const ticket = solved.body?.data?.ticket;
	check('同文章兑换拿到票据（真实 WASM 校验通过）', solved.status === 200 && typeof ticket === 'string', `status=${solved.status} body=${JSON.stringify(solved.body).slice(0, 200)}`);

	// 7. 票据确实绑定到该文章
	if (ticket) {
		const body = ticket.slice(0, ticket.lastIndexOf('.'));
		const tp = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
		check('票据绑定到正确文章', tp.slug === SLUG, `ticket.slug=${tp.slug}`);
	}

	// 8. 用票据提交评论 —— 打通「验证 → 评论」的最后一环
	if (ticket) {
		const comment = await call('POST', '/api/comments', {
			post_slug: SLUG,
			author: 'e2e',
			email: 'e2e@example.com',
			content: 'wrangler dev 端到端验证',
			verify_ticket: ticket,
		});
		check('用票据提交评论成功', comment.status === 200, `status=${comment.status} body=${JSON.stringify(comment.body).slice(0, 200)}`);
	}

	console.log(failures === 0 ? '\n端到端验证全部通过' : `\n端到端验证失败 ${failures} 项`);
	process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => {
	console.error('端到端脚本异常:', e);
	process.exitCode = 1;
});
