import CommentService   from "../orm/commentService"

export async function canPostComment(ip: string): Promise<boolean> {
    const lastComment = await CommentService.getlastCommentByIP(ip);
    if(!lastComment) return true;
    return Date.now() - lastComment[0].pub_date.getTime() > 60 * 1000;
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
