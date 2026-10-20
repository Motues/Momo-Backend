import { db, schema } from "./client";
import { eq, and, inArray, desc, gte, lt, asc, count, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { Comment, CreateCommentInput, rowToComment, rowsToComments, CommentRow } from "../type/prisma";
import { getSetting } from "../utils/settings";
import { normalizeEmail } from "../utils/adminEmails";
import {
  LINK_DORMANT_DAYS_KEY,
  LINK_SECURITY_ENABLED_KEY,
  isLinkDormant,
  isTrustActive,
  linkTrustKey,
  resolveLinkSwitch,
} from "../utils/linkSecurity";
import {
  mergeDistribution,
  normalizeBrowserFamily,
  normalizeDeviceType,
  normalizeOsFamily,
} from "../utils/statsDistribution";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 环比：与上一个等长窗口比较的整数百分比；上一窗口为 0 时返回 null。
 *
 * 口径与认证记录概览（`verifyRecordService.ts` 的 `deltaPct`）一致：
 * 没有对照数据时下发 null，而不是 0 或 100% —— 前者会让前端显示「持平」这种假结论。
 */
function deltaPct(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

class CommentService {
  /*
   * 创建评论
   */
  async createComment(data: CreateCommentInput): Promise<Comment> {
    const result = db.insert(schema.comments).values(data).run();
    const id = Number(result.lastInsertRowid);
    const created = await this.getCommentById(id);
    if (!created) throw new Error("Failed to create comment");
    return created;
  }

  /*
   * 获取所有评论，按照最新发布时间排序
   * 支持按状态筛选、按文章标识精确筛选（数据统计页的「热门文章」点击跳转用）
   */
  async getAllComments(status?: string, postSlug?: string): Promise<Comment[]> {
    const conditions = [];
    if (status) {
      conditions.push(eq(schema.comments.status, status));
    }
    if (postSlug) {
      conditions.push(eq(schema.comments.post_slug, postSlug));
    }

    const query = db
      .select()
      .from(schema.comments)
      .orderBy(desc(schema.comments.pub_date));

    if (conditions.length > 0) {
      query.where(and(...conditions));
    }

    const rows = query.all() as unknown as CommentRow[];
    return rowsToComments(rows);
  }

  /*
   * 根据 id 获取评论
   */
  async getCommentById(id: number): Promise<Comment | null> {
    const rows = (await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, id))
      .limit(1)
      .all()) as unknown as CommentRow[];
    return rows.length > 0 ? rowToComment(rows[0]) : null;
  }

  /*
   * 根据文章 slug 获取所有评论
   */
  async getCommentBySlug(postSlug: string): Promise<Comment[] | null> {
    const rows = (await db
      .select()
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.post_slug, postSlug),
          eq(schema.comments.status, "approved")
        )
      )
      .all()) as unknown as CommentRow[];
    return rowsToComments(rows);
  }

  /*
   * 根据 IP 获取最新的评论
   */
  async getlastCommentByIP(ip: string): Promise<Comment[] | null> {
    const rows = (await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.ip_address, ip))
      .orderBy(desc(schema.comments.pub_date))
      .all()) as unknown as CommentRow[];
    return rowsToComments(rows);
  }

  /*
   * 判断同一 IP 在时间窗内是否提交过完全相同的正文（审核自动化的「重复」规则）
   *
   * 不区分状态：被判为垃圾或被删除的评论同样计入 —— 否则刷屏者只要被删一次
   * 就能把同一段内容无限重发。
   */
  async hasRecentDuplicate(ip: string, contentText: string, sinceMillis: number): Promise<boolean> {
    const rows = (await db
      .select({ id: schema.comments.id })
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.ip_address, ip),
          eq(schema.comments.content_text, contentText),
          gte(schema.comments.pub_date, sinceMillis)
        )
      )
      .limit(1)
      .all()) as unknown as { id: number }[];
    return rows.length > 0;
  }

  /*
   * 链接安全审查：按归一化邮箱取「最后评论时间 + 最新一次留下的网址」
   *
   * 用户列表的「网站链接是否休眠」列用它：身份是邮箱（与公开评论区的 urlDormant 同一口径），
   * 因此同一个人用不同昵称留下的评论会归到同一组。一次查询解决，避免 N+1。
   */
  async getLinkStatusByEmail(
    emails: string[]
  ): Promise<Map<string, { lastAt: number; latestUrl: string }>> {
    const result = new Map<string, { lastAt: number; latestUrl: string }>();
    const normalized = Array.from(
      new Set(emails.map((email) => String(email ?? "").trim().toLowerCase()).filter((email) => email !== ""))
    );
    if (normalized.length === 0) return result;

    const placeholders = sql.join(
      normalized.map((email) => sql`${email}`),
      sql`, `
    );
    const rows = db.all(
      sql`SELECT lower(trim("email")) AS "email", "pub_date" AS "at", COALESCE("url", '') AS "url"
            FROM "Comment"
           WHERE status NOT IN ('rejected', 'deleted')
             AND lower(trim("email")) IN (${placeholders})
           ORDER BY "pub_date" ASC`
    ) as unknown as { email: string; at: number; url: string }[];

    // 升序遍历：最后一条决定 lastAt；只在网址非空时覆盖 latestUrl（「以最新链接为准」）
    for (const row of rows) {
      const key = String(row.email).toLowerCase();
      const at = Number(row.at);
      const url = String(row.url ?? "").trim();
      const current = result.get(key);
      result.set(key, {
        lastAt: Number.isFinite(at) ? at : current?.lastAt ?? 0,
        latestUrl: url !== "" ? url : current?.latestUrl ?? "",
      });
    }
    return result;
  }

  /*
   * 链接安全审查：取这批邮箱下**仍未过期**的人工确认记录
   *
   * 返回 `linkTrustKey(邮箱, 网址) → { expiresAt, source }`，供公开评论区与用户列表判断豁免。
   * `source` 区分「管理员人工确认」(`admin`) 与「评论者本人从提醒邮件里确认」(`self`)。
   * 只查传入的邮箱集合（本页涉及的邮箱），一次查询解决，避免 N+1；
   * 「是否过期」由纯函数 isTrustActive 判定（脏值/格式不符一律不豁免，见 doc/link_security.md 第 2.4 节）。
   */
  async getActiveTrustedLinks(
    emails: string[],
    nowMs: number
  ): Promise<Map<string, { expiresAt: string; source: string }>> {
    const result = new Map<string, { expiresAt: string; source: string }>();
    const normalized = Array.from(
      new Set(emails.map((email) => String(email ?? "").trim().toLowerCase()).filter((email) => email !== ""))
    );
    if (normalized.length === 0) return result;

    const placeholders = sql.join(
      normalized.map((email) => sql`${email}`),
      sql`, `
    );
    const rows = db.all(
      sql`SELECT lower(trim("email")) AS "email", "url" AS "url", "expires_at" AS "expires_at",
                 COALESCE("source", 'admin') AS "source"
            FROM "TrustedLink"
           WHERE lower(trim("email")) IN (${placeholders})`
    ) as unknown as { email: string; url: string; expires_at: string; source: string }[];

    for (const row of rows) {
      const expiresAt = String(row.expires_at ?? "");
      if (!isTrustActive(expiresAt, nowMs)) continue;
      result.set(linkTrustKey(String(row.email), String(row.url)), {
        expiresAt,
        source: String(row.source ?? "admin") === "self" ? "self" : "admin",
      });
    }
    return result;
  }

  /*
   * 链接安全审查：写入 / 刷新一条人工确认（管理员在用户列表点「确认安全」，或评论者本人从提醒邮件确认）
   *
   * 幂等 upsert：同一 (邮箱, 网址) 重复确认只刷新到期时间与来源，不新增行。
   */
  async trustLink(
    email: string,
    url: string,
    expiresAt: string,
    createdAt: string,
    source: "admin" | "self" = "admin"
  ): Promise<void> {
    db.run(
      sql`INSERT INTO "TrustedLink" ("email", "url", "expires_at", "created_at", "source")
              VALUES (${email}, ${url}, ${expiresAt}, ${createdAt}, ${source})
          ON CONFLICT("email", "url") DO UPDATE SET
              "expires_at" = ${expiresAt},
              "created_at" = ${createdAt},
              "source" = ${source}`
    );
  }

  /*
   * 链接安全审查：撤销一条人工确认；返回是否真的删掉了记录（幂等，重复撤销返回 false）
   */
  async revokeTrustedLink(email: string, url: string): Promise<boolean> {
    const result = db.run(
      sql`DELETE FROM "TrustedLink" WHERE "email" = ${email} AND "url" = ${url}`
    );
    return Number(result.changes ?? 0) > 0;
  }

  /*
   * 链接安全审查：按归一化邮箱取「最后一条评论时间」（跨文章统计）
   *
   * 只查传入的邮箱集合（本页评论涉及的邮箱），一次分组查询解决，避免 N+1。
   * 状态口径见 doc/link_security.md 第 2.1 节：rejected / deleted 不计入。
   */
  async getLastCommentTimeByEmail(emails: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const normalized = Array.from(
      new Set(emails.map((email) => String(email ?? "").trim().toLowerCase()).filter((email) => email !== ""))
    );
    if (normalized.length === 0) return result;

    const placeholders = sql.join(
      normalized.map((email) => sql`${email}`),
      sql`, `
    );
    const rows = db.all(
      sql`SELECT lower(trim("email")) AS "email", MAX("pub_date") AS "last"
            FROM "Comment"
           WHERE status NOT IN ('rejected', 'deleted')
             AND lower(trim("email")) IN (${placeholders})
           GROUP BY lower(trim("email"))`
    ) as unknown as { email: string; last: number }[];

    for (const row of rows) {
      const last = Number(row.last);
      if (Number.isFinite(last)) result.set(String(row.email).toLowerCase(), last);
    }
    return result;
  }

  /*
   * 链接安全审查：某邮箱的历史评论（只看网址字段，用于判断要不要发确认邮件 / 批量更新）
   */
  async getCommentsByEmail(email: string): Promise<{ id: number; url: string; status: string }[]> {
    const normalized = String(email ?? "").trim().toLowerCase();
    if (normalized === "") return [];
    const rows = db.all(
      sql`SELECT id, COALESCE(url, '') AS url, status
            FROM "Comment"
           WHERE lower(trim("email")) = ${normalized}
             AND status NOT IN ('rejected', 'deleted')`
    ) as unknown as { id: number; url: string; status: string }[];
    return rows.map((row) => ({ id: Number(row.id), url: String(row.url ?? ""), status: String(row.status) }));
  }

  /*
   * 链接安全审查：把某邮箱的历史评论网址批量更新为新网址
   *
   * - 只改本来就有网址、且与目标网址不同的评论（幂等：重复确认不会产生额外写入）；
   * - 不动空网址的评论（原本没留链接的评论不该被凭空补上）；
   * - rejected / deleted 不动。
   */
  async updateCommentUrlsByEmail(email: string, newUrl: string): Promise<number> {
    const normalized = String(email ?? "").trim().toLowerCase();
    if (normalized === "" || !newUrl) return 0;
    const result = db.run(
      sql`UPDATE "Comment"
             SET url = ${newUrl}
           WHERE lower(trim("email")) = ${normalized}
             AND status NOT IN ('rejected', 'deleted')
             AND url IS NOT NULL
             AND trim(url) <> ''
             AND url <> ${newUrl}`
    );
    return Number(result.changes ?? 0);
  }

  /*
   * 删除评论（递归删除子评论）
   */
  async deleteComment(id: number) {
    // 先查询所有需要删除的评论ID（包括子孙节点）
    const deleteQueue: number[] = [];
    const queue: number[] = [id];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      deleteQueue.push(currentId);
      const rows = (await db
        .select({ id: schema.comments.id })
        .from(schema.comments)
        .where(eq(schema.comments.parent_id, currentId))
        .all()) as unknown as { id: number }[];

      rows.forEach((child) => {
        queue.push(child.id);
      });
    }

    // 并不真实删除，而是改变状态
    return await db
      .update(schema.comments)
      .set({ status: "deleted" })
      .where(inArray(schema.comments.id, deleteQueue))
      .run();
  }

  /*
   * 修改评论状态
   *
   * 级联语义（与 Go/Worker 保持一致，见 C6）：
   *  - deleted / pending：连同全部子孙评论一起修改（删除/打回一条评论时，
   *    其下的回复不应继续可见或保留旧状态）
   *  - approved / rejected：只修改本条
   */
  async updateCommentStatus(id: number, status: string): Promise<Comment> {
    if (status === "deleted" || status === "pending") {
      db.run(sql`
        WITH RECURSIVE comment_tree AS (
          SELECT id FROM "Comment" WHERE id = ${id}
          UNION ALL
          SELECT c.id FROM "Comment" c
          INNER JOIN comment_tree ct ON c.parent_id = ct.id
        )
        UPDATE "Comment" SET status = ${status} WHERE id IN (SELECT id FROM comment_tree)
      `);
    } else {
      await db
        .update(schema.comments)
        .set({ status })
        .where(eq(schema.comments.id, id))
        .run();
    }

    const updated = await this.getCommentById(id);
    // 调用方（handler）已做过存在性校验，此处仅作为并发删除等竞态的兜底
    if (!updated) throw new Error("Comment not found after update");
    return updated;
  }

  /*
   * 修改评论内容
   */
  async updateComment(id: number, fields: Record<string, any>): Promise<Comment> {
    const allowed = ["author", "email", "content_text", "content_html", "url"];
    const data: Record<string, any> = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        data[key] = fields[key];
      }
    }

    await db
      .update(schema.comments)
      .set(data)
      .where(eq(schema.comments.id, id))
      .run();

    const updated = await this.getCommentById(id);
    // 调用方（handler）已做过存在性校验，此处仅作为并发删除等竞态的兜底
    if (!updated) throw new Error("Comment not found after update");
    return updated;
  }

  /*
   * 获取统计概览数据
   */
  async getStatsOverview(range: number = 7) {
    // 总评论数
    const totalResult = db
      .select({ value: count() })
      .from(schema.comments)
      .all() as unknown as { value: number }[];
    const totalComments = totalResult[0]?.value ?? 0;

    // 状态分布
    const statusGroup = db
      .select({
        status: schema.comments.status,
        value: count(),
      })
      .from(schema.comments)
      .groupBy(schema.comments.status)
      .all() as unknown as { status: string; value: number }[];

    const statusDistribution = {
      approved: 0,
      pending: 0,
      deleted: 0,
    };
    statusGroup.forEach((g) => {
      if (g.status === "approved") statusDistribution.approved = g.value;
      else if (g.status === "pending") statusDistribution.pending = g.value;
      else if (g.status === "deleted") statusDistribution.deleted = g.value;
    });

    // 统计唯一文章数量
    const posts = db
      .select({ slug: schema.comments.post_slug })
      .from(schema.comments)
      .all() as unknown as { slug: string }[];
    const uniqueSlugs = new Set(posts.map((p) => p.slug));
    const totalPosts = uniqueSlugs.size;

    // 统计唯一用户数量（author + email 组合）
    const rawUsers = db
      .select({ author: schema.comments.author, email: schema.comments.email })
      .from(schema.comments)
      .all() as unknown as { author: string; email: string }[];
    const userSet = new Set(rawUsers.map((u) => `${u.author}|${u.email}`));
    const totalUsers = userSet.size;

    // 最近 N 天评论趋势
    const now = new Date();
    const recentComments: { date: string; count: number }[] = [];

    if (range === 0) {
      // 最近 12 个月：按月聚合
      const monthlyMap = new Map<string, number>();
      const twelveMonthsAgo = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)
      );
      const allForTrend = db
        .select({ pub_date: schema.comments.pub_date })
        .from(schema.comments)
        .where(gte(schema.comments.pub_date, twelveMonthsAgo.getTime()))
        .orderBy(asc(schema.comments.pub_date))
        .all() as unknown as { pub_date: string }[];

      // 初始化最近 12 个月
      for (let i = 11; i >= 0; i--) {
        const d = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)
        );
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        monthlyMap.set(key, 0);
      }
      allForTrend.forEach((c) => {
        const d = new Date(c.pub_date);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        if (monthlyMap.has(key)) {
          monthlyMap.set(key, (monthlyMap.get(key) || 0) + 1);
        }
      });
      Array.from(monthlyMap.entries()).forEach(([date, count]) => {
        recentComments.push({ date, count });
      });
    } else {
      const daysBack = range - 1;
      const dayMap = new Map<string, number>();
      for (let i = daysBack; i >= 0; i--) {
        const d = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)
        );
        dayMap.set(d.toISOString().slice(0, 10), 0);
      }

      const startDate = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack)
      );

      const recent = db
        .select({ pub_date: schema.comments.pub_date })
        .from(schema.comments)
        .where(gte(schema.comments.pub_date, startDate.getTime()))
        .orderBy(asc(schema.comments.pub_date))
        .all() as unknown as { pub_date: string }[];

      recent.forEach((c) => {
        const key = new Date(c.pub_date).toISOString().slice(0, 10);
        if (dayMap.has(key)) {
          dayMap.set(key, (dayMap.get(key) || 0) + 1);
        }
      });
      Array.from(dayMap.entries()).forEach(([date, count]) => {
        recentComments.push({ date, count });
      });
    }

    // 热门评论者 Top 5
    const commenterMap = new Map<
      string,
      { author: string; email: string; count: number; lastCommentDate: string }
    >();
    const allForCommenters = db
      .select({
        author: schema.comments.author,
        email: schema.comments.email,
        pub_date: schema.comments.pub_date,
      })
      .from(schema.comments)
      .orderBy(desc(schema.comments.pub_date))
      .all() as unknown as { author: string; email: string; pub_date: string }[];

    allForCommenters.forEach((c) => {
      const key = `${c.author}|${c.email}`;
      if (commenterMap.has(key)) {
        const existing = commenterMap.get(key)!;
        existing.count++;
      } else {
        commenterMap.set(key, {
          author: c.author,
          email: c.email,
          count: 1,
          lastCommentDate: c.pub_date,
        });
      }
    });
    const topCommenters = Array.from(commenterMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((c) => ({
        author: c.author,
        email: c.email,
        count: c.count,
        lastCommentDate: new Date(c.lastCommentDate).toISOString(),
      }));

    // 时间窗口指标
    //
    // 窗口起点必须与上面趋势分桶的起点**严格一致**，否则「窗口新增」和折线图的总和对不上
    // （range=0 时折线图是 12 个自然月，不是滚动 365 天）。
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let windowStart: number;
    let prevWindowStart: number;
    if (range === 0) {
      windowStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1);
      prevWindowStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 23, 1);
    } else {
      windowStart = todayStart - (range - 1) * MS_PER_DAY;
      prevWindowStart = windowStart - range * MS_PER_DAY;
    }

    /** 窗口内评论数（含所有状态）：[from, to) */
    const countInWindow = (from: number, to?: number): number => {
      const conditions = [gte(schema.comments.pub_date, from)];
      if (to !== undefined) conditions.push(lt(schema.comments.pub_date, to));
      const row = db
        .select({ value: count() })
        .from(schema.comments)
        .where(and(...conditions))
        .all() as unknown as { value: number }[];
      return row[0]?.value ?? 0;
    };

    /** 窗口内活跃评论者数（author + email 去重，与 totalUsers 同口径） */
    const usersInWindow = (from: number, to?: number): number => {
      const conditions = [gte(schema.comments.pub_date, from)];
      if (to !== undefined) conditions.push(lt(schema.comments.pub_date, to));
      const rows = db
        .select({ author: schema.comments.author, email: schema.comments.email })
        .from(schema.comments)
        .where(and(...conditions))
        .all() as unknown as { author: string; email: string }[];
      return new Set(rows.map((u) => `${u.author}|${u.email}`)).size;
    };

    const windowComments = countInWindow(windowStart);
    const prevWindowComments = countInWindow(prevWindowStart, windowStart);
    const windowUsers = usersInWindow(windowStart);
    const prevWindowUsers = usersInWindow(prevWindowStart, windowStart);
    // 「今日」「近 7 天」与窗口无关，统一按 UTC 日切分（与趋势分桶同一时区口径）
    const todayComments = countInWindow(todayStart);
    const last7DaysComments = countInWindow(todayStart - 6 * MS_PER_DAY);

    // 热门文章 Top 5（并列时按文章标识升序，保证三端顺序一致）
    const postRows = db
      .select({
        postSlug: schema.comments.post_slug,
        value: count(),
        lastDate: sql<number>`MAX(${schema.comments.pub_date})`,
      })
      .from(schema.comments)
      .groupBy(schema.comments.post_slug)
      .orderBy(desc(count()), asc(schema.comments.post_slug))
      .limit(5)
      .all() as unknown as { postSlug: string; value: number; lastDate: number }[];

    const topPosts = postRows.map((p) => ({
      postSlug: p.postSlug,
      count: p.value,
      lastCommentDate: new Date(p.lastDate).toISOString(),
    }));

    // 客户端分布 Top 5：先按原始值分组，再归一化 + 同名合并（见 utils/statsDistribution.ts）
    // 列类型用 AnySQLiteColumn：三列虽然都是 TEXT，但 Drizzle 的列类型按列名标称，不能互相赋值
    const distributionOf = (
      column: AnySQLiteColumn,
      normalize: (raw: string | null | undefined) => string
    ) => {
      const rows = db
        .select({ name: column, value: count() })
        .from(schema.comments)
        .groupBy(column)
        .all() as unknown as { name: string | null; value: number }[];
      return mergeDistribution(
        rows.map((row) => ({ name: row.name, count: row.value })),
        normalize
      );
    };

    const deviceDistribution = distributionOf(schema.comments.device, normalizeDeviceType);
    const browserDistribution = distributionOf(schema.comments.browser, normalizeBrowserFamily);
    const osDistribution = distributionOf(schema.comments.os, normalizeOsFamily);

    // 最新评论动态（最近 5 条，含所有状态；并列时间用 id 兜底排序）
    const latestRows = db
      .select({
        id: schema.comments.id,
        author: schema.comments.author,
        email: schema.comments.email,
        postSlug: schema.comments.post_slug,
        contentText: schema.comments.content_text,
        status: schema.comments.status,
        pubDate: schema.comments.pub_date,
      })
      .from(schema.comments)
      .orderBy(desc(schema.comments.pub_date), desc(schema.comments.id))
      .limit(5)
      .all() as unknown as {
      id: number;
      author: string;
      email: string;
      postSlug: string;
      contentText: string;
      status: string;
      pubDate: number;
    }[];

    const latestComments = latestRows.map((c) => ({
      id: c.id,
      author: c.author,
      email: c.email,
      postSlug: c.postSlug,
      contentText: c.contentText,
      status: c.status,
      pubDate: new Date(c.pubDate).toISOString(),
    }));

    return {
      totalComments,
      totalUsers,
      totalPosts,
      statusDistribution,
      recentComments,
      topCommenters,
      windowComments,
      prevWindowComments,
      commentsDelta: deltaPct(windowComments, prevWindowComments),
      windowUsers,
      prevWindowUsers,
      usersDelta: deltaPct(windowUsers, prevWindowUsers),
      todayComments,
      last7DaysComments,
      topPosts,
      deviceDistribution,
      browserDistribution,
      osDistribution,
      latestComments,
    };
  }

  /*
   * 获取用户列表（按 author + email 分组）
   * 支持按昵称/邮箱搜索（不区分大小写）、按邮箱验证状态与网站链接状态筛选
   */
  async getUserList(
    page: number,
    limit: number,
    search?: string,
    verified?: string,
    linkStatusFilter?: string
  ) {
    // 获取所有唯一用户
    const rawUsers = db
      .select({
        author: schema.comments.author,
        email: schema.comments.email,
      })
      .from(schema.comments)
      .all() as unknown as { author: string; email: string }[];

    // 手动去重 (Drizzle SQLite 的 distinct 不支持多列)
    const uniqueMap = new Map<string, { author: string; email: string }>();
    rawUsers.forEach((u) => {
      const key = `${u.author}|${u.email}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, u);
      }
    });
    let uniqueUsers = Array.from(uniqueMap.values());

    // 邮箱验证记录（精确匹配 email，与 checkEmailVerified 的判定保持一致）
    const verifiedRows = db
      .select({
        email: schema.emailVerifications.email,
        verified_at: schema.emailVerifications.verified_at,
      })
      .from(schema.emailVerifications)
      .where(eq(schema.emailVerifications.verified, 1))
      .all() as unknown as { email: string; verified_at: string | null }[];

    const verifiedAtMap = new Map<string, string>();
    verifiedRows.forEach((r) => {
      const current = verifiedAtMap.get(r.email);
      const at = r.verified_at || "";
      if (current === undefined || (at && at > current)) {
        verifiedAtMap.set(r.email, at);
      }
    });

    // 邮箱验证筛选：true = 已验证，false = 未验证，其余不筛选
    if (verified === "true") {
      uniqueUsers = uniqueUsers.filter((u) => verifiedAtMap.has(u.email));
    } else if (verified === "false") {
      uniqueUsers = uniqueUsers.filter((u) => !verifiedAtMap.has(u.email));
    }

    // 按昵称/邮箱搜索（不区分大小写）
    const keyword = (search || "").trim().toLowerCase();
    if (keyword) {
      uniqueUsers = uniqueUsers.filter(
        (u) =>
          u.author.toLowerCase().includes(keyword) ||
          u.email.toLowerCase().includes(keyword)
      );
    }

    // 加载邮箱黑名单（小写归一化，用于标记用户是否已被拉黑）
    let emailBlacklist: string[] = [];
    const blacklistStr = await getSetting("email_blacklist");
    if (blacklistStr) {
      try {
        const parsed = JSON.parse(blacklistStr);
        if (Array.isArray(parsed)) {
          emailBlacklist = parsed.map((e) => String(e).toLowerCase());
        }
      } catch {
        // 忽略无效的黑名单数据
      }
    }

    // 链接安全审查：给**全部**用户算一次链接状态（筛选必须发生在分页之前），
    // 仍然只多两次查询（最后评论时间/最新网址 + 未过期的人工确认），不会变成 N+1。
    // 功能关闭时 `urlDormant` 恒为 false，但 `url` 仍然下发，后台照样能看到用户留的链接。
    const linkSecurityEnabled = resolveLinkSwitch(await getSetting(LINK_SECURITY_ENABLED_KEY));
    const linkDormantDays = await getSetting(LINK_DORMANT_DAYS_KEY);
    const now = Date.now();
    const allEmails = uniqueUsers.map((u) => u.email);
    const linkStatusMap = await this.getLinkStatusByEmail(allEmails);
    // 人工确认（未过期）的 (邮箱, 网址)：与「最后评论时间」一起算进 urlDormant
    const trustedLinks = await this.getActiveTrustedLinks(allEmails, now);

    /**
     * 单个用户的网站链接状态（面板 `linkStatus()` 的同一口径）：
     * none 无链接 / trusted 人工确认未过期 / dormant 休眠 / normal 正常。
     */
    const linkStateOf = (email: string) => {
      const link = linkStatusMap.get(normalizeEmail(email));
      const url = link?.latestUrl ?? "";
      const trust = url === "" ? undefined : trustedLinks.get(linkTrustKey(email, url));
      const urlTrustedUntil = trust?.expiresAt ?? "";
      const urlTrustedSource = trust?.source ?? "";
      const urlDormant = isLinkDormant({
        enabled: linkSecurityEnabled,
        hasUrl: url !== "",
        days: linkDormantDays,
        ageMs: link === undefined ? null : now - link.lastAt,
        trusted: urlTrustedUntil !== "",
      });
      const status =
        url === "" ? "none" : urlTrustedUntil !== "" ? "trusted" : urlDormant ? "dormant" : "normal";
      return { url, urlDormant, urlTrustedUntil, urlTrustedSource, status };
    };

    // 按网站链接状态筛选（dormant / trusted / normal / none；缺省与无法识别的取值都不筛选）
    const wantedLinkStatus = ["dormant", "trusted", "normal", "none"].includes(
      String(linkStatusFilter ?? "")
    )
      ? String(linkStatusFilter)
      : "all";
    if (wantedLinkStatus !== "all") {
      uniqueUsers = uniqueUsers.filter((u) => linkStateOf(u.email).status === wantedLinkStatus);
    }

    const total = uniqueUsers.length;
    const totalPages = Math.ceil(total / limit);
    const startIndex = (page - 1) * limit;
    const pageUsers = uniqueUsers.slice(startIndex, startIndex + limit);

    const users = await Promise.all(
      pageUsers.map(async (u) => {
        const comments = db
          .select({
            status: schema.comments.status,
            pub_date: schema.comments.pub_date,
          })
          .from(schema.comments)
          .where(
            and(
              eq(schema.comments.author, u.author),
              eq(schema.comments.email, u.email)
            )
          )
          .orderBy(desc(schema.comments.pub_date))
          .all() as unknown as { status: string; pub_date: string }[];

        const commentCount = comments.length;
        const approvedCount = comments.filter((c) => c.status === "approved").length;
        const pendingCount = comments.filter((c) => c.status === "pending").length;
        const deletedCount = comments.filter((c) => c.status === "deleted").length;
        const firstCommentDate =
          comments.length > 0 ? new Date(comments[comments.length - 1].pub_date).toISOString() : "";
        const lastCommentDate =
          comments.length > 0 ? new Date(comments[0].pub_date).toISOString() : "";

        // 网站链接状态：复用上面按「全部用户」算好的结果（身份口径与公开评论区一致）
        const { url, urlDormant, urlTrustedUntil, urlTrustedSource } = linkStateOf(u.email);

        return {
          author: u.author,
          email: u.email,
          url,
          urlDormant,
          urlTrustedUntil,
          urlTrustedSource,
          commentCount,
          approvedCount,
          pendingCount,
          deletedCount,
          firstCommentDate,
          lastCommentDate,
          blacklisted: emailBlacklist.includes(u.email.toLowerCase()),
          emailVerified: verifiedAtMap.has(u.email),
          emailVerifiedAt: verifiedAtMap.get(u.email) || "",
        };
      })
    );

    return { users, pagination: { page, limit, totalPage: totalPages } };
  }

  /*
   * 获取指定用户的所有评论
   */
  async getUserComments(author: string, email: string, page: number) {
    const limit = 10;

    // 计算总数
    const countResult = db
      .select({ value: count() })
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.author, author),
          eq(schema.comments.email, email)
        )
      )
      .all() as unknown as { value: number }[];
    const total = countResult[0]?.value ?? 0;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;

    const rows = db
      .select()
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.author, author),
          eq(schema.comments.email, email)
        )
      )
      .orderBy(desc(schema.comments.pub_date))
      .limit(limit)
      .offset(offset)
      .all() as unknown as CommentRow[];

    const formattedComments = rows.map((c) => ({
      id: c.id,
      pubDate: new Date(c.pub_date).toISOString(),
      postSlug: c.post_slug,
      author: c.author,
      email: c.email,
      url: c.url || undefined,
      ipAddress: c.ip_address || "",
      os: c.os || "",
      browser: c.browser || "",
      contentText: c.content_text,
      contentHtml: c.content_html,
      status: c.status,
    }));

    return {
      comments: formattedComments,
      pagination: { page, limit, totalPage: totalPages },
    };
  }
}

export default new CommentService();
