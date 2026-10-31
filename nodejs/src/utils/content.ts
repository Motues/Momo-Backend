import { Comment } from "../type/prisma";
import { CommentsResponse, NestedCommentsResponse, NestedComment, CommentAdminResponse } from "../type/api";
import {
  AVATAR_CUSTOM_URL_KEY,
  AVATAR_ENABLED_KEY,
  AVATAR_SOURCE_KEY,
  AvatarConfig,
  buildAvatarUrl,
  isAvatarEnabled,
  resolveAvatarConfig,
  resolveAvatarUrl,
} from "../utils/avatar";
import { getAllSettings } from "../utils/settings";
import { resolveEmojiConfigs } from "../utils/emoji";
import {
  resolveAdminEmails,
  resolveNotifyEmail,
  isAdminEmail,
  normalizeEmail,
} from "../utils/adminEmails";
import {
  LINK_DORMANT_DAYS_KEY,
  LINK_SECURITY_ENABLED_KEY,
  isLinkDormant,
  linkTrustKey,
  resolveLinkSwitch,
} from "../utils/linkSecurity";
import CommentService from "../orm/commentService";
import { getPublicVerifyConfig } from "../utils/verify";
import { notifyDormantLinks } from "../utils/dormantNotice";
import LogService from "../utils/log";
import crypto from "crypto";

