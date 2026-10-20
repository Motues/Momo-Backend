interface Comment {
  id: number;
  author: string;
  url?: string;
  avatar?: string;
  contentText: string;
  contentHtml: string;
  pubDate: string;
  parentId: number | null;
  isBlogger?: boolean;
  /** 链接安全审查：该评论的个人网址是否处于「休眠」（见 doc/link_security.md 第 2 节） */
  urlDormant?: boolean;
}

interface Pagination {
  page: number;
  limit: number;
  totalPage: number;
}

interface CommentsResponse {
  code: number;
  message: string;
  data: {
    comments: Comment[];
    pagination: Pagination;
    blogger_badge_enabled?: string;
    blogger_badge_text?: string;
    placeholder_name?: string;
    placeholder_email?: string;
    placeholder_content?: string;
    placeholder_url?: string;
    admin_comment_key_configured?: string;
    admin_email_hash?: string;
    /** 多管理员：每个管理员邮箱的 sha256（仅密钥功能开启时下发） */
    admin_email_hashes?: string[];
    verify_enabled?: string;
    verify_honeypot?: string;
    verify_version?: string;
    /** 是否在评论区显示表情按钮："true" / "false"（未配置时为 "true"） */
    emoji_enabled?: string;
    /** 兼容旧前端：表情来源列表的第一个地址 */
    emoji_cdn_url?: string;
    /** OwO 格式（owo.json 同构）的表情来源列表；未配置时回落默认源 */
    emoji_cdn_urls?: string[];
  }
}

interface NestedComment {
  id: number;
  author: string;
  avatar?: string;
  contentText: string;
  contentHtml: string;
  pubDate: string;
  replies: NestedComment[];
  isBlogger?: boolean;
  /** 链接安全审查：该评论的个人网址是否处于「休眠」 */
  urlDormant?: boolean;
}

interface NestedCommentsResponse {
  code: number;
  message: string;
  data: {
    comments: NestedComment[];
    pagination: Pagination;
    blogger_badge_enabled?: string;
    blogger_badge_text?: string;
    placeholder_name?: string;
    placeholder_email?: string;
    placeholder_content?: string;
    placeholder_url?: string;
    admin_comment_key_configured?: string;
    admin_email_hash?: string;
    /** 多管理员：每个管理员邮箱的 sha256（仅密钥功能开启时下发） */
    admin_email_hashes?: string[];
    verify_enabled?: string;
    verify_honeypot?: string;
    verify_version?: string;
    /** 是否在评论区显示表情按钮："true" / "false"（未配置时为 "true"） */
    emoji_enabled?: string;
    /** 兼容旧前端：表情来源列表的第一个地址 */
    emoji_cdn_url?: string;
    /** OwO 格式（owo.json 同构）的表情来源列表；未配置时回落默认源 */
    emoji_cdn_urls?: string[];
  }
}

interface CommentAdmin {
  id: number;
  pubDate: string;
  postSlug: string;
  author: string;
  email: string;
  url?: string;
  ipAddress: string;
  os: string;
  browser: string;
  contentText: string;
  contentHtml: string;
  status: string;
}
interface CommentAdminResponse {
  code: number;
  message: string;
  data: {
    comments: CommentAdmin[];
    pagination: Pagination;
  }
}

// Stats types
interface UserStats {
  author: string;
  email: string;
  commentCount: number;
  approvedCount: number;
  pendingCount: number;
  deletedCount: number;
  firstCommentDate: string;
  lastCommentDate: string;
  /** 该邮箱最近一次留下的非空个人网址（从未留过时为空串） */
  url?: string;
  /** 该网址是否休眠（人工确认未过期时为 false） */
  urlDormant?: boolean;
  /** 该网址的人工确认到期时间（ISO 8601 UTC）；未确认或已过期时为空串 */
  urlTrustedUntil?: string;
  /** 该确认的来源：`admin` 管理员人工确认 / `self` 评论者本人从提醒邮件确认；无确认时为空串 */
  urlTrustedSource?: string;
}

interface StatsOverview {
  totalComments: number;
  totalUsers: number;
  totalPosts: number;
  statusDistribution: {
    approved: number;
    pending: number;
    deleted: number;
  };
  recentComments: {
    date: string;
    count: number;
  }[];
  topCommenters: {
    author: string;
    email: string;
    count: number;
    lastCommentDate: string;
  }[];
  /** 当前 range 窗口内的评论数（range=0 时为最近 12 个自然月，与 recentComments 的分桶起点一致） */
  windowComments: number;
  /** 上一个等长窗口内的评论数 */
  prevWindowComments: number;
  /** 窗口评论数环比（整数百分比）；上一窗口为空时为 null */
  commentsDelta: number | null;
  /** 窗口内活跃评论者数（author + email 去重） */
  windowUsers: number;
  prevWindowUsers: number;
  /** 活跃评论者环比（整数百分比）；上一窗口为空时为 null */
  usersDelta: number | null;
  /** 今日（UTC 日）新增评论数 */
  todayComments: number;
  /** 最近 7 个 UTC 日（含今天）新增评论数 */
  last7DaysComments: number;
  topPosts: {
    postSlug: string;
    count: number;
    lastCommentDate: string;
  }[];
  /** 归一化后的家族名分布（最多 5 档，按数量降序） */
  deviceDistribution: {
    name: string;
    count: number;
  }[];
  browserDistribution: {
    name: string;
    count: number;
  }[];
  osDistribution: {
    name: string;
    count: number;
  }[];
  latestComments: {
    id: number;
    author: string;
    email: string;
    postSlug: string;
    contentText: string;
    status: string;
    pubDate: string;
  }[];
}

interface StatsOverviewResponse {
  code: number;
  message: string;
  data: StatsOverview;
}

interface UserListResponse {
  code: number;
  message: string;
  data: {
    users: UserStats[];
    pagination: Pagination;
  }
}

interface UserCommentsResponse {
  code: number;
  message: string;
  data: {
    comments: CommentAdmin[];
    pagination: Pagination;
  }
}

export type { CommentsResponse, NestedCommentsResponse, NestedComment, Comment, CommentAdmin, CommentAdminResponse, StatsOverview, StatsOverviewResponse, UserStats, UserListResponse, UserCommentsResponse };