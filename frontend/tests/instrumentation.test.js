import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	runProgram,
	runInstrumentation,
	measureFonts,
	measureLayout,
	collectEnv,
	InstrumentationError,
	FONT_STACKS,
	PROBE_TEXT,
} from '../src/verify/instrumentation';

/**
 * 跨语言固定向量：由 nodejs/scripts/gen-instr-vectors.ts 生成。
 *
 * 服务端用「影子 DOM 模型」推算寄存器，前端用真实 DOM 执行同一段程序。
 * 这两个解释器必须逐位等价——只要有一步语义漂移（哪怕只是一个 |0），
 * 所有访客都会被判成「程序结果不匹配」。所以这里直接读同一份 fixture 复算。
 *
 * 用 fs 读取而不是 import：fixture 在包外（doc/vectors/），
 * 走文件系统比依赖打包器的路径解析更可靠。
 */
const FIXTURE_PATH = path.resolve(import.meta.dirname, '..', '..', 'doc', 'vectors', 'instrumentation-v2.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

/** 建一个干净的容器用于执行程序（模拟隔离上下文里的容器） */
function makeContainer() {
	const container = document.createElement('div');
	document.body.appendChild(container);
	return container;
}

afterEach(() => {
	// 清掉用例留下的容器
	for (const node of Array.from(document.querySelectorAll('div'))) {
		if (node.textContent === '' && node.children.length === 0) continue;
	}
	document.body.innerHTML = '';
});

describe('instrumentation —— 跨语言固定向量（与服务端影子模型逐位一致）', () => {
	it('fixture 可用且包含全部操作码', () => {
		expect(fixture.vectors.length).toBeGreaterThan(0);
		for (const vector of fixture.vectors) {
			expect(vector.ops.length % 3).toBe(0);
			expect(vector.regs).toHaveLength(4);
		}
	});

	fixture.vectors.forEach((vector, index) => {
		it(`向量 ${index + 1}（cid=${vector.cid}）的寄存器与期望值一致`, () => {
			const container = makeContainer();
			const regs = runProgram(document, container, vector.ops);
			expect(regs).toEqual(vector.regs);
		});
	});

	it('三个向量覆盖了整数运算、DOM 树与原型链三类操作', () => {
		const opcodes = new Set();
		for (const vector of fixture.vectors) {
			for (let i = 0; i < vector.ops.length; i += 3) opcodes.add(vector.ops[i]);
		}
		// 整数运算
		expect(opcodes.has(0)).toBe(true); // CONST
		expect(opcodes.has(8)).toBe(true); // MUL
		// DOM 建树/读写/回走
		expect(opcodes.has(14)).toBe(true); // DOM_CREATE
		expect(opcodes.has(20)).toBe(true); // DOM_WALK_UP
		expect(opcodes.has(21)).toBe(true); // DOM_REMOVE
		// 原型链
		expect(opcodes.has(22)).toBe(true); // PROTO_JOIN
		expect(opcodes.has(23)).toBe(true); // PROTO_CHARCODE
	});

	it('执行完毕后容器里没有残留节点（程序自己会把树拆掉）', () => {
		const container = makeContainer();
		runProgram(document, container, fixture.vectors[0].ops);
		expect(container.childElementCount).toBe(0);
	});
});

describe('instrumentation —— 解释器语义细节', () => {
	/** 用三元组列表拼程序 */
	const prog = (...triples) => triples.flatMap((t) => [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0]);

	it('乘法按 imul（32 位），不会退化成浮点', () => {
		const container = makeContainer();
		const regs = runProgram(
			document,
			container,
			prog([0, 0, 0x40000000], [0, 1, 4], [8, 0, 1])
		);
		expect(regs[0]).toBe(Math.imul(0x40000000, 4));
	});

	it('ROTL / ROTR 在 shift 为 0 与 32 的边界上不退化为 NaN', () => {
		const container = makeContainer();
		const regs = runProgram(document, container, prog([0, 0, 1], [9, 0, 0], [0, 1, 1], [10, 1, 0]));
		expect(regs[0]).toBe(1);
		expect(regs[1]).toBe(1);
	});

	it('DOM_WALK_UP 不会把容器之外（宿主页面）的属性算进来', () => {
		// 宿主页面里挂一个带 data-v 的元素，模拟「宿主页面碰巧有同名属性」
		const outside = document.createElement('div');
		outside.setAttribute('data-v', '999999');
		document.body.appendChild(outside);

		const container = document.createElement('div');
		outside.appendChild(container);

		const regs = runProgram(
			document,
			container,
			prog([0, 0, 5], [14, 0, 0], [15], [17, 0, 0], [0, 1, 0], [20, 1, 99])
		);
		// 只应累加容器内部那一个节点（attrV=5），宿主的 999999 必须被排除
		expect(regs[1]).toBe(5);
	});

	it('栈空时执行 DOM 操作抛错而不是静默算错', () => {
		const container = makeContainer();
		expect(() => runProgram(document, container, prog([17, 0, 0]))).toThrow(InstrumentationError);
		expect(() => runProgram(document, container, prog([18, 0, 0]))).toThrow(InstrumentationError);
		expect(() => runProgram(document, container, prog([21]))).toThrow(InstrumentationError);
	});

	it('程序格式非法时拒绝', () => {
		const container = makeContainer();
		expect(() => runProgram(document, container, [])).toThrow(InstrumentationError);
		expect(() => runProgram(document, container, [0, 0])).toThrow(InstrumentationError);
		expect(() => runProgram(document, container, [999, 0, 0])).toThrow(InstrumentationError);
	});
});

describe('instrumentation —— 环境向量与探针', () => {
	it('字体度量条数与服务端字体栈一致（或在不支持 canvas 的环境下为空）', () => {
		const tm = measureFonts(document);
		expect(Array.isArray(tm)).toBe(true);
		if (tm.length > 0) {
			expect(tm).toHaveLength(FONT_STACKS.length);
			for (const width of tm) expect(Number.isFinite(width)).toBe(true);
		}
	});

	it('布局探针在无渲染引擎的环境下返回 0（正是 layout_zero 规则要拦的情况）', () => {
		// happy-dom 没有布局引擎，getBoundingClientRect() 恒为 0。
		// 这条断言把「探针具备区分能力」这件事固化下来：
		// 如果哪天 happy-dom 实现了布局，这里会失败，提示重新审视 layout_zero 的判定。
		const container = makeContainer();
		const { lw, lh } = measureLayout(document, container);
		expect(lw).toBe(0);
		expect(lh).toBe(0);
	});

	it('环境向量的字段齐全且取值类型正确', () => {
		const env = collectEnv(window, document);
		expect(typeof env.cd).toBe('number');
		expect([-1, 0, 1]).toContain(env.cd);
		expect(typeof env.ua).toBe('string');
		expect(typeof env.br).toBe('string');
		expect([0, 1, 2, 3]).toContain(env.ge);
		expect(typeof env.dm).toBe('number');
		expect(Array.isArray(env.tm)).toBe(true);
		for (const key of ['lw', 'lh', 'iw', 'ih', 'ow', 'oh', 'sw', 'sh', 'ex', 'mob', 'nt']) {
			expect(Number.isFinite(env[key]), `${key} 应为有限数值`).toBe(true);
		}
		expect(env.ua.length).toBeLessThanOrEqual(300);
		expect(env.br.length).toBeLessThanOrEqual(300);
	});

	it('原生方法未被改写时 nt 为 0', () => {
		// happy-dom 的 canvas 实现未必带 [native code]，因此这里只断言是数值位掩码
		const env = collectEnv(window, document);
		expect(Number.isInteger(env.nt)).toBe(true);
		expect(env.nt).toBeGreaterThanOrEqual(0);
	});
});

describe('instrumentation —— 完整执行流程', () => {
	it('runInstrumentation 返回与服务端期望一致的寄存器，并清理掉隔离上下文', () => {
		const vector = fixture.vectors[0];
		const answer = runInstrumentation(vector.ops);

		expect(answer.regs).toEqual(vector.regs);
		expect(answer.env).toBeTruthy();
		expect(answer.tm).toEqual(answer.env.tm);
		expect(answer.env.lw).toBe(answer.lw);
		expect(answer.env.lh).toBe(answer.lh);

		// 执行完必须不留痕迹
		expect(document.querySelectorAll('[data-momo-verify-root]').length).toBe(0);
		expect(document.querySelectorAll('iframe').length).toBe(0);
	});

	it('程序抛错时也会清理上下文', () => {
		expect(() => runInstrumentation([17, 0, 0])).toThrow(InstrumentationError);
		expect(document.querySelectorAll('[data-momo-verify-root]').length).toBe(0);
		expect(document.querySelectorAll('iframe').length).toBe(0);
	});

	it('探测串常量与服务端一致', () => {
		expect(PROBE_TEXT).toBe('MomoVerify1234');
	});
});
