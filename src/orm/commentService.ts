import { CommentsModel } from "./prisma"
import { Comment, CreateCommentInput } from "../type/prisma"


class CommentService {
    async createComment(data: CreateCommentInput): Promise<Comment> {
        return await CommentsModel.create({
            data
        });
    }
    async getComments(): Promise<Comment[]> {
        return await CommentsModel.findMany();
    }
    async getAllComments(): Promise<Comment[]> {
        return await CommentsModel.findMany({
            orderBy: {
                pub_date: 'desc'
            }
        });
    }
    async getCommentBySlug(postSlug: string): Promise<Comment[] | null> {
        return await CommentsModel.findMany({
            where: {
                post_slug: postSlug,
                status: "approved"
            }
        });
    }
    // 这里需要递归删除，将父级下的所有子级都删除
    async deleteComment(id: number) {
        // 先查询所有需要删除的评论ID（包括子孙节点）
        const deleteQueue: number[] = [];
        const queue: number[] = [id];
        
        while (queue.length > 0) {
            const currentId = queue.shift()!; // 使用非空断言，因为我们确保队列不为空
            deleteQueue.push(currentId);
            const children = await CommentsModel.findMany({
                where: {
                    parent_id: currentId
                }
            });
            // 将所有子评论加入队列
            children.forEach(child => {
                queue.push(child.id);
            });
        }
        // 执行批量删除
        return await CommentsModel.deleteMany({
            where: {
                id: {
                    in: deleteQueue
                }
            }
        });
    }
}

export default new CommentService();