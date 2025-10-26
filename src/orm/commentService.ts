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
    async deleteComment(id: number) {
        return await CommentsModel.deleteMany({
            where: {
                OR: [
                    {id: id},
                    {parent_id: id}
                ]
            }
        })
    }
}

export default new CommentService();