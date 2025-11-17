interface Comment {
  id: number;
  author: string;
  url?: string;
  avatar?: string;
  contentText: string;
  contentHtml: string;
  pubDate: string;
  parentId: number | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
}

interface CommentsResponse {
  data: Comment[];
  pagination: Pagination;
}

interface NestedComment {
  id: number;
  author: string;
  avatar?: string;
  contentText: string;
  contentHtml: string;
  pubDate: string;
  replies: NestedComment[];
}

interface NestedCommentsResponse {
  data: NestedComment[];
  pagination: Pagination;
}

interface CommentAdmin {
  id: number;
  pubDate: string;
  author: string;
  email: string;
  url?: string;
  ipAddress: string;
  contentText: string;
  contentHtml: string;
  status: string;
}
interface CommentAdminResponse {
  data: CommentAdmin[];
  pagination: Pagination;
}

export type { CommentsResponse, NestedCommentsResponse, NestedComment, Comment, CommentAdmin, CommentAdminResponse };