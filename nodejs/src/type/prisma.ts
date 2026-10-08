import { InferSelectModel } from "drizzle-orm";
import { comments } from "../orm/schema";

/**
 * 替换 Prisma 生成的 Comment 类型，改用 Drizzle 推断类型
 * pub_date 在 SQLite 中存储为毫秒时间戳（INTEGER），代码中使用 Date 对象
 */
export type CommentRow = InferSelectModel<typeof comments>;

export interface Comment {
  id: number;
  pub_date: Date;
  post_slug: string;
  author: string;
  email: string;
  url: string | null;
  ip_address: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  user_agent: string | null;
  content_text: string;
  content_html: string;
  parent_id: number | null;
  status: string;
}

export interface CreateCommentInput {
  id?: number;
  pub_date: number;
  post_slug: string;
  author: string;
  email: string;
  url?: string;
  ip_address?: string;
  device?: string;
  browser?: string;
  os?: string;
  user_agent?: string;
  content_text: string;
  content_html: string;
  parent_id: number | null;
  status: string;
}

/** 将数据库行（字符串日期）转换为应用层 Comment（Date 日期） */
export function rowToComment(row: CommentRow): Comment {
  return {
    ...row,
    pub_date: new Date(row.pub_date),
  };
}

/**
 * 将 Comment 数组批量转换
 */
export function rowsToComments(rows: CommentRow[]): Comment[] {
  return rows.map(rowToComment);
}
