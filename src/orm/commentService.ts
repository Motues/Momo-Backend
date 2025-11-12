import { CommentsModel } from "./prisma"
import { Comment, CreateCommentInput } from "../type/prisma"


class CommentService {
    /*
    * 创建评论
    */
    async createComment(data: CreateCommentInput): Promise<Comment> {
        return await CommentsModel.create({
            data
        });
    }
    /*
    * 获取所有评论，按照最新发布时间排序
    */
    async getAllComments(): Promise<Comment[]> {
        return await CommentsModel.findMany({
            orderBy: {
                pub_date: 'desc'
            }
        });
    }
    /*
    * 根据 id 获取评论
    */
    async getCommentById(id: number): Promise<Comment | null> {
        return await CommentsModel.findUnique({
            where: {
                id
            }
        });
    }
    /*
    * 根据文章 slug 获取所有评论
    */
    async getCommentBySlug(postSlug: string): Promise<Comment[] | null> {
        return await CommentsModel.findMany({
            where: {
                post_slug: postSlug,
                status: "approved"
            }
        });
    }
    /*
    * 删除评论
    * 这里需要递归删除，将父级下的所有子级都删除
    */
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
        // return await CommentsModel.deleteMany({
        //     where: {
        //         id: {
        //             in: deleteQueue
        //         }
        //     }
        // });
        /* 并不真实删除，而是改变状态 */
        return await CommentsModel.updateMany({
            where: {
                id: {
                    in: deleteQueue
                }
            },
            data: {
                status: "deleted"
            }
        });
    }
    /*
    * 修改评论状态
    */
    async updateCommentStatus(id: number, status: string): Promise<Comment> {
        return await CommentsModel.update({
            where: {
                id
            },
            data: {
                status
            }
        });
    }
}

export default new CommentService();