/**
 * 邮件模板预览（面板本地渲染）
 *
 * 为什么在面板里渲染：预览不新增后端接口，面板直接把「当前模板 + 一组演示数据」
 * 渲染成真实发信时的 HTML，填进 iframe 给管理员看效果（不落库、不发信）。
 *
 * **口径必须与后端一致**（`doc/mail.md` 第 2 节）：
 *  1. 纯文本占位符（`{{toName}}` / `{{commentContent}}` …）先替换，值做 HTML 转义；
 *  2. `*Html` 占位符（`{{commentContentHtml}}` …）后替换，**原样插入**（内容来自本站
 *     已净化的 `content_html`，转义会把它变成文字）；
 *  3. 未匹配的 `{{...}}` 保持原样；
 *  4. 模板为空串时用默认模板 —— 与三端 `getTemplate(key, "")` 的 `t || fallback` 语义一致，
 *     因此**只有空串**回落默认模板，纯空白串仍然按自定义模板渲染（和后端发出去的一样）。
 *
 * 默认模板照抄 `nodejs/src/utils/email.ts` 的内置模板（Node 是最先实现渲染后 HTML 的一份）。
 * 三端默认模板的正文结构一致，只有页脚字号 / 换行位置等细微差别，面板预览以 Node 为准。
 * **改动任一端的内置默认模板时，请同步更新这里**（见 `doc/mail.md` 第 7 节）。
 */

/** 与三端 `htmlEscape` 逐字一致：`&` 必须最先替换，否则会二次转义 */
export function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * 占位符替换。
 *
 * 用函数形式做替换（而不是字符串形式）：字符串形式下值里的 `$&` / `$1` 会被当成
 * 替换模式展开，预览就会和真正发出去的内容不一致。后端 Go 的 `strings.Replace` 也是字面量语义。
 */
function replacePlaceholder(input, name, value) {
	return input.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), () => value);
}

/**
 * 复刻三端 `applyTemplate`：先替换被转义的纯文本占位符，再插入原样的 HTML 占位符。
 *
 * @param {string} template 模板原文
 * @param {Record<string, string>} placeholders 需要 HTML 转义的占位符
 * @param {Record<string, string>} rawPlaceholders 原样插入的占位符（`*Html`）
 */
export function applyTemplate(template, placeholders = {}, rawPlaceholders = {}) {
	let html = String(template ?? '');
	for (const [name, value] of Object.entries(placeholders)) {
		html = replacePlaceholder(html, name, escapeHtml(value));
	}
	for (const [name, value] of Object.entries(rawPlaceholders)) {
		html = replacePlaceholder(html, name, value ?? '');
	}
	return html;
}

/**
 * 演示用的配图：内联 SVG（data URI），预览不依赖外网，断网也能看到图片效果。
 * 真实邮件里的图片来自评论正文，这里只负责让管理员看到「图片会按原样插进来」。
 */
const SAMPLE_IMAGE =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='360' height='120'%3E%3Crect width='360' height='120' rx='8' fill='%23dbeafe'/%3E%3Ctext x='180' y='66' font-family='sans-serif' font-size='16' text-anchor='middle' fill='%230369a1'%3ESample image%3C/text%3E%3C/svg%3E";

/** 演示用的「原评论」渲染后 HTML（模拟本站净化过的 content_html） */
const SAMPLE_PARENT_HTML = [
	'<p>原评论：这篇文章里的<strong>粗体</strong>、<a href="https://example.com/album">相册链接</a>和 <code>行内代码</code> 都会按评论区的样子显示。</p>',
].join('\n');

/** 演示用的「回复」渲染后 HTML：多一张图，用来验证图片也会原样出现在邮件里 */
const SAMPLE_REPLY_HTML = [
	'<p>回复：不用谢，欢迎再来！下面这张图也会跟着邮件一起发出去。</p>',
	`<p><img src="${SAMPLE_IMAGE}" alt="示例图片" style="max-width:100%;border-radius:6px;"></p>`,
].join('\n');

