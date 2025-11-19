import CommentService   from "../orm/commentService"

export async function canPostComment(ip: string): Promise<boolean> {
    const lastComment = await CommentService.getlastCommentByIP(ip);
    // 如果没有找到评论或返回为空，则允许发布
    if (!lastComment || lastComment.length === 0) return true;
    
    // 确保有评论后再检查时间
    const comment = lastComment[0];
    if (!comment.pub_date) return true; // 防止 pub_date 不存在的情况
    
    return Date.now() - comment.pub_date.getTime() > 60 * 1000;
}

// 检查内容，将<script>标签之间的内容删除
export function checkContent(content: string): string {
    return content.replace(/<script[\s\S]*?<\/script>/g, "");
}

export function checkKey(key: string): boolean {
    return key === process.env.ADMIN_KEY;
}

export function checkAdmin(name: string, password: string): boolean { 
    return name === process.env.ADMIN_NAME && password === process.env.ADMIN_PASSWORD;
}
