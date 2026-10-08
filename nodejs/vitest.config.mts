import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // SQLite 测试库是单个文件；串行执行测试文件，避免并发写同一文件互锁
    fileParallelism: false,
    env: {
      // 独立的测试库，绝不触碰本地开发库 data/dev.db（见 test/setup.ts 的保护）
      DATABASE_URL: "file:./data/.vitest/test.db",
    },
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/env.d.ts"],
    },
  },
});
