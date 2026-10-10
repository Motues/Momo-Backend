import { sql } from "drizzle-orm";
import net from "node:net";
import { db } from "../src/orm/client";
import router from "../src/middleware/routes";
import { applyTrustProxySetting } from "../src/utils/ip";
import type { Comment } from "../src/type/prisma";

/**
 * 测试公共工具。
 *
 * 约定：
 * - HTTP 用例一律通过 `router.request()` 直接调用 Hono 路由，
 *   绝不导入 `src/app.ts`（那里会启动真实 HTTP 服务并读取 public/index.html）；
 * - 客户端 IP 通过 `TRUST_PROXY` + `cf-connecting-ip` 头控制，
 *   这样 IP 黑名单 / 频率限制 / 登录锁定等用例才能互相隔离。
 */

/** 打开 TRUST_PROXY 开关，使测试可以用 cf-connecting-ip 头控制客户端 IP */
export function useTrustProxy(): void {
  applyTrustProxySetting("true");
}

/** 关闭 TRUST_PROXY 开关 */
export function disableTrustProxy(): void {
  applyTrustProxySetting("false");
}

export interface SeedCommentOptions {
  pub_date?: number;
  post_slug?: string;
  author?: string;
  email?: string;
  url?: string | null;
  ip_address?: string | null;
  device?: string | null;
  browser?: string | null;
  os?: string | null;
  user_agent?: string | null;
  content_text?: string;
  content_html?: string;
  parent_id?: number | null;
  status?: string;
}

/** 显式传入 undefined 时用默认值；显式传入 null 时保留 null */
function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

/** 直接向 Comment 表插入一条评论，返回自增 id */
export function seedComment(options: SeedCommentOptions = {}): number {
  db.run(sql`
    INSERT INTO "Comment"
      ("pub_date", "post_slug", "author", "email", "url", "ip_address", "device", "browser", "os", "user_agent", "content_text", "content_html", "parent_id", "status")
    VALUES
      (${options.pub_date ?? Date.now()}, ${options.post_slug ?? "/posts/test"}, ${options.author ?? "测试用户"},
       ${options.email ?? "tester@example.com"}, ${pick(options.url, null)}, ${pick(options.ip_address, "198.51.100.10")},
       ${pick(options.device, null)}, ${pick(options.browser, null)}, ${pick(options.os, null)}, ${pick(options.user_agent, null)},
       ${options.content_text ?? "hello"}, ${options.content_html ?? "<p>hello</p>"},
       ${pick(options.parent_id, null)}, ${options.status ?? "approved"})
  `);
  const row = db.get(sql`SELECT last_insert_rowid() AS id`) as { id: number };
  return row.id;
}

/** 统计 Comment 表行数 */
export function countComments(): number {
  const row = db.get(sql`SELECT COUNT(*) AS n FROM "Comment"`) as { n: number };
  return row.n;
}

/**
 * 清空业务数据表。
 * setup.ts 只在每个测试文件开始前重建数据库，同一文件内的用例默认共享数据，
 * 因此需要计数/列表断言的用例必须在 beforeEach 里调用本函数。
 */
export function resetTables(): void {
  db.run(sql`DELETE FROM "Comment"`);
  db.run(sql`DELETE FROM "EmailVerification"`);
  // 认证记录同样按文件隔离：验证类用例的埋点会持续写入这张表，
  // 不清理会让「恰好 N 条」这类断言在后续用例里出现假失败
  db.run(sql`DELETE FROM "VerifyRecord"`);
}

/** 删除若干配置项，用于用例之间的隔离 */
export function clearSettings(keys: string[]): void {
  for (const key of keys) db.run(sql`DELETE FROM "Settings" WHERE "key" = ${key}`);
}

/** 读取单条评论的原始数据库行（字段名与 SQL 一致） */
export function rawComment(id: number): Record<string, unknown> {
  return db.get(sql`SELECT * FROM "Comment" WHERE "id" = ${id}`) as Record<string, unknown>;
}

/** 构造应用层 Comment 对象（用于 content.ts 等纯函数用例） */
export function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    pub_date: new Date("2024-01-02T03:04:05.000Z"),
    post_slug: "/posts/test",
    author: "测试用户",
    email: "tester@example.com",
    url: null,
    ip_address: "198.51.100.10",
    device: null,
    browser: null,
    os: null,
    user_agent: null,
    content_text: "hello",
    content_html: "<p>hello</p>",
    parent_id: null,
    status: "approved",
    ...overrides,
  };
}

export interface ApiRequestOptions {
  method?: string;
  token?: string;
  /** 通过 cf-connecting-ip 指定的客户端 IP（需先 useTrustProxy()） */
  ip?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** 以 JSON 方式请求路由 */
export function api(path: string, options: ApiRequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  headers["cf-connecting-ip"] = options.ip ?? "203.0.113.7";
  return router.request(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** 解析响应 JSON */
export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** 登录并返回 token（默认凭据 momo / momo） */
export async function loginToken(
  name = "momo",
  password = "momo",
  ip = "203.0.113.7"
): Promise<string> {
  const res = await api("/admin/login", { method: "POST", ip, body: { name, password } });
  const body = await json(res);
  return body.token as string;
}

/* ------------------------------------------------------------------ *
 * 本地假 SMTP 服务器：只实现编译/投递所需的最小命令集。
 * 用于捕获邮件原文做「模板渲染 + HTML 转义 + 通知触发」断言，
 * 不连接任何真实 SMTP 服务。
 * ------------------------------------------------------------------ */
export interface FakeSmtp {
  port: number;
  messages: string[];
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    let current: string[] = [];
    socket.write("220 fake.local ESMTP ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            messages.push(current.join("\r\n"));
            current = [];
            inData = false;
            socket.write("250 OK queued\r\n");
          } else {
            current.push(line);
          }
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) {
          // 不宣告 STARTTLS，避免 nodemailer 尝试加密
          socket.write("250-fake.local\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n");
        } else if (cmd.startsWith("AUTH")) {
          socket.write("235 Authentication successful\r\n");
        } else if (cmd.startsWith("MAIL FROM") || cmd.startsWith("RCPT TO")) {
          socket.write("250 OK\r\n");
        } else if (cmd.startsWith("DATA")) {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (cmd.startsWith("QUIT")) {
          socket.write("221 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
    socket.on("error", () => {
      /* 测试收尾阶段的连接重置可忽略 */
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    messages,
    reset: () => {
      messages.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 解码 MIME 正文：支持 base64 与 quoted-printable（含软换行） */
export function decodeMessage(raw: string): string {
  const separator = raw.indexOf("\r\n\r\n");
  const headers = separator >= 0 ? raw.slice(0, separator) : "";
  const body = separator >= 0 ? raw.slice(separator + 4) : raw;

  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  }

  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "=" && body[i + 1] === "\r" && body[i + 2] === "\n") {
      i += 2;
      continue;
    }
    const hex = body.slice(i + 1, i + 3);
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    bytes.push(body.charCodeAt(i));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 取出某个头的原始值 */
export function messageHeader(raw: string, name: string): string {
  const match = new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r\\n[^\\s])`, "im").exec(raw);
  return match ? match[1] : "";
}

/** 解码 RFC2047 编码的字（=?UTF-8?B?...?=） */
export function decodeHeaderValue(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_all, b64) =>
    Buffer.from(b64, "base64").toString("utf8")
  );
}

/** 轮询等待条件成立（用于异步发送邮件等场景） */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 20
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}
