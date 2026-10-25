import fs from "fs";
import type { Context } from "hono";
import { sqlite } from "../orm/client";

/**
 * 容器判定：Docker / Podman 都会在根目录留下标记文件。
 * 管理面板据此判断该显示「替换文件」还是「docker compose pull」步骤。
 */
function detectContainer(): boolean {
  return ["/.dockerenv", "/run/.containerenv"].some((file) => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  });
}

/** 归一化平台名，与 Go 的 runtime.GOOS 保持同一套取值 */
function normalizePlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? "windows" : platform;
}

/** 归一化架构名，与 Go 的 runtime.GOARCH 保持同一套取值 */
function normalizeArch(arch: string): string {
  if (arch === "x64") return "amd64";
  if (arch === "ia32") return "386";
  return arch;
}

/**
 * 运行时信息（公开，不含敏感内容）：
 *   runtime   node | go | worker
 *   container 是否运行在容器中
 *   os/arch   服务端平台，Go 版本按它选择 Release 包
 *
 * 管理面板用 /health 的这几个字段自动识别部署方式，只展示对应的升级步骤。
 */
const RUNTIME_INFO = {
  runtime: "node" as const,
  container: detectContainer(),
  os: normalizePlatform(process.platform),
  arch: normalizeArch(process.arch),
};

/**
 * 健康检查（GET /health）
 *
 * 供容器 HEALTHCHECK / docker-compose / 反向代理探针使用，不需要认证：
 * 进程能响应且 SQLite 可用 → 200；数据库不可用 → 503。
 * 响应结构与 Go / Worker 完全一致：
 *
 *   200 {"code":200,"message":"ok","data":{"status":"ok","database":"ok",...}}
 *   503 {"code":503,"message":"database unavailable","data":{"status":"error","database":"error",...}}
 *
 * 数据库不可用时也会带上运行时字段，面板仍能识别部署方式。
 */
export default async (c: Context): Promise<Response> => {
  try {
    // 只做一次最小查询：不碰业务表，也不依赖 ORM/Drizzle 的初始化状态
    sqlite.prepare("SELECT 1").get();
  } catch {
    return c.json(
      {
        code: 503,
        message: "database unavailable",
        data: { status: "error", database: "error", ...RUNTIME_INFO },
      },
      503
    );
  }

  return c.json({
    code: 200,
    message: "ok",
    data: { status: "ok", database: "ok", ...RUNTIME_INFO },
  });
};
