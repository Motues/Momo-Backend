# 一键更新脚本

`scripts/` 目录下的 `update.sh`（Linux / Git Bash）和 `update.ps1`（Windows PowerShell）用于在部署根目录自动识别部署方式并更新项目。

> 只支持更新到**已经发布的 Release 版本**，不支持更新到分支。默认更新到最新 Release，也可以用 `--version` / `-Version` 指定版本。

## 支持范围

| 部署方式 | 更新方式 | 说明 |
|---|---|---|
| Node.js | `git diff` 覆盖变化源码 + 从 Release 提取 `public` | 更新后执行 `pnpm install` / `pnpm run build`，不自动重启 |
| Cloudflare Worker | `git diff` 覆盖变化源码 + 从 Release 提取 `public` | 更新后执行 `pnpm install`，部署命令由你手动执行 |
| Go | 下载 Release 预编译二进制 | 替换二进制、`public/` 和 `momo.bash`，保留 `config/`、`data/` |
| Docker | 拉取 Release 镜像 tag | 保留数据卷；脚本只拉取并打 tag，不自动 `up -d` |

- 只有已发布的 tag（`vX.Y.Z`）会被当作更新目标；`--branch` / `-Branch` 不存在，传入会直接报错。
- 更新完成后不会自动重启服务，只打印对应部署方式的重启命令。
- 数据库迁移不会自动执行。Node.js 跨到含 schema 变更的版本时会打印 `pnpm db:push` 提示。

## 快速开始

脚本放在**部署根目录的 `scripts/` 子目录**（也可以直接放根目录；脚本会自动向上寻找项目根）。部署根目录是包含 `nodejs/`、`worker/` 或 Go 二进制、`docker-compose.yml` 的那一层。如果是 Release 解压部署，从仓库下载整个 `scripts/` 目录放到这一层即可：

```bash
mkdir -p scripts
curl -fsSL https://raw.githubusercontent.com/Motues/Momo-Backend/main/scripts/update.sh -o scripts/update.sh
curl -fsSL https://raw.githubusercontent.com/Motues/Momo-Backend/main/scripts/update.ps1 -o scripts/update.ps1
```

### Linux

```bash
cd /path/to/Momo-Backend
chmod +x scripts/update.sh
./scripts/update.sh
```

### Windows

在部署根目录打开 PowerShell：

```powershell
cd C:\path\to\Momo-Backend
powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1
```

首次运行建议先看计划：

