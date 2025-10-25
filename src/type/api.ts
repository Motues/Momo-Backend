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

export type { CommentsResponse, NestedCommentsResponse, NestedComment, Comment };