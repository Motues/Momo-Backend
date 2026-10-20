import { describe, it, expect, beforeEach } from "vitest";
import {
  buildShortcodeMap,
  fnv1aHex,
  hydrateEmailEmoji,
  loadEmailEmojiMap,
  mergeOwoPacks,
  normalizeShortcode,
  renderEmailContent,
  resetEmailEmojiCache,
  safeImageUrl,
} from "../src/utils/emailEmoji";

/**
 * 通知邮件的表情水合（服务端）单元验收，口径见 doc/mail.md 第 4 节。
 *
 * 关键约束：
 *  - 短代码推导与前端**完全一致**（否则邮件里的图和评论区的图会对不上）；
 *  - `<code>` / `<pre>` 内部不替换；
 *  - 图片地址只走 https 与 data:image 白名单；
 *  - 任何失败都降级为「短代码保持文字」。
 */

const PNG = "https://cdn.example.com/emoji/hi.png";

function imagePack(entries: Array<[string, string]>) {
  return {
    包: {
      type: "image",
      container: entries.map(([text, src]) => ({ icon: `<img src="${src}">`, text })),
    },
  };
}

beforeEach(() => {
  resetEmailEmojiCache();
});

describe("短代码推导（与前端同口径）", () => {
  it("text 归一化合法时直接使用", () => {
    expect(normalizeShortcode("TV_doge")).toBe("tv-doge");
    expect(normalizeShortcode("doge")).toBe("doge");
    expect(normalizeShortcode("  ")).toBe("");
  });

  it("无法归一化时用 FNV-1a 8 位十六进制", () => {
    const map = buildShortcodeMap(imagePack([["表情", PNG]]));
    const name = `e-${fnv1aHex(PNG)}`;
    expect([...map.keys()]).toEqual([name]);
    expect(map.get(name)).toBe(PNG);
  });

  it("同包重名追加 -2 / -3", () => {
    const map = buildShortcodeMap(
      imagePack([
        ["doge", PNG],
        ["doge", "https://cdn.example.com/emoji/doge2.png"],
        ["doge", "https://cdn.example.com/emoji/doge3.png"],
      ])
    );
    expect([...map.keys()]).toEqual(["doge", "doge-2", "doge-3"]);
  });

  it("跨包重名（合并后的多来源）同样追加后缀", () => {
    const merged: Record<string, any> = {};
    mergeOwoPacks(merged, {
      Bilibili: { type: "image", container: [{ icon: `<img src="${PNG}">`, text: "doge" }] },
    });
    mergeOwoPacks(merged, {
      QQ: { type: "image", container: [{ icon: `<img src="https://cdn.example.com/emoji/doge.gif">`, text: "doge" }] },
    });
    const map = buildShortcodeMap(merged);
    expect(map.get("doge")).toBe(PNG);
    expect(map.get("doge-2")).toBe("https://cdn.example.com/emoji/doge.gif");
  });

  it("文本表情包（emoji / emoticon）不参与水合", () => {
    const map = buildShortcodeMap({
      颜文字: { type: "emoticon", container: [{ icon: "OωO", text: "hi" }] },
      Emoji: { type: "emoji", container: [{ icon: "😂", text: "joy" }] },
    });
    expect(map.size).toBe(0);
  });

  it("图片地址白名单：只放行 https 与 data:image", () => {
    expect(safeImageUrl(`<img src="${PNG}">`)).toBe(PNG);
    expect(safeImageUrl('<img src="data:image/png;base64,AAAA">')).toBe("data:image/png;base64,AAAA");
    expect(safeImageUrl('<img src="data:image/svg+xml;base64,AAAA">')).toBe("");
    expect(safeImageUrl('<img src="http://cdn.example.com/a.png">')).toBe("");
    expect(safeImageUrl('<img src="javascript:alert(1)">')).toBe("");
    expect(safeImageUrl('<img onerror="x" src="https://a/b.png">')).toBe("");
  });

  it("合并同名标签：追加到先出现的标签而不是新建标签页", () => {
    const merged: Record<string, any> = {};
    mergeOwoPacks(merged, { 颜文字: { type: "emoticon", container: [{ icon: "OωO" }] } });
    mergeOwoPacks(merged, { 颜文字: { type: "emoticon", container: [{ icon: ">_<" }] }, 新包: { type: "image", container: [] } });
    expect(Object.keys(merged)).toEqual(["颜文字", "新包"]);
    expect(merged["颜文字"].container.map((item: any) => item.icon)).toEqual(["OωO", ">_<"]);
  });
});