```bash
./scripts/update.sh --dry-run
```

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1 -DryRun
```

## 自动识别部署方式

脚本会综合以下痕迹打分，只有一个候选或某个候选明显领先时自动选择；否则让你在终端里选：

- **Docker**：`momo-backend` 容器在运行，或 compose 项目有运行中的服务；容器已停止但存在 `docker-compose.yml` 与 `data/` 时也作为候选（分数较低）。
- **Go**：根目录存在 `momo-backend-*` 二进制、`momo.bash`、`go/config/config.yaml` 或 `go/data/*.db`。
- **Node.js**：`nodejs/package.json` 的 name 为 `momo-backend-nodejs`，并结合 `.env`、`data/`、`dist/`、`node_modules`、`public/` 判断。
- **Worker**：`worker/package.json` 的 name 为 `momo-backend-worker`，并结合 `wrangler.jsonc`、`.dev.vars`、`.wrangler/`、`node_modules`、`public/` 判断。

也可以显式指定：

```bash
./scripts/update.sh --type nodejs
./scripts/update.sh --type worker --version 1.8.4
./scripts/update.sh --type go --dry-run
./scripts/update.sh --type docker --yes
```

```powershell
.\scripts\update.ps1 -Type nodejs
.\scripts\update.ps1 -Type worker -Version 1.8.4
```

## 更新目标

```bash
./scripts/update.sh                      # 最新 Release
./scripts/update.sh --version 1.8.4      # 指定 Release
./scripts/update.sh --version v1.8.4     # 也接受 v 前缀
```

```powershell
.\scripts\update.ps1
.\scripts\update.ps1 -Version 1.8.4
```

`--version` 必须是已经存在的 tag。脚本不会抓取分支 HEAD。

## git diff 更新规则

对于 Node.js / Worker：

- 如果根目录本身是 git 仓库，脚本 `git fetch --tags` 后比较 `HEAD..目标 tag`，然后 `git checkout --detach <tag>`。git 只会写入版本之间真正变化的文件，未跟踪文件和 `.gitignore` 忽略的 `.env`、`data/`、`node_modules/` 等不会被删除。
- 如果根目录不是 git 仓库（Release 解压部署），脚本会在 `.momo-update/cache/repo.git` 建一个裸仓库缓存，用 `git diff --name-status` 找出变化文件，再按文件覆盖到部署目录。只覆盖差异文件，不整包替换。
- 无论哪种方式，管理面板 `public/` 都不在 git 跟踪范围内，脚本会从目标版本的 `nodejs.zip` / `worker.zip` 中提取 `public/` 并替换。
- Worker 的 `wrangler.jsonc`、`.dev.vars*`、`.wrangler/` 被视为本地配置：非 git 模式下跳过；git 模式下 checkout 后会恢复你原来的 `wrangler.jsonc`。
- Node.js 的 `.env`、`data/`、`node_modules/`、`dist/`、`logs/` 不会被 diff 覆盖。

如果 git 工作区有未提交的受跟踪文件修改，脚本默认中止。使用 `--force` / `-Force` 会先把修改保存成补丁并备份，再覆盖；回滚时会尝试恢复该补丁。

## 国内镜像

默认先检测 GitHub 直连是否可用：

- 直连可用：使用直连。
- 直连不可用或超时：自动切换 `https://ghfast.top/` 下载/仓库镜像，并给 pnpm/npm、Docker 使用国内镜像配置。
- `--china` / `-China`：强制优先使用国内镜像（即使直连可用）。
- `--no-mirror` / `-NoMirror`：完全禁用镜像，只允许直连。

可覆盖的环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `MOMO_DOWNLOAD_MIRROR` | `https://ghfast.top/` | Release 资产下载前缀 |
| `MOMO_RELEASE_BASE` | 空（使用 GitHub Release） | 覆盖 Release 下载根地址，适合自建镜像/制品库 |
| `MOMO_NPM_REGISTRY` | `https://registry.npmmirror.com` | pnpm / npm 镜像 |
| `MOMO_GHCR_MIRROR` | `ghcr.nju.edu.cn` | GHCR 镜像主机 |
| `MOMO_DOCKERHUB_MIRROR` | `docker.m.daocloud.io` | Docker Hub 镜像主机 |

镜像只影响本次脚本进程，不会修改你的全局 npm / git / Docker 配置。

## 备份与回滚

默认每次更新前都会创建备份：

```text
.momo-update/
├── backups/
│   └── 20261101-120000-nodejs-1.8.3-to-1.8.4/
│       ├── manifest.txt
│       ├── files/       # 被覆盖的源码 / 本地配置
│       ├── archives/    # public、dist 等目录归档
│       └── db/          # SQLite 数据库备份
├── cache/               # 非 git 部署使用的裸仓库缓存
├── logs/
└── state.txt
```

- 数据库优先使用 `sqlite3 .backup` 做一致性备份；没有 `sqlite3` 时退化为复制数据库和 `-wal` / `-shm`。
- `--keep N` / `-Keep N` 控制保留最近几次备份，默认 5 次。
- `--no-backup` / `-NoBackup` 可以关闭备份，但之后无法用脚本回滚。

回滚最近一次备份：

```bash
./scripts/update.sh --rollback
```

```powershell
.\scripts\update.ps1 -Rollback
```

回滚会：

- git 部署：`git checkout -f` 回旧 commit，再恢复备份中的本地修改/配置；
- 非 git 部署：按 manifest 恢复被修改/删除的文件，删除更新时新增的文件；
- 恢复 `public/`、Node 的 `dist/` 等目录归档；
- 恢复数据库（恢复前请先停止服务，脚本会提示）；
- Docker：把之前保存的 `rollback-<时间>` 镜像 tag 重新打回 compose 使用的 tag。

回滚不会自动重启服务，最后仍会打印重启命令。备份在回滚后保留，方便再次检查。

## 更新后要做什么

脚本只更新文件 / 构建，不替你重启或部署：

| 类型 | 脚本执行 | 你还需要执行 |
|---|---|---|
| Node.js | `pnpm install`、`pnpm run build` | `pm2 restart momo-backend` 或 `systemctl restart ...` / `pnpm start` |
| Worker | `pnpm install` | `pnpm run deploy`（会部署到 Cloudflare） |
| Go | 替换二进制和 `public/` | `./momo.bash` 选重启，或重启 systemd/Windows 服务 |
| Docker | 拉取镜像并打 tag | `docker compose up -d` |

Node.js 如果跨版本包含 `nodejs/src/orm/schema.ts` 变更，脚本会额外提示：

```bash
cd nodejs
pnpm db:push
```

Worker 的 D1 通常会在首次请求时自动迁移；如果报数据库错误，可在 D1 控制台执行 `worker/schemas/comment.sql`。

## 参数速查

### scripts/update.sh

```text
--type <nodejs|worker|go|docker>  强制部署方式
--version <版本>                   指定 Release
--from <版本>                      当前版本探测失败时手动指定
--repo <url>                       覆盖仓库地址
-y, --yes                          跳过确认
--dry-run                          只展示计划
--china                            强制国内镜像
--no-mirror                        禁用镜像
--no-backup                        不备份
--keep <n>                         保留备份数量
--force                            覆盖本地 git 修改 / 强制重装
--rollback                         回滚最近一次备份
-h, --help                         帮助
```

### scripts/update.ps1

```text
-Type <nodejs|worker|go|docker>
-Version <版本>
-From <版本>
-Repo <url>
-Yes
-DryRun
-China
-NoMirror
-NoBackup
-Keep <n>
-Force
-Rollback
-Help
```

## 注意事项与限制

- **只支持已发布版本**：脚本不会更新到分支，也不会用分支 HEAD 构建。
- **Go 只提供 amd64**：Release 的 Go 包只有 linux/windows amd64；ARM 服务器需要自行编译。
- **Docker 分支更新不支持**：只按 Release 镜像 tag 更新。
- **Docker 镜像 tag**：如果 compose 固定了具体 tag（不是 `latest`），脚本会把新镜像打到同一个 tag 上，建议改成 `latest` 或目标版本 tag，避免误解。
- **Docker 使用 digest**：`image: repo@sha256:...` 无法自动切换，脚本会直接报错，请改成 tag 形式。
- **非 git 部署首次更新**：需要克隆仓库缓存，第一次会慢一些；之后只 fetch tags。
- **dry-run 也会访问网络**：需要拉取 tag / 计算 diff，但不会下载 Release 资产、不会改部署文件、不会写项目缓存（缓存放在系统临时目录）。
- **Node 原生依赖**：pnpm 10 默认可能忽略 `better-sqlite3` 的 install 脚本。脚本安装后会检查 `nodejs/node_modules/better-sqlite3/build/Release/better_sqlite3.node`；如果缺失，会临时生成只包含 `onlyBuiltDependencies: better-sqlite3` 的 `nodejs/pnpm-workspace.yaml`，执行 `pnpm rebuild better-sqlite3` 后删除该临时文件。若你已有 `pnpm-workspace.yaml` 但没允许该依赖，脚本只提示，不会覆盖。
- **数据库回滚**：恢复 SQLite 前必须停止服务，否则可能损坏数据库；脚本会提示但不会自动停服。
- **Windows 正在运行的 Go 二进制**：Windows 不允许覆盖运行中的 exe。脚本会尝试停止替换并保留 `.new` 文件；请先停止服务再替换。
- **`.momo-update/` 不要提交到 git**：已在 `.gitignore` 中忽略。

## 常见问题

**Q：脚本说检测到多个部署方式怎么办？**

用 `--type` / `-Type` 明确指定，或删掉无关的旧目录/容器。脚本在分数接近时会让你交互选择；非交互场景请显式指定。

**Q：更新后服务还是旧版本？**

脚本不会重启。按提示执行 restart / deploy；Node.js 还需要确认构建成功。

**Q：`git checkout` 失败，提示未跟踪文件冲突？**

目标版本新增的文件与你的未跟踪文件同名。先备份/移动该文件，或使用 `--force`（会备份工作区修改，但仍建议先手动处理未跟踪冲突）。

**Q：国内镜像不可用？**

脚本会按 `MOMO_DOWNLOAD_MIRROR` → 默认 `ghfast.top` → `ghproxy.net` 的顺序回退；仍失败时可换 `MOMO_DOWNLOAD_MIRROR` 或使用 `--no-mirror`。

**Q：回滚后 `dist/` 还是新的？**

脚本会备份并恢复 `nodejs/dist`；如果你用 `--no-backup` 更新，或备份时 `dist/` 不存在，则无法恢复。重新执行 `pnpm install && pnpm run build` 即可。
