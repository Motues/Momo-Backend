#!/usr/bin/env bash
# ==========================================================
# Momo Backend 一键更新脚本（Linux / Git Bash）
#
# 只更新到已经发布的 Release 版本，不支持分支。
# 支持自动识别 nodejs / worker / go / docker 部署方式。
#
# 用法：在部署根目录执行
#   ./scripts/update.sh                 # 更新到最新 Release
#   ./scripts/update.sh --version 1.8.4 # 更新到指定 Release
#   ./scripts/update.sh --dry-run       # 只展示计划
#   ./scripts/update.sh --rollback      # 回滚到最近一次备份
# ==========================================================

set -uo pipefail

SCRIPT_VERSION="1.0.0"
DEFAULT_REPO="https://github.com/Motues/Momo-Backend.git"
DEFAULT_MIRROR_PREFIX="https://ghfast.top/"
DEFAULT_NPM_REGISTRY="https://registry.npmmirror.com"
DEFAULT_GHCR_MIRROR="ghcr.nju.edu.cn"
DEFAULT_DOCKERHUB_MIRROR="docker.m.daocloud.io"

# 脚本可以放在项目根的 scripts/ 目录，也可以直接放在项目根。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  ROOT="$SCRIPT_DIR"
fi
STATE_DIR="$ROOT/.momo-update"
BACKUP_ROOT="$STATE_DIR/backups"
LOG_DIR="$STATE_DIR/logs"
STATE_FILE="$STATE_DIR/state.txt"
CACHE_DIR="$STATE_DIR/cache"
CACHE_REPO="$CACHE_DIR/repo.git"

TYPE=""
TARGET_ARG=""
FROM_ARG=""
REPO_ARG=""
YES=0
DRY_RUN=0
FORCE=0
ROLLBACK=0
FORCE_CHINA=0
NO_MIRROR=0
NO_BACKUP=0
KEEP=5

CURRENT_VERSION=""
CURRENT_REF=""
CURRENT_REF_FULL=""
TARGET_VERSION=""
TARGET_TAG=""
TARGET_REF=""
GIT_ROOT=0
GIT_URL=""
REPO_CANONICAL=""
REPO_IS_GITHUB=0
OWNER=""
NAME=""
GITHUB_WEB=""
RELEASE_BASE=""
USE_MIRROR=0
MIRROR_PREFIX="$DEFAULT_MIRROR_PREFIX"
NPM_REGISTRY=""
GHCR_MIRROR="$DEFAULT_GHCR_MIRROR"
DOCKERHUB_MIRROR="$DEFAULT_DOCKERHUB_MIRROR"

TMP_DIR=""
BACKUP_DIR=""
MANIFEST=""
LOG_FILE=""
TS="$(date +%Y%m%d-%H%M%S)"

PUBLIC_SRC=""
GO_NEW_BIN=""
GO_NEW_PUBLIC=""
GO_NEW_MOMO_BASH=""
CHG_STATUS=()
CHG_OLD=()
CHG_NEW=()
COMPOSE_CMD=()
SCHEMA_CHANGED=0

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BLUE=$'\033[36m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""
fi

# ---------- 输出 ----------

log_line() { [ -n "${LOG_FILE:-}" ] && printf '%s\n' "$*" >> "$LOG_FILE"; }
say() { printf '%s\n' "$*"; log_line "$*"; }
info() { printf '%s[信息]%s %s\n' "$C_BLUE" "$C_RESET" "$*"; log_line "[信息] $*"; }
ok() { printf '%s[完成]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; log_line "[完成] $*"; }
warn() { printf '%s[警告]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; log_line "[警告] $*"; }
die() { printf '%s[错误]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; log_line "[错误] $*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 参数 ----------

usage() {
  cat <<'EOF'
Momo Backend 一键更新脚本（只更新已发布的 Release 版本）

用法:
  ./scripts/update.sh [选项]

选项:
  --type <nodejs|worker|go|docker>  强制指定部署方式（默认自动探测）
  --version <版本>                   更新到指定 Release，例如 1.8.4 / v1.8.4
  --from <版本>                      当前版本探测失败时手动指定
  --repo <url>                       覆盖仓库地址（默认读取 git origin）
  -y, --yes                          跳过确认
  --dry-run                          只展示计划，不改文件、不下载、不构建
  --china                            强制优先使用国内镜像
  --no-mirror                        禁用镜像，全部直连 GitHub
  --no-backup                        不创建备份（不推荐，--rollback 将不可用）
  --keep <数量>                      保留最近几次备份，默认 5
  --force                            允许覆盖本地 git 修改 / 强制重装当前版本
  --rollback                         回滚到最近一次备份
  -h, --help                         显示本帮助

说明:
  * 只支持已发布版本；--branch 不再支持。
  * Node.js / Worker 使用 git diff 只覆盖版本之间变化的源码文件；
    管理面板 public 始终从对应 Release 包中提取。
  * Go 使用 Release 预编译二进制；Docker 拉取 Release 镜像。
  * 更新完成后不会自动重启服务，只打印重启命令。
  * 数据库迁移不会自动执行；Node.js 跨版本时会打印 pnpm db:push 提示。

示例:
  ./scripts/update.sh
  ./scripts/update.sh --version 1.8.4 --yes
  ./scripts/update.sh --type worker --dry-run
  ./scripts/update.sh --rollback

环境变量:
  MOMO_DOWNLOAD_MIRROR   下载镜像前缀，默认 https://ghfast.top/
  MOMO_RELEASE_BASE      覆盖 Release 下载根地址（自建镜像/制品库）
  MOMO_NPM_REGISTRY      npm/pnpm 镜像，默认 https://registry.npmmirror.com
  MOMO_GHCR_MIRROR       GHCR 镜像主机，默认 ghcr.nju.edu.cn
  MOMO_DOCKERHUB_MIRROR  Docker Hub 镜像主机，默认 docker.m.daocloud.io
EOF
}

need_arg() { [ $# -ge 2 ] && [ -n "$2" ] || die "参数 $1 缺少值"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --type) need_arg "$@"; TYPE="$2"; shift 2 ;;
    --version) need_arg "$@"; TARGET_ARG="$2"; shift 2 ;;
    --from) need_arg "$@"; FROM_ARG="$2"; shift 2 ;;
    --repo) need_arg "$@"; REPO_ARG="$2"; shift 2 ;;
    -y|--yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --china) FORCE_CHINA=1; shift ;;
    --no-mirror) NO_MIRROR=1; shift ;;
    --no-backup) NO_BACKUP=1; shift ;;
    --keep) need_arg "$@"; KEEP="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --branch) die "只允许更新到已经发布的 Release 版本，不支持分支更新" ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（使用 --help 查看帮助）" ;;
  esac
done

case "$KEEP" in ''|*[!0-9]*) die "--keep 必须是正整数" ;; esac
[ "$KEEP" -ge 1 ] || die "--keep 必须大于 0"

case "$TYPE" in
  ''|nodejs|worker|go|docker) ;;
  *) die "--type 只能是 nodejs / worker / go / docker" ;;
esac

# ---------- 基础工具 ----------

setup_dirs() {
  if [ "$DRY_RUN" -eq 1 ]; then
    LOG_FILE=""
    return 0
  fi
  mkdir -p "$STATE_DIR" "$BACKUP_ROOT" "$LOG_DIR"
  LOG_FILE="$LOG_DIR/update-$TS.log"
  : > "$LOG_FILE"
}

make_temp() {
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/momo-update.XXXXXX")" || die "无法创建临时目录"
}

cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

ensure_basic_tools() {
  have git || die "缺少 git，请先安装"
  if ! have curl && ! have wget; then
    die "缺少 curl 或 wget，无法下载 Release 资产"
  fi
  have tar || die "缺少 tar，无法解压/备份"
  if ! sort -V </dev/null >/dev/null 2>&1; then
    die "当前 sort 不支持 -V，请安装 GNU coreutils"
  fi
}

ensure_zip_tool() {
  if have unzip || have python3 || (tar --version 2>/dev/null | grep -qi 'bsdtar'); then
    return 0
  fi
  die "缺少 unzip / python3 / bsdtar，无法解压 zip"
}

# ---------- 仓库地址 ----------

to_https_repo() {
  local url="$1"
  url="${url%/}"
  case "$url" in
    git@github.com:*) url="https://github.com/${url#git@github.com:}" ;;
    ssh://git@github.com/*) url="https://github.com/${url#ssh://git@github.com/}" ;;
    https://ghfast.top/https://github.com/*) url="${url#https://ghfast.top/}" ;;
    https://ghproxy.net/https://github.com/*) url="${url#https://ghproxy.net/}" ;;
    https://github.moeyy.xyz/https://github.com/*) url="${url#https://github.moeyy.xyz/}" ;;
  esac
  url="${url%/}"
  case "$url" in
    https://github.com/*)
      case "$url" in *.git) ;; *) url="$url.git" ;; esac
      ;;
  esac
  printf '%s' "$url"
}

resolve_repo() {
  local input=""
  if [ -n "$REPO_ARG" ]; then
    input="$REPO_ARG"
  elif [ -d "$ROOT/.git" ] || [ -f "$ROOT/.git" ]; then
    input="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"
  else
    input="$(state_get repo)"
  fi
  [ -n "$input" ] || input="$DEFAULT_REPO"

  REPO_CANONICAL="$(to_https_repo "$input")"
  case "$REPO_CANONICAL" in
    https://github.com/*)
      REPO_IS_GITHUB=1
      local path="${REPO_CANONICAL#https://github.com/}"
      path="${path%.git}"
      OWNER="${path%%/*}"
      NAME="${path#*/}"
      NAME="${NAME%%/*}"
      [ -n "$OWNER" ] && [ -n "$NAME" ] || die "无法解析仓库地址: $REPO_CANONICAL"
      GITHUB_WEB="https://github.com/$OWNER/$NAME"
      RELEASE_BASE="$GITHUB_WEB/releases/download"
      ;;
    *)
      REPO_IS_GITHUB=0
      GITHUB_WEB=""
      RELEASE_BASE=""
      ;;
  esac

  # 允许自定义 Release 下载地址（镜像站 / 内网制品库 / 自测）
  if [ -n "${MOMO_RELEASE_BASE:-}" ]; then
    RELEASE_BASE="${MOMO_RELEASE_BASE%/}"
  fi

  if [ -d "$ROOT/.git" ] || [ -f "$ROOT/.git" ]; then
    local top=""
    top="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "$top" ] && top="$(cd "$top" 2>/dev/null && pwd)" || top=""
    if [ -n "$top" ] && [ "$top" = "$ROOT" ]; then
      GIT_ROOT=1
    fi
  fi
}