/** 演示用的「新评论」渲染后 HTML */
const SAMPLE_COMMENT_HTML = [
	'<p>刚刚在你的文章里留言，顺便测试一下通知邮件：<strong>粗体</strong>、<a href="https://example.com/album">链接</a>、<code>行内代码</code> 都在。</p>',
	`<p><img src="${SAMPLE_IMAGE}" alt="示例图片" style="max-width:100%;border-radius:6px;"></p>`,
].join('\n');

/**
 * 演示数据。名字里刻意带 `&` / `<`，用来展示纯文本占位符会被转义
 * （`Momo &lt;站长&gt;` 在邮件里显示成 `Momo <站长>`）。
 */
export const MAIL_SAMPLE_DATA = Object.freeze({
	toName: '小明 & 朋友们',
	replyAuthor: 'Momo <站长>',
	postTitle: '如何在 Momo 里自定义邮件模板',
	postUrl: 'https://example.com/posts/momo-mail-template',
	parentComment: '原评论：这篇文章里的粗体、相册链接和行内代码都会按评论区的样子显示。',
	replyContent: '回复：不用谢，欢迎再来！下面这张图也会跟着邮件一起发出去。',
	commentAuthor: 'Momo <站长>',
	commentContent: '刚刚在你的文章里留言，顺便测试一下通知邮件：粗体、链接、行内代码都在。',
	parentCommentHtml: SAMPLE_PARENT_HTML,
	replyContentHtml: SAMPLE_REPLY_HTML,
	commentContentHtml: SAMPLE_COMMENT_HTML,
});

/** 页面里展示的用途说明（与真实发信的收件人对应） */
export const MAIL_TEMPLATE_KINDS = Object.freeze({
	reply: {
		label: '回复通知',
		settingKey: 'reply_template',
		subject: (siteName) => `您在 ${siteName} 上的评论有了新回复`,
	},
	notification: {
		label: '新评论通知',
		settingKey: 'notification_template',
		subject: (siteName) => `您在 ${siteName} 上有新的评论`,
	},
});

/** 内置默认回复通知模板（与 `nodejs/src/utils/email.ts` 的默认模板一致） */
function defaultReplyTemplate(sample) {
	return `
        <div style="background-color: #f4f7f9; padding: 20px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); border: 1px solid #e1e4e8;">

            <div style="padding: 30px;">
              <h2 style="margin-top: 0; color: #333; font-size: 18px;">Hi ${escapeHtml(sample.toName)}，</h2>
              <p style="color: #555; line-height: 1.6;">
                <strong>${escapeHtml(sample.replyAuthor)}</strong> 回复了您在 <span style="color: #007acc;">《${escapeHtml(sample.postTitle)}》</span> 中的评论：
              </p>

              <div style="margin: 20px 0; padding: 12px 16px; border-left: 4px solid #dfe3e8; background-color: #fcfcfc; color: #555; font-size: 14px;">
                ${sample.parentCommentHtml}
              </div>

              <p style="color: #333; font-weight: bold; margin-bottom: 8px;">最新回复：</p>

              <div style="margin-bottom: 30px; padding: 16px; border-radius: 6px; background-color: #f0f7ff; border-left: 4px solid #007acc; color: #2c3e50; line-height: 1.6; word-break: break-word;">
                ${sample.replyContentHtml}
              </div>

              <div style="text-align: center;">
                <a href="${escapeHtml(sample.postUrl)}"
                   style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; box-shadow: 0 2px 5px rgba(0,122,204,0.2);">
                  点击查看回复
                </a>
              </div>
            </div>

            <div style="background-color: #fafbfc; padding: 15px 30px; border-top: 1px solid #eeeeee; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #999;">
                此邮件由系统自动发送，请勿直接回复。<br>
              </p>
            </div>
          </div>
        </div>`;
}

