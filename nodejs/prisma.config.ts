import "dotenv/config";
import { env, PrismaConfig } from "prisma/config";

export default({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  engine: "classic",
  datasource: {
    url: env("DATABASE_URL"),
  },
}) satisfies PrismaConfig;