# ---------- 网络与镜像 ----------

git_remote_ok() {
  local url="$1"
  local cmd=(git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 ls-remote --heads "$url" main)
  if have timeout; then
    GIT_TERMINAL_PROMPT=0 timeout 25 "${cmd[@]}" >/dev/null 2>&1
  else
    GIT_TERMINAL_PROMPT=0 "${cmd[@]}" >/dev/null 2>&1
  fi
}

detect_mirror() {
  MIRROR_PREFIX="${MOMO_DOWNLOAD_MIRROR:-$DEFAULT_MIRROR_PREFIX}"
  case "$MIRROR_PREFIX" in */) ;; *) MIRROR_PREFIX="$MIRROR_PREFIX/" ;; esac

  local direct="$REPO_CANONICAL"
  local mirror="${MIRROR_PREFIX}${direct}"
  local gitclone=""
  if [ "$REPO_IS_GITHUB" -eq 1 ]; then
    gitclone="https://gitclone.com/github.com/${OWNER}/${NAME}.git"
  fi

  if [ "$NO_MIRROR" -eq 1 ]; then
    info "已禁用镜像，使用直连: $direct"
    git_remote_ok "$direct" || die "无法连接 GitHub（已指定 --no-mirror）: $direct"
    GIT_URL="$direct"
    USE_MIRROR=0
    [ -n "${MOMO_NPM_REGISTRY:-}" ] && NPM_REGISTRY="$MOMO_NPM_REGISTRY"
    return 0
  fi

  local candidates=()
  if [ "$FORCE_CHINA" -eq 1 ]; then
    candidates+=("$mirror")
    [ -n "$gitclone" ] && candidates+=("$gitclone")
    candidates+=("$direct")
  else
    candidates+=("$direct")
    candidates+=("$mirror")
    [ -n "$gitclone" ] && candidates+=("$gitclone")
  fi

  local url=""
  for url in "${candidates[@]}"; do
    if [ -z "$url" ]; then continue; fi
    info "检测连接: $url"
    if git_remote_ok "$url"; then
      GIT_URL="$url"
      if [ "$url" != "$direct" ]; then
        USE_MIRROR=1
        if [ "$FORCE_CHINA" -eq 1 ]; then
          info "已按 --china 使用国内镜像: $MIRROR_PREFIX"
        else
          info "GitHub 直连不可用，已启用国内镜像: $MIRROR_PREFIX"
        fi
      elif [ "$FORCE_CHINA" -eq 1 ]; then
        USE_MIRROR=1
        info "已按 --china 启用国内依赖镜像"
      else
        USE_MIRROR=0
        info "GitHub 直连正常，使用直连"
      fi
      break
    fi
  done

  if [ -z "$GIT_URL" ]; then
    die "无法连接 GitHub 或国内镜像，请检查网络；可尝试 --china 或 MOMO_DOWNLOAD_MIRROR"
  fi

  if [ "$USE_MIRROR" -eq 1 ]; then
    NPM_REGISTRY="${MOMO_NPM_REGISTRY:-$DEFAULT_NPM_REGISTRY}"
    GHCR_MIRROR="${MOMO_GHCR_MIRROR:-$DEFAULT_GHCR_MIRROR}"
    DOCKERHUB_MIRROR="${MOMO_DOCKERHUB_MIRROR:-$DEFAULT_DOCKERHUB_MIRROR}"
  elif [ -n "${MOMO_NPM_REGISTRY:-}" ]; then
    NPM_REGISTRY="$MOMO_NPM_REGISTRY"
  fi
}

# ---------- 版本与标签 ----------

normalize_version() {
  local v="$1"
  v="${v#v}"
  printf '%s' "$v"
}

version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
}

version_lt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

enable_mirror_env() {
  [ "$USE_MIRROR" -eq 1 ] && return 0
  USE_MIRROR=1
  [ -n "$NPM_REGISTRY" ] || NPM_REGISTRY="${MOMO_NPM_REGISTRY:-$DEFAULT_NPM_REGISTRY}"
  [ -n "$GHCR_MIRROR" ] || GHCR_MIRROR="${MOMO_GHCR_MIRROR:-$DEFAULT_GHCR_MIRROR}"
  [ -n "$DOCKERHUB_MIRROR" ] || DOCKERHUB_MIRROR="${MOMO_DOCKERHUB_MIRROR:-$DEFAULT_DOCKERHUB_MIRROR}"
}

mirror_git_url() {
  [ "$REPO_IS_GITHUB" -eq 1 ] || return 0
  [ "$NO_MIRROR" -eq 0 ] || return 0
  printf '%s%s' "$MIRROR_PREFIX" "$REPO_CANONICAL"
}

ensure_cache() {
  mkdir -p "$CACHE_DIR"
  if [ -d "$CACHE_REPO" ] && ! git --git-dir="$CACHE_REPO" rev-parse --git-dir >/dev/null 2>&1; then
    warn "更新缓存已损坏，正在重建: $CACHE_REPO"
    rm -rf "$CACHE_REPO"
  fi
  if [ -d "$CACHE_REPO" ] && git --git-dir="$CACHE_REPO" config --get extensions.partialClone >/dev/null 2>&1; then
    warn "旧缓存是部分克隆，可能导致 git archive 失败；正在重建为完整缓存"
    rm -rf "$CACHE_REPO"
  fi
  if [ ! -d "$CACHE_REPO" ]; then
    info "首次使用，正在建立仓库缓存（完整裸仓库）..."
    local mirror_url=""
    mirror_url="$(mirror_git_url)"
    local candidates=("$GIT_URL")
    if [ -n "$mirror_url" ] && [ "$mirror_url" != "$GIT_URL" ]; then
      candidates+=("$mirror_url")
    fi
    if [ -n "$REPO_CANONICAL" ] && [ "$REPO_CANONICAL" != "$GIT_URL" ] && [ "$REPO_CANONICAL" != "$mirror_url" ]; then
      candidates+=("$REPO_CANONICAL")
    fi
    local cloned=0 u=""
    for u in "${candidates[@]}"; do
      [ -n "$u" ] || continue
      rm -rf "$CACHE_REPO"
      if git clone --bare "$u" "$CACHE_REPO" >/dev/null 2>&1; then
        GIT_URL="$u"
        [ "$u" = "$mirror_url" ] && enable_mirror_env
        cloned=1
        break
      fi
      warn "克隆失败，尝试下一个地址: $u"
    done
    [ "$cloned" -eq 1 ] || die "无法克隆仓库: $REPO_CANONICAL"
  fi
  if git --git-dir="$CACHE_REPO" remote get-url origin >/dev/null 2>&1; then
    git --git-dir="$CACHE_REPO" remote set-url origin "$GIT_URL"
  else
    git --git-dir="$CACHE_REPO" remote add origin "$GIT_URL"
  fi
  if ! git --git-dir="$CACHE_REPO" fetch --tags --force origin '+refs/tags/v*:refs/tags/v*' >/dev/null 2>&1; then
    local mirror_url=""
    mirror_url="$(mirror_git_url)"
    if [ -n "$mirror_url" ] && [ "$mirror_url" != "$GIT_URL" ]; then
      warn "缓存拉取失败，切换镜像重试: $mirror_url"
      git --git-dir="$CACHE_REPO" remote set-url origin "$mirror_url"
      GIT_URL="$mirror_url"
      enable_mirror_env
      git --git-dir="$CACHE_REPO" fetch --tags --force origin '+refs/tags/v*:refs/tags/v*' >/dev/null 2>&1 \
        || die "无法从 $GIT_URL 拉取 Release 标签"
    else
      die "无法从 $GIT_URL 拉取 Release 标签"
    fi
  fi
}

ensure_tags() {
  if [ "$GIT_ROOT" -eq 1 ]; then
    info "拉取 Release 标签..."
    if ! git -C "$ROOT" fetch --tags --force "$GIT_URL" '+refs/tags/v*:refs/tags/v*' >/dev/null 2>&1; then
      local mirror_url=""
      mirror_url="$(mirror_git_url)"
      if [ -n "$mirror_url" ] && [ "$mirror_url" != "$GIT_URL" ]; then
        warn "标签拉取失败，切换镜像重试: $mirror_url"
        git -C "$ROOT" fetch --tags --force "$mirror_url" '+refs/tags/v*:refs/tags/v*' >/dev/null 2>&1 || die "无法拉取 Release 标签"
        GIT_URL="$mirror_url"
        enable_mirror_env
      else
        die "无法从 $GIT_URL 拉取 Release 标签"
      fi
    fi
  else
    ensure_cache
  fi
}

list_tags() {
  if [ "$GIT_ROOT" -eq 1 ]; then
    git -C "$ROOT" tag --list 'v*'
  else
    git --git-dir="$CACHE_REPO" tag --list 'v*'
  fi
}

tag_exists() {
  local tag="$1"
  if [ "$GIT_ROOT" -eq 1 ]; then
    git -C "$ROOT" rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1
  else
    git --git-dir="$CACHE_REPO" rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1
  fi
}

resolve_target() {
  if [ -n "$TARGET_ARG" ]; then
    TARGET_VERSION="$(normalize_version "$TARGET_ARG")"
    TARGET_TAG="v$TARGET_VERSION"
    tag_exists "$TARGET_TAG" || die "Release $TARGET_TAG 不存在（只支持已发布版本）"
  else
    local latest=""
    latest="$(list_tags | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -Vr | head -n 1 || true)"
    [ -n "$latest" ] || die "没有找到已发布的 Release 标签"
    TARGET_TAG="$latest"
    TARGET_VERSION="${latest#v}"
  fi
  TARGET_REF="$TARGET_TAG"
}

package_version() {
  local file="$1"
  [ -f "$file" ] || return 0
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1
}

state_get() {
  [ -f "$STATE_FILE" ] || return 0
  awk -F '\t' -v key="$1" '$1 == key { v=$2; sub(/\r$/, "", v); print v; exit }' "$STATE_FILE"
}