/** 内置默认新评论通知模板（与 `nodejs/src/utils/email.ts` 的默认模板一致） */
function defaultNotificationTemplate(sample) {
	return `
        <div style="background-color: #f6f8fa; padding: 40px 20px; min-height: 100%; font-family: 'PingFang SC', 'Microsoft YaHei', Helvetica, Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.05); overflow: hidden;">

            <div style="height: 4px; background: linear-gradient(90deg, #007acc, #00c6ff);"></div>

            <div style="padding: 32px;">
              <h2 style="margin: 0 0 16px 0; color: #1a1a1a; font-size: 20px; line-height: 1.4;">
                有人在您的文章下发表了评论
              </h2>

              <p style="color: #555; font-size: 15px; margin-bottom: 24px; line-height: 1.6;">
                <strong style="color: #007acc;">${escapeHtml(sample.commentAuthor)}</strong> 评论了您的文章
                <b style="color: #1a1a1a;">《${escapeHtml(sample.postTitle)}》</b>：
              </p>

              <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; border: 1px dashed #e1e4e8; margin-bottom: 32px;">
                <div style="color: #444; font-size: 15px; line-height: 1.8; word-break: break-word;">
                  ${sample.commentContentHtml}
                </div>
              </div>

              <div style="text-align: center;">
                <a href="${escapeHtml(sample.postUrl)}"
                   style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 32px; text-decoration: none; border-radius: 50px; font-weight: 500; font-size: 15px; transition: all 0.3s ease;">
                  立即前往查看
                </a>
              </div>
            </div>

            <div style="background-color: #fafbfc; padding: 20px; text-align: center; border-top: 1px solid #f0f0f0;">
              <p style="margin: 0; font-size: 13px; color: #99aab5; line-height: 1.5;">
                此邮件由系统自动发送，请勿直接回复。
              </p>
            </div>
          </div>
        </div>`;
}

/** 各模板类型对应的（转义 / 原样）占位符清单，与后端发信路径逐项对应 */
function placeholdersFor(kind, sample) {
	if (kind === 'reply') {
		return {
			escaped: {
				toName: sample.toName,
				replyAuthor: sample.replyAuthor,
				postTitle: sample.postTitle,
				parentComment: sample.parentComment,
				replyContent: sample.replyContent,
				postUrl: sample.postUrl,
			},
			raw: {
				parentCommentHtml: sample.parentCommentHtml,
				replyContentHtml: sample.replyContentHtml,
			},
		};
	}
	return {
		escaped: {
			postTitle: sample.postTitle,
			commentAuthor: sample.commentAuthor,
			commentContent: sample.commentContent,
			postUrl: sample.postUrl,
		},
		raw: {
			commentContentHtml: sample.commentContentHtml,
		},
	};
}

/**
 * 生成一份预览。
 *
 * @param {object} options
 * @param {'reply'|'notification'} options.kind 模板类型
 * @param {string} [options.template] 面板里当前（可能还没保存）的模板文本；空串 = 用默认模板
 * @param {string} [options.siteName] 站点名称（邮件主题用），缺省回落 `Momo Blog`
 * @returns {{ kind: string, isDefault: boolean, subject: string, html: string, siteName: string }}
 */
export function buildMailPreview({ kind, template, siteName } = {}) {
	const meta = MAIL_TEMPLATE_KINDS[kind];
	if (!meta) {
		throw new Error(`Unknown mail template kind: ${kind}`);
	}

	const sample = MAIL_SAMPLE_DATA;
	const site = String(siteName ?? '').trim() || 'Momo Blog';
	const custom = typeof template === 'string' ? template : '';
	const isDefault = custom === '';
	const { escaped, raw } = placeholdersFor(kind, sample);

	const html = isDefault
		? kind === 'reply'
			? defaultReplyTemplate(sample)
			: defaultNotificationTemplate(sample)
		: applyTemplate(custom, escaped, raw);

	return { kind, isDefault, subject: meta.subject(site), html, siteName: site };
}
