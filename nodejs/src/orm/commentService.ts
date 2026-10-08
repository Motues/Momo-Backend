import { db, schema } from "./client";
import { eq, and, inArray, desc, gte, asc, count, sql } from "drizzle-orm";
import { Comment, CreateCommentInput, rowToComment, rowsToComments, CommentRow } from "../type/prisma";
import { getSetting } from "../utils/settings";

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
   * 支持按状态筛选
   */
  async getAllComments(status?: string): Promise<Comment[]> {
    const conditions = [];
    if (status) {
      conditions.push(eq(schema.comments.status, status));
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
   */
  async updateCommentStatus(id: number, status: string): Promise<Comment> {
    await db
      .update(schema.comments)
      .set({ status })
      .where(eq(schema.comments.id, id))
      .run();

    const updated = await this.getCommentById(id);
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

    return {
      totalComments,
      totalUsers,
      totalPosts,
      statusDistribution,
      recentComments,
      topCommenters,
    };
  }

  /*
   * 获取用户列表（按 author + email 分组）
   * 支持按昵称/邮箱搜索（不区分大小写），并标记邮箱是否在黑名单中
   */
  async getUserList(page: number, limit: number, search?: string, verified?: string) {
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

        return {
          author: u.author,
          email: u.email,
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
