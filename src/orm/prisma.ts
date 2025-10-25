import { PrismaClient } from "../generated/prisma/client";

const prisma = new PrismaClient();

const CommentsModel = prisma.comment;

export { CommentsModel };