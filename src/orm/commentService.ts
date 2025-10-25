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
    async getCommentBySlug(postSlug: string): Promise<Comment[] | null> {
        return await CommentsModel.findMany({
            where: {
                post_slug: postSlug,
                status: "approved"
            }
        });
    }
}

export default new CommentService();