import { Comment } from "../generated/prisma/client";

interface CreateCommentInput {
  id?: number;
  pub_date: string;
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


export { Comment, CreateCommentInput };