/*
* 将数据库获取的评论数据，按照指定的格式处理后返回给前端
*/
const getResponseComment =
async (comments: Comment[] | null, page: number, limit: number, nested: boolean, postSlug: string = "", noticeBaseUrl: string = ""): Promise<CommentsResponse | NestedCommentsResponse> => {
  // 设置快照：公开列表原本逐键查询约 20 次（Worker 的 D1 每次都是一次往返），
  // 改成一次 SELECT 后在内存解析。缺键与读库失败保持原来的 fail-open 语义。
  const settings = await getAllSettings();
  const setting = (key: string): string | null => settings[key] ?? null;
  // 管理员列表（多邮箱）：列表里的人都是博主；列表为空时回落旧的单邮箱键
  const storedAdminEmails = setting("admin_emails");
  const storedAdminEmail = setting("admin_email");
  const admins = await resolveAdminEmails(storedAdminEmails, storedAdminEmail);
  // 通知收件人：必须命中管理员列表，否则回落列表第一个（旧前端仍拿它的哈希）
  const notifyEmail = await resolveNotifyEmail(
    setting("notify_email"),
    storedAdminEmails,
    storedAdminEmail
  );
  // 读取博主标识设置
  const badgeEnabled = setting("blogger_badge_enabled") || "false";
  const badgeText = setting("blogger_badge_text") || "";
  const placeholderName = setting("placeholder_name") || "";
  const placeholderEmail = setting("placeholder_email") || "";
  const placeholderContent = setting("placeholder_content") || "";
  const placeholderUrl = setting("placeholder_url") || "";
  const adminCommentKey = setting("admin_comment_key") || "";
  const adminCommentKeyEnabled = setting("admin_comment_key_enabled") || "false";
  const keyEnabled = adminCommentKeyEnabled === "true";
  // 邮箱哈希仅供前端判断「是否需要显示管理员密钥输入框」。
  // 只有在博主密钥功能开启时才下发，避免被用于离线枚举管理员邮箱。
  const hashEmail = (email: string) =>
    crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex");
  const adminEmailHashes = keyEnabled ? admins.map(hashEmail) : [];
  const adminEmailHash = keyEnabled && notifyEmail ? hashEmail(notifyEmail) : "";
  // 无感验证公开配置（开关 + 按文章派生的蜜罐字段名）：保留内部读取，
  // 关闭时只有 1 次查询，且 getSecret 在缺密钥时需要落库，不适合走快照。
  const verifyConfig = await getPublicVerifyConfig(postSlug);
  // 表情配置：是否启用 + OwO 格式的表情来源列表（数组为空时回落旧键/默认源，见 doc/emoji.md）
  const emojiConfig = resolveEmojiConfigs(
    setting("emoji_cdn_urls"),
    setting("emoji_cdn_url"),
    setting("emoji_enabled")
  );
  // 头像来源：整页评论复用一份解析后的配置（口径见 doc/avatar.md）
  const avatarConfig = resolveAvatarConfig(
    setting(AVATAR_SOURCE_KEY),
    setting(AVATAR_CUSTOM_URL_KEY)
  );
  // 头像开关：关闭时整页统一下发内置默认头像（不修改已保存的来源配置）
  const avatarEnabled = isAvatarEnabled(setting(AVATAR_ENABLED_KEY));

  // 链接安全审查：按邮箱实时推导「休眠链接」（不落库、不加定时任务，见 doc/link_security.md 第 2 节）
  const securityEnabled = resolveLinkSwitch(setting(LINK_SECURITY_ENABLED_KEY));
  const dormantDays = setting(LINK_DORMANT_DAYS_KEY);
  let lastCommentTimes = new Map<string, number>();
  let trustedLinks = new Map<string, { expiresAt: string; source: string }>();
  if (securityEnabled === "true" && comments && comments.length > 0) {
    const emails = comments
      .filter((comment) => (comment.url ?? "").trim() !== "")
      .map((comment) => comment.email);
    lastCommentTimes = await CommentService.getLastCommentTimeByEmail(emails);
    // 人工确认（管理员在后台「确认安全」过、或本人从提醒邮件确认，且未过期）→ 该 (邮箱, 网址) 不再休眠
    trustedLinks = await CommentService.getActiveTrustedLinks(emails, Date.now());
  }
  const now = Date.now();
  /**
   * 某条评论的网址是否休眠：
   * 功能开启 && 未被人工确认 && 有网址 && 该邮箱最后一条评论距今严格大于 N 天
   */
  const isDormant = (comment: Comment): boolean => {
    const rawUrl = (comment.url ?? "").trim();
    const hasUrl = rawUrl !== "";
    const last = lastCommentTimes.get(normalizeEmail(comment.email));
    return isLinkDormant({
      enabled: securityEnabled,
      hasUrl,
      days: dormantDays,
      ageMs: last === undefined ? null : now - last,
      trusted: hasUrl && trustedLinks.has(linkTrustKey(comment.email, rawUrl)),
    });
  };

  // 休眠链接的惰性提醒（doc/link_security.md 第 2.7 节）：本页判为休眠的链接 → 异步发提醒邮件。
  // **刻意不 await**：提醒失败绝不能拖慢或影响评论列表的响应；同一个休眠周期只会提醒一次。
  if (securityEnabled === "true" && noticeBaseUrl && comments && comments.length > 0) {
    const dormantCandidates = comments
      .filter((comment) => (comment.url ?? "").trim() !== "" && isDormant(comment))
      .map((comment) => ({
        email: normalizeEmail(comment.email),
        author: comment.author,
        url: (comment.url ?? "").trim(),
        lastCommentAt: lastCommentTimes.get(normalizeEmail(comment.email)) ?? null,
      }));
    if (dormantCandidates.length > 0) {
      notifyDormantLinks(dormantCandidates, noticeBaseUrl).catch((error) =>
        LogService.error("休眠链接提醒处理失败:", error)
      );
    }
  }

  // 三个分支共用的元信息（形状与历史版本一致，只新增 emoji_cdn_urls / admin_email_hashes）
  const meta = {
    blogger_badge_enabled: badgeEnabled,
    blogger_badge_text: badgeText,
    placeholder_name: placeholderName,
    placeholder_email: placeholderEmail,
    placeholder_content: placeholderContent,
    placeholder_url: placeholderUrl,
    admin_comment_key_configured: adminCommentKey && keyEnabled ? "true" : "false",
    admin_email_hash: adminEmailHash,
    admin_email_hashes: adminEmailHashes,
    verify_enabled: verifyConfig.verify_enabled,
    verify_honeypot: verifyConfig.verify_honeypot,
    verify_version: verifyConfig.verify_version,
    emoji_enabled: emojiConfig.enabled,
    emoji_cdn_url: emojiConfig.url,
    emoji_cdn_urls: emojiConfig.urls,
  };

  if(comments === null) {
    return {
      code: 200,
      message: "Comments fetched successfully",
      data: {
        comments: [],
        pagination: { page, limit, totalPage: 0 },
        ...meta,
      }
    };
  }
  if (nested) {
    // 构建嵌套结构的评论数据
    const nestedComments = await buildNestedComments(comments, admins, isDormant, avatarConfig, avatarEnabled);
    // 对根评论进行分页（limit 防御性下限：limit=0 时 Math.ceil 会得到 Infinity）
    const safeLimit = Math.max(1, limit);
    const rootTotal = nestedComments.length;
    const start = (page - 1) * safeLimit;
    const paginatedRoots = nestedComments.slice(start, start + safeLimit);
    return {
      code: 200,
      message: "Comments fetched successfully",
      data: {
        comments: paginatedRoots,
        pagination: {
          page,
          limit,
          totalPage: Math.ceil(rootTotal / safeLimit) || 1,
        },
        ...meta,
      }
    }
  } else {
    // 构建平面结构的评论数据，按页截取（limit 防御性下限，避免负数页码截到最后一条）
    const safeLimit = Math.max(1, limit);
    const total = comments.length;
    const start = (page - 1) * safeLimit;
    const pageComments = comments.slice(start, start + safeLimit);
    const plainComments = await Promise.all(pageComments.map(async comment => ({
      id: comment.id,
      author: comment.author,
      url: comment.url || undefined,
      avatar: resolveAvatarUrl(avatarEnabled, avatarConfig, comment.email, comment.author),
      contentText: comment.content_text,
      contentHtml: comment.content_html,
      pubDate: comment.pub_date.toISOString(),
      parentId: comment.parent_id,
      isBlogger: isAdminEmail(comment.email, admins),
      urlDormant: isDormant(comment),
    })));

    return {
      code: 200,
      message: "Comments fetched successfully",
      data: {
        comments: plainComments,
        pagination: {
          page,
          limit,
          totalPage: Math.ceil(total / safeLimit) || 1,
        },
        ...meta,
      }
    };
  }
};

