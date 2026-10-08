import { Comment } from "../type/prisma";
import { CommentsResponse, NestedCommentsResponse, NestedComment, CommentAdminResponse } from "../type/api";
import { getAvatar } from "../utils/getAvatar";
import { getSetting } from "../utils/settings";
import { getPublicVerifyConfig } from "../utils/verify";
import crypto from "crypto";

/*
* 将数据库获取的评论数据，按照指定的格式处理后返回给前端
*/
const getResponseComment =
async (comments: Comment[] | null, page: number, limit: number, nested: boolean, postSlug: string = ""): Promise<CommentsResponse | NestedCommentsResponse> => {
  // 读取博主标识设置
  const adminEmail = await getSetting("admin_email") || "";
  const badgeEnabled = await getSetting("blogger_badge_enabled") || "false";
  const badgeText = await getSetting("blogger_badge_text") || "";
  const placeholderName = await getSetting("placeholder_name") || "";
  const placeholderEmail = await getSetting("placeholder_email") || "";
  const placeholderContent = await getSetting("placeholder_content") || "";
  const placeholderUrl = await getSetting("placeholder_url") || "";
  const adminCommentKey = await getSetting("admin_comment_key") || "";
  const adminCommentKeyEnabled = await getSetting("admin_comment_key_enabled") || "false";
  // 邮箱哈希仅供前端判断「是否需要显示管理员密钥输入框」。
  // 只有在博主密钥功能开启时才下发，避免被用于离线枚举管理员邮箱。
  const adminEmailHash = adminEmail && adminCommentKeyEnabled === "true"
    ? crypto.createHash("sha256").update(adminEmail.toLowerCase().trim()).digest("hex")
    : "";
  // 无感验证公开配置（开关 + 按文章派生的蜜罐字段名）
  const verifyConfig = await getPublicVerifyConfig(postSlug);

  if(comments === null) {
    return {
      code: 200,
      message: "Comments fetched successfully",
      data: {
        comments: [],
        pagination: { page, limit, totalPage: 0 },
        blogger_badge_enabled: badgeEnabled,
        blogger_badge_text: badgeText,
        placeholder_name: placeholderName,
        placeholder_email: placeholderEmail,
        placeholder_content: placeholderContent,
        placeholder_url: placeholderUrl,
        admin_comment_key_configured: adminCommentKey && adminCommentKeyEnabled === "true" ? "true" : "false",
        admin_email_hash: adminEmailHash,
        verify_enabled: verifyConfig.verify_enabled,
        verify_honeypot: verifyConfig.verify_honeypot,
      }
    };
  }
  if (nested) {
    // 构建嵌套结构的评论数据
    const nestedComments = await buildNestedComments(comments, adminEmail);
    // 对根评论进行分页
    const rootTotal = nestedComments.length;
    const start = (page - 1) * limit;
    const paginatedRoots = nestedComments.slice(start, start + limit);
    return {
      code: 200,
      message: "Comments fetched successfully",
      data: {
        comments: paginatedRoots,
        pagination: {
          page,
          limit,
          totalPage: Math.ceil(rootTotal / limit) || 1,
        },
        blogger_badge_enabled: badgeEnabled,
        blogger_badge_text: badgeText,
        placeholder_name: placeholderName,
        placeholder_email: placeholderEmail,
        placeholder_content: placeholderContent,
        placeholder_url: placeholderUrl,
        admin_comment_key_configured: adminCommentKey && adminCommentKeyEnabled === "true" ? "true" : "false",
        admin_email_hash: adminEmailHash,
        verify_enabled: verifyConfig.verify_enabled,
        verify_honeypot: verifyConfig.verify_honeypot,
      }
    }
  } else {
    // 构建平面结构的评论数据，按页截取
    const total = comments.length;
    const start = (page - 1) * limit;
    const pageComments = comments.slice(start, start + limit);
    const plainComments = await Promise.all(pageComments.map(async comment => ({
      id: comment.id,
      author: comment.author,
      url: comment.url || undefined,
      avatar: await getAvatar(comment.author, comment.email),
      contentText: comment.content_text,
      contentHtml: comment.content_html,
      pubDate: comment.pub_date.toISOString(),
      parentId: comment.parent_id,
      isBlogger: comment.email === adminEmail
    })));

    return {
      code: 200,
      message: "Comments fetched successfully",
      data: {
        comments: plainComments,
        pagination: {
          page,
          limit,
          totalPage: Math.ceil(total / limit) || 1,
        },
        blogger_badge_enabled: badgeEnabled,
        blogger_badge_text: badgeText,
        placeholder_name: placeholderName,
        placeholder_email: placeholderEmail,
        placeholder_content: placeholderContent,
        placeholder_url: placeholderUrl,
        admin_comment_key_configured: adminCommentKey && adminCommentKeyEnabled === "true" ? "true" : "false",
        admin_email_hash: adminEmailHash,
        verify_enabled: verifyConfig.verify_enabled,
        verify_honeypot: verifyConfig.verify_honeypot,
      }
    };
  }
};

// 辅助函数：构建嵌套评论结构
const buildNestedComments = async (comments: Comment[], adminEmail: string): Promise<NestedComment[]> => {
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
      replies: [] as NestedComment[],
      isBlogger: comment.email === adminEmail
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
    return { 
      code: 200,
      message: "Comments fetched successfully",
      data: {
        comments: [], 
        pagination: { page: 1, limit: 20, totalPage: 0 } 
      }
    }
  };
  
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
    postSlug: comment.post_slug,
    author: comment.author,
    email: comment.email,
    url: comment.url || undefined,
    ipAddress: comment.ip_address || '',
    os: comment.os || '',
    browser: comment.browser || '',
    contentText: comment.content_text,
    contentHtml: comment.content_html,
    status: comment.status
  })));

  return {
    code: 200,
    message: "Comments fetched successfully",
    data: {
      comments: adminComments,
      pagination: {
        page: page,
        limit: limit,
        totalPage: totalPages
      }
    }
  };
};

export { getResponseComment, getResponseCommentAdmin };