describe(" hydrate —— 文本替换", () => {
  const images = buildShortcodeMap(imagePack([["doge", PNG]]));

  it("普通文本里的短代码被替换成内联 img", () => {
    const html = hydrateEmailEmoji("<p>看这个 :doge: 图</p>", images);
    expect(html).toContain(`<img src="${PNG}"`);
    expect(html).toContain("alt=\":doge:\"");
    // 正文里的短代码本身已被替换（alt/title 里的 :doge: 是刻意保留的无障碍文案）
    expect(html).not.toContain(":doge: 图");
    expect(html).not.toContain(">看这个 :doge:<");
  });

  it("<code> / <pre> 内部原样保留", () => {
    const html = hydrateEmailEmoji("<p>:doge:</p><code>:doge:</code><pre>:doge:</pre>", images);
    expect(html).toContain(`<img src="${PNG}"`);
    expect(html).toContain("<code>:doge:</code>");
    expect(html).toContain("<pre>:doge:</pre>");
  });

  it("未登记的短代码原样保留（表情包换掉后优雅降级）", () => {
    const html = hydrateEmailEmoji("<p>:unknown:</p>", images);
    expect(html).toBe("<p>:unknown:</p>");
  });

  it("边界规则：时间 12:30:45 不会被当成短代码", () => {
    const html = hydrateEmailEmoji("<p>12:30:45</p>", images);
    expect(html).toBe("<p>12:30:45</p>");
  });

  it("空映射 / 空输入是空操作", () => {
    expect(hydrateEmailEmoji("<p>:doge:</p>", new Map())).toBe("<p>:doge:</p>");
    expect(hydrateEmailEmoji("", images)).toBe("");
  });

  it("没有闭合的尖括号时按普通文本收尾（不吞内容）", () => {
    const html = hydrateEmailEmoji("<p>:doge:<b", images);
    expect(html).toContain(`<img src="${PNG}"`);
    expect(html).toContain("<b");
  });
});

describe("renderEmailContent", () => {
  it("优先用 content_html", () => {
    expect(renderEmailContent("<p>hi</p>", "hi", new Map())).toBe("<p>hi</p>");
  });

  it("content_html 为空时回落纯文本（转义 + 换行变 <br>）", () => {
    expect(renderEmailContent("", "a<b\nc", new Map())).toBe("a&lt;b<br>c");
  });

  it("水合抛错时降级为未水合的 HTML", () => {
    const broken = { has: () => true, size: 1 } as unknown as Map<string, string>;
    // get 返回非字符串会让 img 标签拼出 undefined，但绝不能抛错打断发信
    expect(() => renderEmailContent("<p>:doge:</p>", "", broken)).not.toThrow();
  });
});

describe("loadEmailEmojiMap", () => {
  const owo = JSON.stringify(imagePack([["doge", PNG]]));

  function fetchOnce(payload: string | null, status = 200) {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      if (payload === null) throw new Error("network down");
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        text: async () => payload,
      };
    }) as unknown as typeof fetch;
    return { impl, calls: () => calls };
  }

  it("拉取并解析多个来源，按顺序合并", async () => {
    const first = JSON.stringify({ A: { type: "image", container: [{ icon: `<img src="${PNG}">`, text: "a" }] } });
    const second = JSON.stringify({ B: { type: "image", container: [{ icon: '<img src="https://cdn.example.com/b.png">', text: "b" }] } });
    const impl = (async (url: string) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => (String(url).includes("a.example") ? first : second),
    })) as unknown as typeof fetch;

    const map = await loadEmailEmojiMap(["https://a.example.com/owo.json", "https://b.example.com/owo.json"], { fetchImpl: impl });
    expect(map.get("a")).toBe(PNG);
    expect(map.get("b")).toBe("https://cdn.example.com/b.png");
  });

  it("单个来源失败只丢它，其余照常水合", async () => {
    const impl = (async (url: string) => {
      if (String(url).includes("broken")) throw new Error("boom");
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(imagePack([["doge", PNG]])) };
    }) as unknown as typeof fetch;

    const map = await loadEmailEmojiMap(["https://broken.example.com/owo.json", "https://ok.example.com/owo.json"], { fetchImpl: impl });
    expect(map.get("doge")).toBe(PNG);
  });

  it("全部失败时返回空映射（邮件照常发出，短代码保持文字）", async () => {
    const { impl } = fetchOnce(null);
    const map = await loadEmailEmojiMap(["https://a.example.com/owo.json"], { fetchImpl: impl });
    expect(map.size).toBe(0);
  });

  it("命中 10 分钟缓存后不再发请求", async () => {
    const { impl, calls } = fetchOnce(owo);
    const urls = ["https://a.example.com/owo.json"];
    const first = await loadEmailEmojiMap(urls, { fetchImpl: impl, now: 1000 });
    const second = await loadEmailEmojiMap(urls, { fetchImpl: impl, now: 2000 });
    expect(calls()).toBe(1);
    expect(second.get("doge")).toBe(first.get("doge"));

    // 超过 TTL 后重新拉取
    await loadEmailEmojiMap(urls, { fetchImpl: impl, now: 1000 + 10 * 60 * 1000 + 1 });
    expect(calls()).toBe(2);
  });

  it("地址列表为空时直接返回空映射，不发请求", async () => {
    const { impl, calls } = fetchOnce(owo);
    const map = await loadEmailEmojiMap([], { fetchImpl: impl });
    expect(map.size).toBe(0);
    expect(calls()).toBe(0);
  });

  it("响应体超过 1 MiB 时放弃该来源", async () => {
    const huge = `{"A":{"type":"image","container":[{"icon":"<img src=\\"https://a/x.png\\">","text":"a"}]}}${" ".repeat(1024 * 1024)}`;
    const { impl } = fetchOnce(huge);
    const map = await loadEmailEmojiMap(["https://a.example.com/owo.json"], { fetchImpl: impl });
    expect(map.size).toBe(0);
  });
});