// 辅助函数：构建嵌套评论结构
const buildNestedComments = async (
  comments: Comment[],
  admins: string[],
  isDormant: (comment: Comment) => boolean,
  avatarConfig: AvatarConfig,
  avatarEnabled: boolean
): Promise<NestedComment[]> => {
  // 创建评论映射以便快速查找
  const commentMap = new Map<number, NestedComment>();
  const rootComments: NestedComment[] = [];

  // 初始化所有评论
  const initializedComments = await Promise.all(comments.map(async comment => {
    return {
      id: comment.id,
      author: comment.author,
      avatar: resolveAvatarUrl(avatarEnabled, avatarConfig, comment.email, comment.author),
      url: comment.url || undefined,
      contentText: comment.content_text,
      contentHtml: comment.content_html,
      pubDate: comment.pub_date.toISOString(),
      replies: [] as NestedComment[],
      isBlogger: isAdminEmail(comment.email, admins),
      urlDormant: isDormant(comment),
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
* 将数据库获取的评论数据，按照指定的格式处理后返回给管理员面板
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

  // 后台列表的头像**不受 avatar_enabled 影响**：开关只约束访客可见结果，管理面板用它识别评论者；
  // 关闭头像时也不该把同一段 340 字符的内联 SVG 塞进每一行。来源配置与公开列表同一套。
  const settings = await getAllSettings();
  const avatarConfig = resolveAvatarConfig(
    settings[AVATAR_SOURCE_KEY],
    settings[AVATAR_CUSTOM_URL_KEY]
  );
  
  // 构建管理员界面的评论数据
  const adminComments = await Promise.all(pageComments.map(async comment => ({
    id: comment.id,
    pubDate: comment.pub_date.toISOString(),
    postSlug: comment.post_slug,
    author: comment.author,
    email: comment.email,
    url: comment.url || undefined,
    avatar: buildAvatarUrl(avatarConfig, comment.email, comment.author),
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
