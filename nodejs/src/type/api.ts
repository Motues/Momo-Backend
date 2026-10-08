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
    verify_enabled?: string;
    verify_honeypot?: string;
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
    verify_enabled?: string;
    verify_honeypot?: string;
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