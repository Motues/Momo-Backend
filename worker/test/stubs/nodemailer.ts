/**
 * nodemailer 测试替身（仅用于 vitest-pool-workers）。
 *
 * 为什么需要它：
 * 真实 nodemailer@8 的 `lib/fetch/index.js` 直接 require `node:http` / `node:https` /
 * `node:net`，vitest-pool-workers 的模块加载器无法解析，导入 `src/utils/email.ts`
 * 的测试用例会在收集阶段就报 `SyntaxError`。
 * 这属于**测试框架限制**（真实 Workers 运行时的可用性另见 TODO「待验证的怀疑清单」第 2 条），
 * 因此这里只替换模块本身，不改动被测代码。
 *
 * 替身记录所有 sendMail 调用，便于断言「邮件确实被发出、收件人与主题正确」。
 */
export type StubMail = {
	from?: string;
	to?: string;
	subject?: string;
	html?: string;
	text?: string;
};

/** 已发送的邮件（跨用例共享，用例前请调用 resetSentMails） */
export const sentMails: StubMail[] = [];

/** 下一次 sendMail 是否抛错（用于覆盖发送失败分支） */
let failNextSend = false;

export function resetSentMails(): void {
	sentMails.length = 0;
	failNextSend = false;
}

/** 让下一次 sendMail 抛出错误 */
export function failNextSendMail(): void {
	failNextSend = true;
}

export function createTransport(options: unknown) {
	return {
		options,
		async sendMail(mail: StubMail) {
			if (failNextSend) {
				failNextSend = false;
				throw new Error('stubbed smtp failure');
			}
			sentMails.push(mail);
			return { messageId: `stub-${sentMails.length}`, accepted: [mail.to] };
		},
		async verify() {
			return true;
		},
		close() {
			/* no-op */
		},
	};
}

export default { createTransport };