write_state() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  mkdir -p "$STATE_DIR"
  {
    printf 'type\t%s\n' "$TYPE"
    printf 'version\t%s\n' "$TARGET_VERSION"
    printf 'ref\t%s\n' "$TARGET_REF"
    printf 'repo\t%s\n' "$REPO_CANONICAL"
    printf 'updated\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

binary_version() {
  local bin="$1"
  [ -f "$bin" ] || return 0
  local out=""
  out="$("$bin" --version 2>&1 || true)"
  printf '%s\n' "$out" | sed -n 's/.*version[[:space:]]\+\([0-9][0-9A-Za-z._-]*\).*/\1/p' | head -n 1
}

find_go_binary() {
  local f=""
  for f in "$ROOT"/momo-backend-* "$ROOT"/momo-backend "$ROOT"/*.exe; do
    [ -f "$f" ] || continue
    case "$f" in
      *.new|*.old|*.old-*) continue ;;
    esac
    if [ -n "$(binary_version "$f")" ]; then
      printf '%s' "$f"
      return 0
    fi
  done
  return 0
}

current_version_git() {
  local exact=""
  exact="$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null || true)"
  if [ -n "$exact" ]; then
    normalize_version "$exact"
    return 0
  fi
  local pkg=""
  case "$TYPE" in
    nodejs) pkg="$(package_version "$ROOT/nodejs/package.json")" ;;
    worker) pkg="$(package_version "$ROOT/worker/package.json")" ;;
  esac
  if [ -n "$pkg" ]; then
    printf '%s' "$pkg"
    return 0
  fi
  state_get version
}

current_version_nongit() {
  case "$TYPE" in
    nodejs)
      local pkg=""
      pkg="$(package_version "$ROOT/nodejs/package.json")"
      [ -n "$pkg" ] && { printf '%s' "$pkg"; return 0; }
      ;;
    worker)
      local pkg=""
      pkg="$(package_version "$ROOT/worker/package.json")"
      [ -n "$pkg" ] && { printf '%s' "$pkg"; return 0; }
      ;;
    go)
      local bin=""
      bin="$(find_go_binary)"
      if [ -n "$bin" ]; then
        local v=""
        v="$(binary_version "$bin")"
        [ -n "$v" ] && { printf '%s' "$v"; return 0; }
      fi
      ;;
    docker)
      local v=""
      v="$(docker_current_version)"
      [ -n "$v" ] && { printf '%s' "$v"; return 0; }
      ;;
  esac
  state_get version
}

resolve_current() {
  if [ -n "$FROM_ARG" ]; then
    CURRENT_VERSION="$(normalize_version "$FROM_ARG")"
    if [ "$GIT_ROOT" -eq 1 ] && { [ "$TYPE" = "nodejs" ] || [ "$TYPE" = "worker" ]; }; then
      CURRENT_REF_FULL="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
      CURRENT_REF="$CURRENT_REF_FULL"
    else
      CURRENT_REF="v$CURRENT_VERSION"
      tag_exists "$CURRENT_REF" || die "标签 $CURRENT_REF 不存在"
    fi
    return 0
  fi

  if [ "$TYPE" = "docker" ]; then
    CURRENT_VERSION="$(docker_current_version)"
    [ -n "$CURRENT_VERSION" ] || die "无法识别当前 Docker 版本，请用 --from <版本> 指定"
  elif [ "$TYPE" = "go" ]; then
    local bin=""
    bin="$(find_go_binary)"
    [ -n "$bin" ] || die "未找到 Go 二进制（momo-backend-*）"
    CURRENT_VERSION="$(binary_version "$bin")"
    [ -n "$CURRENT_VERSION" ] || die "无法识别当前 Go 版本，请用 --from <版本> 指定"
  elif [ "$GIT_ROOT" -eq 1 ]; then
    CURRENT_VERSION="$(current_version_git)"
    [ -n "$CURRENT_VERSION" ] || CURRENT_VERSION="unknown"
  else
    CURRENT_VERSION="$(current_version_nongit)"
    if [ -z "$CURRENT_VERSION" ]; then
      die "无法识别当前版本，请用 --from <版本> 指定（例如 --from 1.8.3）"
    fi
  fi

  if [ "$GIT_ROOT" -eq 1 ] && { [ "$TYPE" = "nodejs" ] || [ "$TYPE" = "worker" ]; }; then
    CURRENT_REF_FULL="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
    CURRENT_REF="$CURRENT_REF_FULL"
    return 0
  fi

  local state_ref="" state_ver=""
  state_ref="$(state_get ref)"
  state_ver="$(state_get version)"
  if [ -n "$state_ref" ] && [ "$state_ver" = "$CURRENT_VERSION" ]; then
    CURRENT_REF="$state_ref"
  else
    CURRENT_REF="v$CURRENT_VERSION"
  fi
  tag_exists "$CURRENT_REF" || die "当前版本 $CURRENT_VERSION 对应的标签 $CURRENT_REF 不存在，请用 --from 指定已发布版本"
}

# ---------- 部署方式探测 ----------

DOCKER_OK_CACHE=""
docker_available() {
  if [ -z "$DOCKER_OK_CACHE" ]; then
    if have docker && docker info >/dev/null 2>&1; then
      DOCKER_OK_CACHE=1
    else
      DOCKER_OK_CACHE=0
    fi
  fi
  [ "$DOCKER_OK_CACHE" = "1" ]
}

compose_file() {
  local f=""
  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    if [ -f "$ROOT/$f" ]; then
      printf '%s' "$ROOT/$f"
      return 0
    fi
  done
  return 1
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif have docker-compose && docker-compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker-compose)
  else
    return 1
  fi
}

find_pkg_name() {
  local file="$1"
  [ -f "$file" ] || return 0
  sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1
}

DETECT_TYPES=()
DETECT_SCORES=()
DETECT_REASONS=()

add_candidate() {
  DETECT_TYPES+=("$1")
  DETECT_SCORES+=("$2")
  DETECT_REASONS+=("$3")
}

detect_type() {
  if [ -n "$TYPE" ]; then
    info "使用指定部署方式: $TYPE"
    return 0
  fi

  local state_type=""
  state_type="$(state_get type)"

  # Docker：优先看真正在运行的容器 / compose 项目
  if docker_available; then
    local docker_added=0
    local container=""
    container="$(docker ps -a --filter 'name=^/momo-backend$' --format '{{.Names}}' 2>/dev/null | head -n 1)"
    local compose_running=0
    if compose_file >/dev/null 2>&1 && compose_cmd 2>/dev/null; then
      if [ -n "$(${COMPOSE_CMD[@]} -f "$(compose_file)" ps -q 2>/dev/null | head -n 1)" ]; then
        compose_running=1
      fi
    fi
    if [ -n "$container" ] || [ "$compose_running" -eq 1 ]; then
      add_candidate docker 100 "检测到运行中的 Docker 容器 / compose 项目"
      docker_added=1
    fi
    if [ "$docker_added" -eq 0 ] && compose_file >/dev/null 2>&1 && [ -d "$ROOT/data" ]; then
      add_candidate docker 60 "发现 docker-compose.yml 与 data/（容器可能已停止）"
      docker_added=1
    fi
  fi
  [ "$state_type" = "docker" ] && add_candidate docker 20 "上次更新记录为 docker"

  # Go：根目录二进制 / momo.bash / go 数据目录
  local go_score=0 go_reason=""
  local gobin=""
  gobin="$(find_go_binary)"
  if [ -n "$gobin" ]; then
    go_score=$((go_score + 60)); go_reason="发现 Go 二进制 $(basename "$gobin")"
  fi
  [ -f "$ROOT/momo.bash" ] && { go_score=$((go_score + 20)); go_reason="${go_reason:+$go_reason; }发现 momo.bash"; }
  [ -f "$ROOT/go/config/config.yaml" ] && { go_score=$((go_score + 10)); go_reason="${go_reason:+$go_reason; }发现 go/config"; }
  if compgen -G "$ROOT/go/data/*.db" >/dev/null 2>&1 || compgen -G "$ROOT/go/data/*.sqlite" >/dev/null 2>&1; then
    go_score=$((go_score + 30)); go_reason="${go_reason:+$go_reason; }发现 go/data 数据库"
  fi
  [ "$state_type" = "go" ] && { go_score=$((go_score + 80)); go_reason="${go_reason:+$go_reason; }上次更新记录为 go"; }
  [ "$go_score" -gt 0 ] && add_candidate go "$go_score" "$go_reason"

  # Node.js
  local node_pkg="$ROOT/nodejs/package.json"
  local node_score=0 node_reason=""
  if [ "$(find_pkg_name "$node_pkg")" = "momo-backend-nodejs" ]; then
    node_score=$((node_score + 20)); node_reason="发现 nodejs/package.json"
    [ -f "$ROOT/nodejs/.env" ] && { node_score=$((node_score + 20)); node_reason="$node_reason; .env"; }
    if compgen -G "$ROOT/nodejs/data/*.db" >/dev/null 2>&1 || compgen -G "$ROOT/nodejs/data/*.sqlite" >/dev/null 2>&1; then
      node_score=$((node_score + 40)); node_reason="$node_reason; data 数据库"
    fi
    [ -d "$ROOT/nodejs/dist" ] && { node_score=$((node_score + 15)); node_reason="$node_reason; dist"; }
    [ -d "$ROOT/nodejs/node_modules" ] && { node_score=$((node_score + 10)); node_reason="$node_reason; node_modules"; }
    [ -d "$ROOT/nodejs/public" ] && { node_score=$((node_score + 5)); node_reason="$node_reason; public"; }
  fi
  [ "$state_type" = "nodejs" ] && { node_score=$((node_score + 80)); node_reason="${node_reason:+$node_reason; }上次更新记录为 nodejs"; }
  [ "$node_score" -gt 0 ] && add_candidate nodejs "$node_score" "$node_reason"

  # Worker
  local worker_pkg="$ROOT/worker/package.json"
  local worker_score=0 worker_reason=""
  if [ "$(find_pkg_name "$worker_pkg")" = "momo-backend-worker" ]; then
    worker_score=$((worker_score + 15)); worker_reason="发现 worker/package.json"
    [ -f "$ROOT/worker/wrangler.jsonc" ] && { worker_score=$((worker_score + 25)); worker_reason="$worker_reason; wrangler.jsonc"; }
    [ -f "$ROOT/worker/wrangler.example.jsonc" ] && { worker_score=$((worker_score + 5)); worker_reason="$worker_reason; wrangler.example.jsonc"; }
    [ -f "$ROOT/worker/.dev.vars" ] && { worker_score=$((worker_score + 40)); worker_reason="$worker_reason; .dev.vars"; }
    [ -d "$ROOT/worker/.wrangler" ] && { worker_score=$((worker_score + 15)); worker_reason="$worker_reason; .wrangler"; }
    [ -d "$ROOT/worker/node_modules" ] && { worker_score=$((worker_score + 10)); worker_reason="$worker_reason; node_modules"; }
    [ -d "$ROOT/worker/public" ] && { worker_score=$((worker_score + 5)); worker_reason="$worker_reason; public"; }
  fi
  [ "$state_type" = "worker" ] && { worker_score=$((worker_score + 80)); worker_reason="${worker_reason:+$worker_reason; }上次更新记录为 worker"; }
  [ "$worker_score" -gt 0 ] && add_candidate worker "$worker_score" "$worker_reason"

  local n=${#DETECT_TYPES[@]}
  if [ "$n" -eq 0 ]; then
    die "没有识别到部署方式；请用 --type nodejs|worker|go|docker 指定"
  fi
  if [ "$n" -eq 1 ]; then
    TYPE="${DETECT_TYPES[0]}"
    info "自动识别部署方式: $TYPE（${DETECT_REASONS[0]}）"
    return 0
  fi

  # 多个候选：分数明显领先就自动选，否则让用户选
  local best=0 best_i=0 second=0 i=0
  for i in "${!DETECT_SCORES[@]}"; do
    if [ "${DETECT_SCORES[$i]}" -gt "$best" ]; then
      second="$best"; best="${DETECT_SCORES[$i]}"; best_i="$i"
    elif [ "${DETECT_SCORES[$i]}" -gt "$second" ]; then
      second="${DETECT_SCORES[$i]}"
    fi
  done

  if [ $((best - second)) -ge 40 ]; then
    TYPE="${DETECT_TYPES[$best_i]}"
    info "自动识别部署方式: $TYPE（${DETECT_REASONS[$best_i]}）"
    return 0
  fi

  if [ "$YES" -eq 1 ] || [ ! -t 0 ]; then
    local list=""
    for i in "${!DETECT_TYPES[@]}"; do list="$list ${DETECT_TYPES[$i]}(${DETECT_SCORES[$i]})"; done
    die "检测到多个可能的部署方式:$list；请用 --type 指定"
  fi

  printf '%s检测到多个可能的部署方式：%s\n' "$C_YELLOW" "$C_RESET"
  for i in "${!DETECT_TYPES[@]}"; do
    printf '  %d) %-8s 分数 %-3s  %s\n' "$((i + 1))" "${DETECT_TYPES[$i]}" "${DETECT_SCORES[$i]}" "${DETECT_REASONS[$i]}"
  done
  local choice=""
  read -r -p "请选择 [1-$n]: " choice || die "未选择部署方式"
  case "$choice" in
    ''|*[!0-9]*) die "无效选择" ;;
  esac
  [ "$choice" -ge 1 ] && [ "$choice" -le "$n" ] || die "无效选择"
  TYPE="${DETECT_TYPES[$((choice - 1))]}"
  info "使用部署方式: $TYPE"
}

# ---------- Docker 辅助 ----------

docker_current_version() {
  docker_available || return 0
  local container="" image=""
  container="$(docker ps -a --filter 'name=^/momo-backend$' --format '{{.Names}}' 2>/dev/null | head -n 1)"
  if [ -z "$container" ] && compose_file >/dev/null 2>&1 && compose_cmd 2>/dev/null; then
    container="$(${COMPOSE_CMD[@]} -f "$(compose_file)" ps -q 2>/dev/null | head -n 1)"
    if [ -n "$container" ]; then
      container="$(docker inspect -f '{{.Name}}' "$container" 2>/dev/null | sed 's#^/##')"
    fi
  fi
  if [ -n "$container" ]; then
    image="$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true)"
  fi
  if [ -z "$image" ] && compose_file >/dev/null 2>&1; then
    image="$(grep -E '^[[:space:]]*image:' "$(compose_file)" 2>/dev/null | head -n 1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '"' | tr -d "'")"
  fi
  if [ -n "$image" ]; then
    local label=""
    label="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image" 2>/dev/null || true)"
    case "$label" in ''|'<no value>') ;; *) normalize_version "$label"; return 0 ;; esac
    case "$image" in
      *:v[0-9]*) printf '%s' "$(normalize_version "${image##*:}")"; return 0 ;;
      *:[0-9]*) printf '%s' "$(normalize_version "${image##*:}")"; return 0 ;;
    esac
  fi
  if [ -n "$container" ]; then
    local out=""
    out="$(docker exec "$container" ./momo-backend --version 2>/dev/null || true)"
    out="$(printf '%s\n' "$out" | sed -n 's/.*version[[:space:]]\+\([0-9][0-9A-Za-z._-]*\).*/\1/p' | head -n 1)"
    [ -n "$out" ] && { printf '%s' "$out"; return 0; }
  fi
  state_get version
}

# ---------- 下载 ----------

dedupe_urls() {
  local out=() u x seen
  for u in "$@"; do
    [ -n "$u" ] || continue
    seen=0
    for x in "${out[@]}"; do
      [ "$x" = "$u" ] && { seen=1; break; }
    done
    [ "$seen" -eq 0 ] && out+=("$u")
  done
  printf '%s\n' "${out[@]}"
}

download_file() {
  local url="$1" dest="$2" label="$3"
  local urls=()
  if [ "$USE_MIRROR" -eq 1 ]; then
    urls+=("${MIRROR_PREFIX}${url}")
  fi
  urls+=("$url")
  if [ "$NO_MIRROR" -eq 0 ]; then
    urls+=("${MIRROR_PREFIX}${url}")
    [ "$MIRROR_PREFIX" != "$DEFAULT_MIRROR_PREFIX" ] && urls+=("${DEFAULT_MIRROR_PREFIX}${url}")
    urls+=("https://ghproxy.net/${url}")
  fi
  mapfile -t urls < <(dedupe_urls "${urls[@]}")

  local u=""
  for u in "${urls[@]}"; do
    info "下载 $label: $u"
    rm -f "$dest"
    if have curl; then
      if curl -fL --retry 2 --retry-delay 2 --connect-timeout 10 --max-time 600 -o "$dest" "$u"; then
        [ -s "$dest" ] && return 0
      fi
    elif have wget; then
      if wget -q --timeout=30 --tries=3 -O "$dest" "$u"; then
        [ -s "$dest" ] && return 0
      fi
    fi
    warn "下载失败: $u"
  done
  rm -f "$dest"
  return 1
}

extract_zip() {
  local zip="$1" dest="$2"
  mkdir -p "$dest"
  if have unzip; then
    unzip -q -o "$zip" -d "$dest"
    local rc=$?
    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    # Windows Compress-Archive 生成的 zip 可能用反斜杠分隔路径；
    # unzip 会警告并返回 1，但文件通常已经解出，按“有文件”视为成功。
    if find "$dest" -type f -print -quit 2>/dev/null | grep -q .; then
      warn "zip 路径分隔符不规范（可能来自 Windows），已尽量解压"
      return 0
    fi
    return "$rc"
  elif have python3; then
    python3 -m zipfile -e "$zip" "$dest" || return 1
  elif tar --version 2>/dev/null | grep -qi 'bsdtar'; then
    tar -xf "$zip" -C "$dest" || return 1
  else
    return 1
  fi
}

release_asset_url() {
  local asset="$1"
  [ -n "$RELEASE_BASE" ] || return 1
  printf '%s/%s/%s' "$RELEASE_BASE" "$TARGET_TAG" "$asset"
}

prepare_public_asset() {
  local asset="$TYPE.zip"
  local url=""
  url="$(release_asset_url "$asset")" || die "当前仓库不是 GitHub 仓库，无法下载 Release 资产"
  local zip="$TMP_DIR/$asset"
  local dest="$TMP_DIR/release-$TYPE"

  if [ "$DRY_RUN" -eq 1 ]; then
    info "将下载并提取管理面板: $url"
    PUBLIC_SRC=""
    return 0
  fi

  download_file "$url" "$zip" "$asset" || die "下载 Release 资产失败: $url"
  ensure_zip_tool
  extract_zip "$zip" "$dest" || die "解压失败: $zip"
  local candidate="$dest/$TYPE/public"
  [ -d "$candidate" ] || candidate="$dest/public"
  [ -d "$candidate" ] || die "Release 包中未找到 $TYPE/public"
  PUBLIC_SRC="$candidate"
  ok "已获取 $TYPE 的 public"
}

# ---------- 备份 ----------

manifest_put() {
  [ -n "${MANIFEST:-}" ] && [ -f "$MANIFEST" ] || return 0
  printf '%s\n' "$*" >> "$MANIFEST"
}

compute_backup_dir() {
  if [ "$NO_BACKUP" -eq 1 ]; then
    BACKUP_DIR=""
    return 0
  fi
  local from="${CURRENT_VERSION:-unknown}"
  from="${from//\//_}"
  BACKUP_DIR="$BACKUP_ROOT/$TS-$TYPE-$from-to-$TARGET_VERSION"
}

init_backup() {
  compute_backup_dir
  if [ -z "$BACKUP_DIR" ]; then
    MANIFEST=""
    warn "已按 --no-backup 跳过备份"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    MANIFEST=""
    return 0
  fi
  if [ -f "$BACKUP_DIR/manifest.txt" ]; then
    MANIFEST="$BACKUP_DIR/manifest.txt"
    return 0
  fi
  mkdir -p "$BACKUP_DIR/files" "$BACKUP_DIR/db" "$BACKUP_DIR/archives"
  MANIFEST="$BACKUP_DIR/manifest.txt"
  : > "$MANIFEST"
  manifest_put "type"$'\t'"$TYPE"
  manifest_put "fromVersion"$'\t'"$CURRENT_VERSION"
  manifest_put "toVersion"$'\t'"$TARGET_VERSION"
  manifest_put "fromRef"$'\t'"$CURRENT_REF"
  manifest_put "toRef"$'\t'"$TARGET_REF"
  manifest_put "git"$'\t'"$GIT_ROOT"
  manifest_put "created"$'\t'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

backup_file() {
  local kind="$1" state="$2" rel="$3"
  [ "$DRY_RUN" -eq 1 ] && return 0
  [ -n "$BACKUP_DIR" ] || return 0
  case "$rel" in
    /*|*..*|*$'\t'*|*$'\n'*) warn "跳过异常路径备份: $rel"; return 0 ;;
  esac
  local src="$ROOT/$rel"
  local dest="$BACKUP_DIR/files/$rel"
  if [ "$state" != "added" ] && [ -e "$src" ]; then
    mkdir -p "$(dirname "$dest")"
    cp -p "$src" "$dest" 2>/dev/null || cp "$src" "$dest" || { warn "备份失败: $rel"; return 0; }
  fi
  if [ "$kind" = "config" ]; then
    manifest_put "config"$'\t'"$rel"
  else
    manifest_put "$kind"$'\t'"$state"$'\t'"$rel"
  fi
}

backup_config() {
  local rel="$1"
  [ -e "$ROOT/$rel" ] || return 0
  backup_file config modified "$rel"
}

backup_archive() {
  local kind="$1" rel="$2"
  [ "$DRY_RUN" -eq 1 ] && return 0
  [ -n "$BACKUP_DIR" ] || return 0
  if [ ! -e "$ROOT/$rel" ]; then
    manifest_put "archive-absent"$'\t'"$kind"$'\t'"$rel"
    return 0
  fi
  local name
  name="$(printf '%s' "$rel" | tr '/' '_').tar.gz"
  local dest="$BACKUP_DIR/archives/$name"
  if tar -czf "$dest" -C "$ROOT" "$rel" 2>/dev/null; then
    manifest_put "archive"$'\t'"$kind"$'\t'"$rel"$'\t'"$name"
  else
    warn "目录备份失败: $rel"
  fi
}

backup_db_files() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  [ -n "$BACKUP_DIR" ] || return 0
  local dirs=("$ROOT/nodejs/data" "$ROOT/go/data" "$ROOT/data")
  local f rel dest
  for f in "${dirs[@]}"/*.db "${dirs[@]}"/*.sqlite; do
    [ -f "$f" ] || continue
    rel="${f#"$ROOT"/}"
    dest="$BACKUP_DIR/db/$rel"
    mkdir -p "$(dirname "$dest")"
    if have sqlite3 && sqlite3 "$f" ".backup '$dest'" >/dev/null 2>&1; then
      :
    else
      cp -p "$f" "$dest" 2>/dev/null || cp "$f" "$dest" || { warn "数据库备份失败: $rel"; continue; }
      [ -f "$f-wal" ] && cp -p "$f-wal" "$dest-wal" 2>/dev/null || true
      [ -f "$f-shm" ] && cp -p "$f-shm" "$dest-shm" 2>/dev/null || true
    fi
    manifest_put "db"$'\t'"$rel"
  done
}

backup_configs() {
  case "$TYPE" in
    nodejs)
      backup_config "nodejs/.env"
      backup_config "nodejs/.env.local"
      backup_config "nodejs/.env.production"
      ;;
    worker)
      backup_config "worker/wrangler.jsonc"
      backup_config "worker/wrangler.e2e.jsonc"
      backup_config "worker/.dev.vars"
      backup_config "worker/.env"
      ;;
    go)
      backup_config "go/config/config.yaml"
      backup_config "config/config.yaml"
      ;;
    docker)
      backup_config "docker-compose.yml"
      backup_config "docker-compose.yaml"
      backup_config "compose.yml"
      backup_config "compose.yaml"
      backup_config ".env"
      ;;
  esac
}

# ---------- git diff 应用 ----------

is_protected_path() {
  case "$1" in
    */.env|*/.env.*|*/node_modules/*|*/dist/*|*/logs/*|*/.wrangler/*|*/.dev.vars*|*/wrangler.jsonc|*/wrangler.e2e.jsonc|*.db|*.db-wal|*.db-shm|.momo-update/*)
      return 0 ;;
    nodejs/public/*|worker/public/*|public/*)
      return 0 ;;
    nodejs/data/*|go/data/*|data/*)
      return 0 ;;
  esac
  return 1
}

collect_changes() {
  local base="$1" target="$2" scope="$3"
  local out="$TMP_DIR/changes.z"
  CHG_STATUS=(); CHG_OLD=(); CHG_NEW=()

  if [ "$GIT_ROOT" -eq 1 ]; then
    git -C "$ROOT" diff --name-status -z "$base" "$target" > "$out" || die "git diff 失败"
  else
    if [ -n "$scope" ]; then
      git --git-dir="$CACHE_REPO" diff --name-status -z "$base" "$target" -- "$scope" > "$out" || die "git diff 失败"
    else
      git --git-dir="$CACHE_REPO" diff --name-status -z "$base" "$target" > "$out" || die "git diff 失败"
    fi
  fi

  local status="" old="" new=""
  while IFS= read -r -d '' status; do
    case "$status" in
      R*|C*)
        IFS= read -r -d '' old || true
        IFS= read -r -d '' new || true
        CHG_STATUS+=("$status"); CHG_OLD+=("$old"); CHG_NEW+=("$new")
        ;;
      *)
        IFS= read -r -d '' new || true
        CHG_STATUS+=("$status"); CHG_OLD+=(""); CHG_NEW+=("$new")
        ;;
    esac
  done < "$out"
}

backup_changes() {
  local i=0 st="" old="" new=""
  for i in "${!CHG_STATUS[@]}"; do
    st="${CHG_STATUS[$i]}"; old="${CHG_OLD[$i]}"; new="${CHG_NEW[$i]}"
    case "$st" in
      A*) backup_file file added "$new" ;;
      D*) backup_file file deleted "$new" ;;
      R*) backup_file file deleted "$old"; backup_file file added "$new" ;;
      C*) backup_file file added "$new" ;;
      *) backup_file file modified "$new" ;;
    esac
  done
}

check_git_state() {
  [ "$GIT_ROOT" -eq 1 ] || return 0
  local dirty=""
  dirty="$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    if [ "$FORCE" -eq 1 ]; then
      warn "检测到本地 git 修改，--force 已启用，将先备份再覆盖："
      printf '%s\n' "$dirty" | sed 's/^/  /'
      if [ -n "$BACKUP_DIR" ] && [ "$DRY_RUN" -eq 0 ]; then
        git -C "$ROOT" diff HEAD > "$BACKUP_DIR/local-changes.patch" 2>/dev/null || true
        git -C "$ROOT" diff --cached >> "$BACKUP_DIR/local-changes.patch" 2>/dev/null || true
        manifest_put "localPatch"$'\t'"local-changes.patch"
      fi
      if [ "$DRY_RUN" -eq 0 ]; then
        git -C "$ROOT" reset --hard HEAD >/dev/null 2>&1 || die "无法清理本地 git 修改"
      fi
    else
      printf '%s\n' "$dirty" | sed 's/^/  /' >&2
      if [ "$DRY_RUN" -eq 1 ]; then
        warn "dry-run：工作区有未提交修改，实际更新会中止；请在真正更新前提交/暂存，或使用 --force"
      else
        die "工作区有未提交的 git 修改；请先提交/暂存，或使用 --force（会先备份再覆盖）"
      fi
    fi
  fi

  local ahead=""
  ahead="$(git -C "$ROOT" rev-list --count "$TARGET_REF"..HEAD 2>/dev/null || echo 0)"
  if [ "${ahead:-0}" -gt 0 ] && [ "$FORCE" -eq 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "dry-run：当前 HEAD 含有目标 Release 之外的本地提交（$ahead 个），实际更新会中止"
    else
      die "当前 HEAD 含有目标 Release 之外的本地提交（$ahead 个）；请先处理，或使用 --force"
    fi
  fi
}

extract_target_tree() {
  local scope="$1" dest="$2"
  mkdir -p "$dest"
  if [ "$GIT_ROOT" -eq 1 ]; then
    git -C "$ROOT" archive --format=tar "$TARGET_REF" -- "$scope" > "$TMP_DIR/source.tar" || die "git archive 失败"
  else
    git --git-dir="$CACHE_REPO" archive --format=tar "$TARGET_REF" -- "$scope" > "$TMP_DIR/source.tar" || die "git archive 失败"
  fi
  tar -xf "$TMP_DIR/source.tar" -C "$dest" || die "解压源码失败"
}

apply_nongit_changes() {
  extract_target_tree "$TYPE" "$TMP_DIR/target-tree"
  backup_changes

  local i=0 st="" old="" new="" src="" dst=""
  local skipped=0 applied=0
  for i in "${!CHG_STATUS[@]}"; do
    st="${CHG_STATUS[$i]}"; old="${CHG_OLD[$i]}"; new="${CHG_NEW[$i]}"
    if is_protected_path "$new"; then
      warn "跳过受保护文件: $new"
      skipped=$((skipped + 1))
      continue
    fi
    case "$st" in
      A*|M*|T*)
        src="$TMP_DIR/target-tree/$new"
        dst="$ROOT/$new"
        [ -f "$src" ] || { warn "目标版本缺少文件: $new"; continue; }
        mkdir -p "$(dirname "$dst")"
        cp -p "$src" "$dst" 2>/dev/null || cp "$src" "$dst" || die "写入失败: $new"
        applied=$((applied + 1))
        ;;
      D*)
        rm -f "$ROOT/$new"
        applied=$((applied + 1))
        ;;
      R*)
        if is_protected_path "$old"; then
          warn "跳过受保护文件: $old"
        else
          rm -f "$ROOT/$old"
          src="$TMP_DIR/target-tree/$new"
          dst="$ROOT/$new"
          [ -f "$src" ] || { warn "目标版本缺少文件: $new"; continue; }
          mkdir -p "$(dirname "$dst")"
          cp -p "$src" "$dst" 2>/dev/null || cp "$src" "$dst" || die "写入失败: $new"
          applied=$((applied + 1))
        fi
        ;;
      C*)
        src="$TMP_DIR/target-tree/$new"
        dst="$ROOT/$new"
        [ -f "$src" ] || continue
        mkdir -p "$(dirname "$dst")"
        cp -p "$src" "$dst" 2>/dev/null || cp "$src" "$dst" || die "写入失败: $new"
        applied=$((applied + 1))
        ;;
      *)
        warn "未知 diff 状态 $st: $new"
        ;;
    esac
  done
  info "已应用 $applied 个文件变更，跳过 $skipped 个受保护文件"
}

# ---------- 公共文件替换 ----------

replace_public() {
  local rel="$1"
  [ -n "$PUBLIC_SRC" ] || return 0
  if [ "$DRY_RUN" -eq 1 ]; then
    info "将替换管理面板: $rel"
    return 0
  fi
  rm -rf "$ROOT/$rel"
  mkdir -p "$(dirname "$ROOT/$rel")"
  cp -a "$PUBLIC_SRC" "$ROOT/$rel" || die "替换管理面板失败: $rel"
  ok "已更新管理面板: $rel"
}

# ---------- 安装 / 构建 ----------

package_manager_cmd() {
  if have pnpm; then
    PM="pnpm"
  elif have corepack && corepack pnpm --version >/dev/null 2>&1; then
    PM="corepack pnpm"
  elif have npm; then
    PM="npm"
    warn "未找到 pnpm，回退到 npm（可能与 pnpm-lock.yaml 不完全一致）"
  else
    die "未找到 pnpm / npm，请先安装 Node.js 与 pnpm"
  fi
}

run_pm() {
  local dir="$1"; shift
  local registry_env=()
  [ -n "$NPM_REGISTRY" ] && registry_env=(env "npm_config_registry=$NPM_REGISTRY")
  ( cd "$dir" && "${registry_env[@]}" $PM "$@" ) || return 1
}

install_and_build_node() {  package_manager_cmd
  if have node; then
    local major=""
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "${major:-0}" -ge 22 ] 2>/dev/null || warn "Node.js 版本低于 22，可能无法运行"
  fi
  info "安装 Node.js 依赖..."
  run_pm "$ROOT/nodejs" install || die "依赖安装失败；可用 --rollback 回滚"
  ensure_node_native
  info "构建 Node.js..."
  run_pm "$ROOT/nodejs" run build || die "构建失败；可用 --rollback 回滚"
  ok "Node.js 构建完成"
}

# pnpm 10 默认会忽略依赖的 install 脚本，better-sqlite3 不构建就无法启动。
# 这里只补一个最小 workspace 配置，不覆盖项目已有的 pnpm-workspace.yaml。
ensure_node_native() {
  local dir="$ROOT/nodejs"
  local native="$dir/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  [ -d "$dir/node_modules/better-sqlite3" ] || return 0
  [ -f "$native" ] && return 0
  case "$PM" in
    *pnpm*) ;;
    *) warn "better-sqlite3 原生模块未构建；npm 通常会自动执行 install 脚本，如仍失败请手动处理" ;;
  esac
  [ "$PM" = "npm" ] && return 0

  local ws="$dir/pnpm-workspace.yaml"
  local created=0
  if [ -f "$ws" ]; then
    if ! grep -q 'better-sqlite3' "$ws" 2>/dev/null; then
      warn "检测到 $ws，但未允许 better-sqlite3 构建；请手动添加 onlyBuiltDependencies"
      return 0
    fi
  else
    warn "better-sqlite3 原生模块缺失，正在临时启用 pnpm 构建脚本"
    if [ "$DRY_RUN" -eq 0 ]; then
      printf 'onlyBuiltDependencies:\n  - better-sqlite3\n' > "$ws"
      created=1
    fi
  fi

  local rc=0
  run_pm "$dir" rebuild better-sqlite3 || rc=1
  if [ "$created" -eq 1 ]; then
    rm -f "$ws"
  fi
  if [ "$rc" -ne 0 ]; then
    warn "重新构建失败，请手动执行 pnpm approve-builds"
    return 0
  fi
  if [ -f "$native" ]; then
    ok "better-sqlite3 原生模块已构建"
  else
    warn "better-sqlite3 仍未构建；请进入 nodejs/ 执行 pnpm approve-builds"
  fi
}

install_worker() {
  package_manager_cmd
  info "安装 Worker 依赖..."
  if [ "$PM" = "npm" ]; then
    run_pm "$ROOT/worker" install || die "依赖安装失败；可用 --rollback 回滚"
    ok "Worker 依赖安装完成"
    return 0
  fi

  run_pm "$ROOT/worker" install --ignore-scripts || die "依赖安装失败；可用 --rollback 回滚"

  # pnpm 10/11 默认拦截 esbuild / sharp / workerd 的构建脚本，
  # 不构建会导致 wrangler deploy 失败；临时放开后 rebuild。
  local ws="$ROOT/worker/pnpm-workspace.yaml"
  local created=0
  if [ -f "$ws" ]; then
    if ! grep -q 'workerd' "$ws" 2>/dev/null; then
      warn "检测到 $ws，但未允许 workerd/esbuild/sharp 构建；请手动添加 onlyBuiltDependencies"
    fi
  else
    printf 'onlyBuiltDependencies:\n  - esbuild\n  - sharp\n  - workerd\n' > "$ws"
    created=1
  fi
  if [ "$created" -eq 1 ] || grep -q 'workerd' "$ws" 2>/dev/null; then
    run_pm "$ROOT/worker" rebuild esbuild sharp workerd || warn "Worker 原生依赖构建失败，请进入 worker/ 执行 pnpm approve-builds"
  fi
  [ "$created" -eq 1 ] && rm -f "$ws"

  ok "Worker 依赖安装完成"
}

# ---------- 更新流程 ----------

print_restart_help() {
  say ""
  say "${C_BOLD}下一步（脚本不会自动重启服务）：${C_RESET}"
  case "$TYPE" in
    nodejs)
      if have pm2 && pm2 jlist >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q '"name":"momo-backend"'; then
        say "  pm2 restart momo-backend"
      else
        say "  cd \"$ROOT/nodejs\" && pnpm start"
        say "  如果你用 pm2 / systemd 管理，请执行对应的 restart 命令。"
      fi
      if [ "${SCHEMA_CHANGED:-0}" -eq 1 ]; then
        say ""
        say "${C_YELLOW}检测到数据库 schema 变更，请确认后执行：${C_RESET}"
        say "  cd \"$ROOT/nodejs\" && pnpm db:push"
        say "  脚本已备份数据库到: $BACKUP_DIR/db"
      fi
      ;;
    worker)
      say "  cd \"$ROOT/worker\" && pnpm run deploy"
      say "  Worker 首次请求会自动迁移 D1；如报数据库错误，可在 D1 控制台执行 worker/schemas/comment.sql。"
      ;;
    go)
      if [ -f "$ROOT/momo.bash" ]; then
        say "  cd \"$ROOT\" && ./momo.bash   # 选择 3) 重启服务"
      elif have systemctl; then
        say "  sudo systemctl restart momo-backend"
      else
        say "  按你原来的方式重启 Go 二进制。"
      fi
      ;;
    docker)
      if [ "${#COMPOSE_CMD[@]}" -eq 0 ]; then
        compose_cmd >/dev/null 2>&1 || true
      fi
      if [ "${#COMPOSE_CMD[@]}" -gt 0 ] && compose_file >/dev/null 2>&1; then
        say "  cd \"$ROOT\" && ${COMPOSE_CMD[*]} -f \"$(compose_file)\" up -d"
        say "  查看状态: ${COMPOSE_CMD[*]} -f \"$(compose_file)\" ps"
      else
        say "  docker compose up -d"
      fi
      ;;
  esac
  say ""
}

update_nodejs() {
  prepare_public_asset
  init_backup
  backup_configs
  backup_db_files
  backup_archive public "nodejs/public"
  backup_archive dist "nodejs/dist"

  local base="$CURRENT_REF"
  local scope="nodejs"
  if [ "$GIT_ROOT" -eq 1 ]; then
    collect_changes "$base" "$TARGET_REF" ""
  else
    collect_changes "$base" "$TARGET_REF" "$scope"
  fi

  if [ "${#CHG_STATUS[@]}" -eq 0 ]; then
    info "源码没有差异，仅更新管理面板并重新构建"
  else
    info "检测到 ${#CHG_STATUS[@]} 个源码文件变更"
    local i=0
    for i in "${!CHG_STATUS[@]}"; do
      [ "$i" -ge 20 ] && { say "  ... 其余 $(( ${#CHG_STATUS[@]} - 20 )) 个文件见日志"; break; }
      say "  ${CHG_STATUS[$i]}  ${CHG_NEW[$i]}"
    done
  fi

  if [ "$GIT_ROOT" -eq 1 ]; then
    check_git_state
    if [ "${#CHG_STATUS[@]}" -gt 0 ]; then
      backup_changes
      if [ "$DRY_RUN" -eq 0 ]; then
        git -C "$ROOT" checkout --detach "$TARGET_REF" >/dev/null 2>&1 || die "git checkout $TARGET_REF 失败；备份位于 $BACKUP_DIR"
        if [ -f "$BACKUP_DIR/files/nodejs/.env" ]; then
          cp -p "$BACKUP_DIR/files/nodejs/.env" "$ROOT/nodejs/.env" 2>/dev/null || true
        fi
      else
        info "将执行: git checkout --detach $TARGET_REF"
      fi
    fi
  else
    if [ "${#CHG_STATUS[@]}" -gt 0 ] && [ "$DRY_RUN" -eq 0 ]; then
      apply_nongit_changes
    elif [ "$DRY_RUN" -eq 1 ]; then
      info "将应用 git diff: $CURRENT_REF..$TARGET_REF -- nodejs"
    fi
  fi

  replace_public "nodejs/public"

  if [ "$DRY_RUN" -eq 1 ]; then
    info "将执行: cd nodejs && pnpm install && pnpm run build"
    return 0
  fi

  install_and_build_node

  if [ "$GIT_ROOT" -eq 1 ]; then
    if git -C "$ROOT" diff --name-only "$CURRENT_REF_FULL" "$TARGET_REF" -- nodejs/src/orm/schema.ts 2>/dev/null | grep -q .; then
      SCHEMA_CHANGED=1
    fi
  else
    local i=0
    for i in "${!CHG_STATUS[@]}"; do
      case "${CHG_NEW[$i]}" in nodejs/src/orm/schema.ts) SCHEMA_CHANGED=1 ;; esac
    done
  fi

  write_state
  prune_backups
  print_restart_help
}

update_worker() {
  prepare_public_asset
  init_backup
  backup_configs
  backup_db_files
  backup_archive public "worker/public"

  local base="$CURRENT_REF"
  local scope="worker"
  if [ "$GIT_ROOT" -eq 1 ]; then
    collect_changes "$base" "$TARGET_REF" ""
  else
    collect_changes "$base" "$TARGET_REF" "$scope"
  fi

  if [ "${#CHG_STATUS[@]}" -eq 0 ]; then
    info "源码没有差异，仅更新管理面板并安装依赖"
  else
    info "检测到 ${#CHG_STATUS[@]} 个源码文件变更"
    local i=0
    for i in "${!CHG_STATUS[@]}"; do
      [ "$i" -ge 20 ] && { say "  ... 其余 $(( ${#CHG_STATUS[@]} - 20 )) 个文件见日志"; break; }
      say "  ${CHG_STATUS[$i]}  ${CHG_NEW[$i]}"
    done
  fi

  if [ "$GIT_ROOT" -eq 1 ]; then
    check_git_state
    if [ "${#CHG_STATUS[@]}" -gt 0 ]; then
      backup_changes
      if [ "$DRY_RUN" -eq 0 ]; then
        git -C "$ROOT" checkout --detach "$TARGET_REF" >/dev/null 2>&1 || die "git checkout $TARGET_REF 失败；备份位于 $BACKUP_DIR"
        if [ -f "$BACKUP_DIR/files/worker/wrangler.jsonc" ]; then
          cp -p "$BACKUP_DIR/files/worker/wrangler.jsonc" "$ROOT/worker/wrangler.jsonc" 2>/dev/null || true
        fi
      else
        info "将执行: git checkout --detach $TARGET_REF（保留 wrangler.jsonc）"
      fi
    fi
  else
    if [ "${#CHG_STATUS[@]}" -gt 0 ] && [ "$DRY_RUN" -eq 0 ]; then
      apply_nongit_changes
    elif [ "$DRY_RUN" -eq 1 ]; then
      info "将应用 git diff: $CURRENT_REF..$TARGET_REF -- worker"
    fi
  fi

  replace_public "worker/public"

  if [ "$DRY_RUN" -eq 1 ]; then
    info "将执行: cd worker && pnpm install"
    return 0
  fi

  install_worker
  write_state
  prune_backups
  print_restart_help
}

update_go() {
  local os="$1" arch="$2"
  [ "$arch" = "amd64" ] || die "Release 只提供 amd64 的 Go 包（当前架构: $arch）；请自行编译"
  local asset=""
  if [ "$os" = "windows" ]; then
    asset="go-windows-amd64.zip"
  else
    asset="go-linux-amd64.tar.gz"
  fi
  local url=""
  url="$(release_asset_url "$asset")" || die "当前仓库不是 GitHub 仓库，无法下载 Release 资产"

  local gobin=""
  gobin="$(find_go_binary)"
  [ -n "$gobin" ] || die "未找到 Go 二进制（momo-backend-*）"

  if [ "$DRY_RUN" -eq 1 ]; then
    info "将下载: $url"
    info "将替换: $(basename "$gobin") 和 public/，保留 config/ 与 data/"
    return 0
  fi

  local pkg="$TMP_DIR/go-package"
  mkdir -p "$pkg"
  if [ "$os" = "windows" ]; then
    local zip="$TMP_DIR/$asset"
    download_file "$url" "$zip" "$asset" || die "下载 Go Release 失败: $url"
    ensure_zip_tool
    extract_zip "$zip" "$pkg" || die "解压 Go Release 失败"
  else
    local tgz="$TMP_DIR/$asset"
    download_file "$url" "$tgz" "$asset" || die "下载 Go Release 失败: $url"
    tar -xzf "$tgz" -C "$pkg" || die "解压 Go Release 失败"
  fi

  GO_NEW_BIN="$(find "$pkg" -maxdepth 3 -type f -name 'momo-backend-*' | head -n 1)"
  [ -n "$GO_NEW_BIN" ] || die "Go Release 中未找到二进制"
  chmod +x "$GO_NEW_BIN" 2>/dev/null || true
  local newver=""
  newver="$(binary_version "$GO_NEW_BIN")"
  [ -n "$newver" ] || die "无法运行新 Go 二进制验证版本"
  [ "$newver" = "$TARGET_VERSION" ] || warn "新二进制版本 $newver 与目标 $TARGET_VERSION 不一致"

  GO_NEW_PUBLIC="$(find "$pkg" -maxdepth 3 -type d -name public | head -n 1)"
  GO_NEW_MOMO_BASH="$(find "$pkg" -maxdepth 3 -type f -name 'momo.bash' | head -n 1)"

  init_backup
  backup_configs
  backup_db_files
  backup_file file modified "$(basename "$gobin")"
  backup_archive public "public"
  [ -f "$ROOT/momo.bash" ] && backup_file file modified "momo.bash"

  local ts="$TS"
  local old="$gobin.old-$ts"
  if ! mv "$gobin" "$old" 2>/dev/null; then
    cp "$GO_NEW_BIN" "$gobin.new" || die "无法写入新二进制"
    die "二进制正在运行且无法替换；已保存为 $gobin.new，请停止服务后手动替换（旧文件仍在）"
  fi
  if ! cp "$GO_NEW_BIN" "$gobin"; then
    mv "$old" "$gobin" 2>/dev/null || true
    die "替换 Go 二进制失败，已尝试恢复"
  fi
  chmod +x "$gobin" 2>/dev/null || true

  if [ -n "$GO_NEW_PUBLIC" ] && [ -d "$GO_NEW_PUBLIC" ]; then
    rm -rf "$ROOT/public"
    cp -a "$GO_NEW_PUBLIC" "$ROOT/public" || die "替换 public 失败"
  fi
  if [ -n "$GO_NEW_MOMO_BASH" ] && [ "$os" != "windows" ]; then
    cp "$GO_NEW_MOMO_BASH" "$ROOT/momo.bash" || warn "更新 momo.bash 失败"
    chmod +x "$ROOT/momo.bash" 2>/dev/null || true
  fi

  local finalver=""
  finalver="$(binary_version "$gobin")"
  [ "$finalver" = "$TARGET_VERSION" ] || die "更新后版本校验失败（$finalver != $TARGET_VERSION）"

  write_state
  prune_backups
  print_restart_help
  say "旧二进制保留在: $old（确认运行正常后可删除）"
}

update_docker() {
  docker_available || die "Docker 不可用"
  compose_file >/dev/null 2>&1 || die "未找到 docker-compose.yml / compose.yml"
  compose_cmd || die "未找到 docker compose / docker-compose"
  local cfile=""
  cfile="$(compose_file)"

  local container="" image=""
  container="$(docker ps -a --filter 'name=^/momo-backend$' --format '{{.Names}}' 2>/dev/null | head -n 1)"
  if [ -z "$container" ]; then
    local cid=""
    cid="$(${COMPOSE_CMD[@]} -f "$cfile" ps -q 2>/dev/null | head -n 1)"
    [ -n "$cid" ] && container="$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##')"
  fi
  if [ -n "$container" ]; then
    image="$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true)"
  fi
  if [ -z "$image" ]; then
    image="$(grep -E '^[[:space:]]*image:' "$cfile" | head -n 1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '"' | tr -d "'")"
  fi
  [ -n "$image" ] || die "无法从 compose 文件解析镜像名"

  local repo="$image" tag="latest"
  case "$image" in
    *@sha256:*)
      die "compose 使用 digest 固定镜像（$image），无法自动切换版本；请把 image 改成 tag 形式"
      ;;
  esac
  image="${image%%@*}"
  case "$image" in
    *:*)
      local last="${image##*/}"
      case "$last" in
        *:*) repo="${image%:*}"; tag="${image##*:}" ;;
        *) repo="$image"; tag="latest" ;;
      esac
      ;;
  esac
  [ -n "$repo" ] || die "无法解析镜像仓库: $image"

  local target_image="$repo:$TARGET_VERSION"
  local mirror_ref=""
  if [ "$USE_MIRROR" -eq 1 ]; then
    case "$repo" in
      ghcr.io/*) mirror_ref="$GHCR_MIRROR/${repo#ghcr.io/}" ;;
      docker.io/*) mirror_ref="$DOCKERHUB_MIRROR/${repo#docker.io/}" ;;
      *) case "$repo" in */*.*/*) ;; *) mirror_ref="$DOCKERHUB_MIRROR/$repo" ;; esac ;;
    esac
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    info "将拉取镜像: $target_image"
    [ -n "$mirror_ref" ] && info "优先尝试镜像: $mirror_ref:$TARGET_VERSION"
    info "将把 $target_image 标记为 $repo:$tag"
    info "将备份数据库并保留当前镜像为 rollback tag"
    info "将执行: ${COMPOSE_CMD[*]} -f $cfile up -d"
    return 0
  fi

  local pulled=0
  if [ -n "$mirror_ref" ]; then
    info "拉取镜像（国内镜像）: $mirror_ref:$TARGET_VERSION"
    if docker pull "$mirror_ref:$TARGET_VERSION"; then
      docker tag "$mirror_ref:$TARGET_VERSION" "$target_image" || die "镜像打标签失败"
      pulled=1
    else
      warn "国内镜像拉取失败，回退直连"
    fi
  fi
  if [ "$pulled" -eq 0 ]; then
    info "拉取镜像: $target_image"
    docker pull "$target_image" || die "拉取镜像失败: $target_image"
  fi

  init_backup
  backup_configs
  backup_db_files

  local img_id=""
  img_id="$(docker image inspect -f '{{.Id}}' "$repo:$tag" 2>/dev/null || true)"
  if [ -z "$img_id" ] && [ -n "$container" ]; then
    img_id="$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)"
  fi
  local backup_tag="$repo:rollback-$TS"
  if [ -n "$img_id" ]; then
    docker tag "$img_id" "$backup_tag" || warn "无法创建镜像回滚标签"
    manifest_put "docker"$'\t'"$repo"$'\t'"$tag"$'\t'"$backup_tag"
  else
    warn "未找到当前镜像，无法创建镜像回滚标签"
  fi

  if [ "$tag" != "$TARGET_VERSION" ]; then
    if [ "$tag" != "latest" ]; then
      warn "compose 固定了镜像标签 $tag；脚本会把新版本打上同一标签，建议改成 latest 或 $TARGET_VERSION"
    fi
    docker tag "$target_image" "$repo:$tag" || die "无法把新镜像标记为 $repo:$tag"
  fi

  write_state
  prune_backups
  print_restart_help
}

# ---------- 清理 / 回滚 ----------

prune_backups() {
  [ "$NO_BACKUP" -eq 0 ] || return 0
  [ -d "$BACKUP_ROOT" ] || return 0
  local dirs=()
  mapfile -t dirs < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort -r)
  local i=0
  for i in "${!dirs[@]}"; do
    [ "$i" -lt "$KEEP" ] && continue
    rm -rf "${dirs[$i]}"
  done
}

rollback() {
  [ -d "$BACKUP_ROOT" ] || die "没有可用的备份目录"
  local latest=""
  latest="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
  [ -n "$latest" ] || die "没有可用的备份"
  local manifest="$latest/manifest.txt"
  [ -f "$manifest" ] || die "备份缺少 manifest.txt: $latest"

  local rb_type="" rb_from_version="" rb_to_version="" rb_from_ref="" rb_git=0
  local rb_docker_repo="" rb_docker_tag="" rb_docker_backup=""
  local rb_files=() rb_file_states=() rb_configs=() rb_archives=() rb_archive_rels=() rb_archive_files=() rb_archives_absent=() rb_dbs=()

  local key="" a="" b="" c=""
  while IFS=$'\t' read -r key a b c; do
    key="${key%$'\r'}"; a="${a%$'\r'}"; b="${b%$'\r'}"; c="${c%$'\r'}"
    case "$key" in
      type) rb_type="$a" ;;
      fromVersion) rb_from_version="$a" ;;
      toVersion) rb_to_version="$a" ;;
      fromRef) rb_from_ref="$a" ;;
      git) rb_git="$a" ;;
      docker) rb_docker_repo="$a"; rb_docker_tag="$b"; rb_docker_backup="$c" ;;
      file) rb_file_states+=("$a"); rb_files+=("$b") ;;
      config) rb_configs+=("$a") ;;
      archive) rb_archives+=("$a"); rb_archive_rels+=("$b"); rb_archive_files+=("$c") ;;
      archive-absent) rb_archives_absent+=("$b") ;;
      db) rb_dbs+=("$a") ;;
    esac
  done < "$manifest"

  info "找到备份: $latest"
  info "类型: ${rb_type:-unknown}  版本: ${rb_from_version:-?} -> ${rb_to_version:-?}"
  [ "$DRY_RUN" -eq 1 ] && { info "dry-run：不会执行回滚"; return 0; }

  if [ "$YES" -eq 0 ] && [ -t 0 ]; then
    printf '%s回滚会把源码/管理面板/数据库恢复到更新前，继续? [y/N] %s' "$C_YELLOW" "$C_RESET"
    local ans=""
    read -r ans || die "未确认"
    case "$ans" in y|Y|yes|YES) ;; *) die "已取消" ;; esac
  fi

  TYPE="${rb_type:-$TYPE}"

  # 先切回旧 git 版本，再覆盖备份中的本地修改/配置
  if [ "$rb_git" = "1" ] && [ -n "$rb_from_ref" ] && [ -d "$ROOT/.git" ]; then
    info "回滚 git 版本到 $rb_from_ref"
    git -C "$ROOT" checkout -f --detach "$rb_from_ref" >/dev/null 2>&1 || warn "git checkout 回滚失败，将仅恢复备份文件"
    if [ -f "$latest/local-changes.patch" ]; then
      git -C "$ROOT" apply "$latest/local-changes.patch" >/dev/null 2>&1 \
        && info "已恢复更新前的本地 git 修改" \
        || warn "本地修改补丁无法自动应用，已保留: $latest/local-changes.patch"
    fi
  fi

  local i=0
  for i in "${!rb_files[@]}"; do
    local state="${rb_file_states[$i]}" rel="${rb_files[$i]}" src="$latest/files/${rb_files[$i]}" dst="$ROOT/${rb_files[$i]}"
    case "$rel" in /*|*..*) warn "跳过异常路径: $rel"; continue ;; esac
    if [ "$state" = "added" ]; then
      rm -f "$dst"
    else
      if [ -f "$src" ]; then
        mkdir -p "$(dirname "$dst")"
        cp -p "$src" "$dst" 2>/dev/null || cp "$src" "$dst" || warn "恢复失败: $rel"
      else
        warn "备份缺少文件: $rel"
      fi
    fi
  done

  for i in "${!rb_configs[@]}"; do
    local rel="${rb_configs[$i]}" src="$latest/files/${rb_configs[$i]}" dst="$ROOT/${rb_configs[$i]}"
    if [ -f "$src" ]; then
      mkdir -p "$(dirname "$dst")"
      cp -p "$src" "$dst" 2>/dev/null || cp "$src" "$dst" || warn "恢复配置失败: $rel"
    fi
  done

  for i in "${!rb_archives[@]}"; do
    local rel="${rb_archive_rels[$i]}" file="${rb_archive_files[$i]}"
    local archive="$latest/archives/$file"
    if [ -f "$archive" ]; then
      info "恢复目录: $rel"
      rm -rf "$ROOT/$rel"
      mkdir -p "$(dirname "$ROOT/$rel")"
      case "$file" in
        *.zip)
          ensure_zip_tool
          mkdir -p "$ROOT/$rel"
          extract_zip "$archive" "$ROOT/$rel" || warn "恢复目录失败: $rel"
          ;;
        *)
          tar -xzf "$archive" -C "$ROOT" || warn "恢复目录失败: $rel"
          ;;
      esac
    else
      warn "备份缺少目录归档: $file"
    fi
  done

  for i in "${!rb_archives_absent[@]}"; do
    local rel="${rb_archives_absent[$i]}"
    info "移除更新时新增的目录: $rel"
    rm -rf "$ROOT/$rel"
  done

  if [ "${#rb_dbs[@]}" -gt 0 ]; then
    warn "即将恢复数据库；如果服务仍在运行，请先停止服务，否则可能损坏数据"
  fi

  for i in "${!rb_dbs[@]}"; do
    local rel="${rb_dbs[$i]}" src="$latest/db/${rb_dbs[$i]}" dst="$ROOT/${rb_dbs[$i]}"
    [ -f "$src" ] || { warn "备份缺少数据库: $rel"; continue; }
    mkdir -p "$(dirname "$dst")"
    cp -p "$src" "$dst" 2>/dev/null || cp "$src" "$dst" || die "恢复数据库失败（请确认服务已停止）: $rel"
    rm -f "$dst-wal" "$dst-shm"
    [ -f "$src-wal" ] && cp -p "$src-wal" "$dst-wal" 2>/dev/null || true
    [ -f "$src-shm" ] && cp -p "$src-shm" "$dst-shm" 2>/dev/null || true
  done

  if [ -n "$rb_docker_backup" ]; then
    info "恢复 Docker 镜像: $rb_docker_backup -> $rb_docker_repo:$rb_docker_tag"
    docker tag "$rb_docker_backup" "$rb_docker_repo:$rb_docker_tag" || warn "镜像回滚失败"
  fi

  if [ -n "$rb_from_version" ] && [ "$rb_from_version" != "unknown" ]; then
    TYPE="$TYPE" TARGET_VERSION="$rb_from_version" TARGET_REF="$rb_from_ref" write_state
  fi

  ok "回滚完成（备份仍保留: $latest）"
  print_restart_help
}

# ---------- 主流程 ----------

main() {
  setup_dirs
  make_temp
  if [ "$DRY_RUN" -eq 1 ]; then
    # dry-run 不写项目目录：仓库缓存放到临时目录
    CACHE_DIR="$TMP_DIR/cache"
    CACHE_REPO="$CACHE_DIR/repo.git"
  fi
  ensure_basic_tools

  say "${C_BOLD}Momo Backend 更新脚本 v$SCRIPT_VERSION${C_RESET}"
  say "根目录: $ROOT"
  [ "$DRY_RUN" -eq 1 ] && say "${C_YELLOW}dry-run 模式：不会修改部署文件${C_RESET}"

  resolve_repo

  if [ "$ROLLBACK" -eq 1 ]; then
    rollback
    exit 0
  fi

  detect_type
  detect_mirror
  ensure_tags
  resolve_target
  resolve_current
  compute_backup_dir

  if [ "$DRY_RUN" -eq 0 ] && [ "$CURRENT_VERSION" != "unknown" ] && [ "$CURRENT_VERSION" = "$TARGET_VERSION" ] && [ "$FORCE" -eq 0 ]; then
    case "$TYPE" in
      nodejs) [ -d "$ROOT/nodejs/public" ] && { ok "当前已是最新版本 $TARGET_VERSION"; exit 0; } ;;
      worker) [ -d "$ROOT/worker/public" ] && { ok "当前已是最新版本 $TARGET_VERSION"; exit 0; } ;;
      *) ok "当前已是最新版本 $TARGET_VERSION"; exit 0 ;;
    esac
  fi

  if [ "$CURRENT_VERSION" != "unknown" ] && version_gt "$CURRENT_VERSION" "$TARGET_VERSION" && [ "$FORCE" -eq 0 ]; then
    warn "当前版本 $CURRENT_VERSION 高于目标版本 $TARGET_VERSION（降级）"
    if [ "$YES" -eq 0 ] && [ -t 0 ]; then
      printf '确认降级? [y/N] '
      read -r ans || die "已取消"
      case "$ans" in y|Y|yes|YES) ;; *) die "已取消" ;; esac
    fi
  fi

  say ""
  say "${C_BOLD}更新计划${C_RESET}"
  say "  部署类型: $TYPE"
  say "  当前版本: ${CURRENT_VERSION:-unknown}"
  say "  目标版本: $TARGET_VERSION ($TARGET_TAG)"
  say "  源码来源: $([ "$GIT_ROOT" -eq 1 ] && echo "git 仓库 $ROOT" || echo "临时缓存 $CACHE_REPO")"
  say "  仓库地址: $GIT_URL"
  say "  镜像模式: $([ "$USE_MIRROR" -eq 1 ] && echo "国内镜像" || echo "直连")"
  if [ "$NO_BACKUP" -eq 0 ]; then
    say "  备份目录: $BACKUP_DIR"
  else
    say "  备份目录: 已禁用"
  fi

  if [ "$DRY_RUN" -eq 0 ] && [ "$YES" -eq 0 ] && [ -t 0 ]; then
    say ""
    printf '%s即将执行更新，继续? [y/N] %s' "$C_YELLOW" "$C_RESET"
    local ans=""
    read -r ans || die "未确认"
    case "$ans" in y|Y|yes|YES) ;; *) die "已取消" ;; esac
  fi

  case "$TYPE" in
    nodejs) update_nodejs ;;
    worker) update_worker ;;
    go) update_go "$OS_NAME" "$ARCH_NAME" ;;
    docker) update_docker ;;
    *) die "未知部署类型: $TYPE" ;;
  esac

  if [ "$DRY_RUN" -eq 0 ]; then
    ok "更新完成：$CURRENT_VERSION -> $TARGET_VERSION"
    say "日志: ${LOG_FILE:-（未写入）}"
  fi
}

# ---------- 系统信息 ----------

detect_os_arch() {
  local os="" arch=""
  os="$(uname -s 2>/dev/null || echo unknown)"
  arch="$(uname -m 2>/dev/null || echo unknown)"
  case "$os" in
    Linux*) OS_NAME="linux" ;;
    Darwin*) OS_NAME="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) OS_NAME="windows" ;;
    *) OS_NAME="linux" ;;
  esac
  case "$arch" in
    x86_64|amd64|AMD64) ARCH_NAME="amd64" ;;
    aarch64|arm64|ARM64) ARCH_NAME="arm64" ;;
    i386|i686) ARCH_NAME="386" ;;
    *) ARCH_NAME="$arch" ;;
  esac
}

detect_os_arch
main "$@"
