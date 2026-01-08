import { Comment } from "../type/prisma";
import { CommentsResponse, NestedCommentsResponse, NestedComment, CommentAdminResponse } from "../type/api";
import { getAvatar } from "../utils/getAvatar";

/*
* 将数据库获取的评论数据，按照指定的格式处理后返回给前端
*/
const getResponseComment = 
async (comments: Comment[] | null, page: number, limit: number, nested: boolean): Promise<CommentsResponse | NestedCommentsResponse> => {
  if(comments === null) {
    return { data: [], pagination: { page, limit, total: 0 } };
  }
  if (nested) {
    // 构建嵌套结构的评论数据
    const nestedComments = await buildNestedComments(comments);
    return {
      data: nestedComments,
      pagination: {
        page,
        limit,
        total: Math.ceil(comments.length/limit),
      },
    }
  } else {
    // 构建平面结构的评论数据
    const plainComments = await Promise.all(comments.map(async comment => ({
      id: comment.id,
      author: comment.author,
      url: comment.url || undefined,
      avatar: await getAvatar(comment.author, comment.email),
      contentText: comment.content_text,
      contentHtml: comment.content_html,
      pubDate: comment.pub_date.toISOString(),
      parentId: comment.parent_id
    })));
    
    return {
      data: plainComments,
      pagination: {
        page,
        limit,
        total: comments.length
      }
    };
  }
};

// 辅助函数：构建嵌套评论结构
const buildNestedComments = async (comments: Comment[]): Promise<NestedComment[]> => {
  // 创建评论映射以便快速查找
  const commentMap = new Map<number, NestedComment>();
  const rootComments: NestedComment[] = [];
  
  // 初始化所有评论
  const initializedComments = await Promise.all(comments.map(async comment => {
    return {
      id: comment.id,
      author: comment.author,
      avatar: await getAvatar(comment.author, comment.email),
      url: comment.url || undefined,
      contentText: comment.content_text,
      contentHtml: comment.content_html,
      pubDate: comment.pub_date.toISOString(),
      replies: [] as NestedComment[]
    };
  }));
  
  initializedComments.forEach(comment => {
    commentMap.set(comment.id, comment);
  });
  
  // 构建父子关系
  comments.forEach(comment => {
    const commentNode = commentMap.get(comment.id)!;
    if (comment.parent_id === null) {
      // 顶级评论
      rootComments.push(commentNode);
    } else {
      // 子评论
      const parent = commentMap.get(comment.parent_id);
      if (parent) {
        parent.replies.push(commentNode);
      }
    }
  });
  
  return rootComments;
};

/*
* 将数据库获取的评论数据，按照指定的格式处理后返回给前端
*/
const getResponseCommentAdmin = async (comments: Comment[] | null, page: number): Promise<CommentAdminResponse> => {
  if(comments === null) {
    return { data: [], pagination: { page: 1, limit: 20, total: 0 } };
  }
  
  const limit = 10;
  const total = comments.length;
  const totalPages = Math.ceil(total / limit);
  
  // 计算当前页的评论数据
  const startIndex = (page - 1) * limit;
  const endIndex = Math.min(startIndex + limit, total);
  const pageComments = comments.slice(startIndex, endIndex);
  
  // 构建管理员界面的评论数据
  const adminComments = await Promise.all(pageComments.map(async comment => ({
    id: comment.id,
    pubDate: comment.pub_date.toISOString(),
    author: comment.author,
    email: comment.email,
    url: comment.url || undefined,
    ipAddress: comment.ip_address || '',
    contentText: comment.content_text,
    contentHtml: comment.content_html,
    status: comment.status
  })));

  return {
    data: adminComments,
    pagination: {
      page: page,
      limit: limit,
      total: totalPages
    }
  };
};

export { getResponseComment, getResponseCommentAdmin };