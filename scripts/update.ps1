<#
.SYNOPSIS
  Momo Backend 一键更新脚本（Windows PowerShell）

.DESCRIPTION
  只更新到已经发布的 Release 版本，不支持分支。
  自动识别 nodejs / worker / go / docker 部署方式。
  在部署根目录运行：powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1

.PARAMETER Type
  强制指定部署方式：nodejs / worker / go / docker

.PARAMETER Version
  更新到指定 Release，例如 1.8.4 或 v1.8.4

.PARAMETER From
  当前版本探测失败时手动指定

.PARAMETER Repo
  覆盖仓库地址（默认读取 git origin）

.PARAMETER Yes
  跳过确认

.PARAMETER DryRun
  只展示计划，不改文件、不下载、不构建

.PARAMETER China
  强制优先使用国内镜像

.PARAMETER NoMirror
  禁用镜像，全部直连 GitHub

.PARAMETER NoBackup
  不创建备份

.PARAMETER Keep
  保留最近几次备份，默认 5

.PARAMETER Force
  允许覆盖本地 git 修改 / 强制重装当前版本

.PARAMETER Rollback
  回滚到最近一次备份

.PARAMETER Help
  显示帮助
#>

[CmdletBinding()]
param(
  [ValidateSet('', 'nodejs', 'worker', 'go', 'docker')]
  [string]$Type = '',
  [string]$Version,
  [string]$From,
  [string]$Repo,
  [string]$Branch,
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$China,
  [switch]$NoMirror,
  [switch]$NoBackup,
  [int]$Keep = 5,
  [switch]$Force,
  [switch]$Rollback,
  [switch]$Help
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

$ScriptVersion = '1.0.0'
$DefaultRepo = 'https://github.com/Motues/Momo-Backend.git'
$DefaultMirrorPrefix = 'https://ghfast.top/'
$DefaultNpmRegistry = 'https://registry.npmmirror.com'
$DefaultGhcrMirror = 'ghcr.nju.edu.cn'
$DefaultDockerhubMirror = 'docker.m.daocloud.io'

$ScriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptDir)) {
  $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
# 脚本可以放在项目根的 scripts/ 目录，也可以直接放在项目根。
if ((Split-Path -Leaf $ScriptDir) -eq 'scripts') {
  $Root = Split-Path -Parent $ScriptDir
} else {
  $Root = $ScriptDir
}
$Root = (Resolve-Path -LiteralPath $Root).Path

$StateDir = Join-Path $Root '.momo-update'
$BackupRoot = Join-Path $StateDir 'backups'
$LogDir = Join-Path $StateDir 'logs'
$StateFile = Join-Path $StateDir 'state.txt'
$CacheDir = Join-Path $StateDir 'cache'
$CacheRepo = Join-Path $CacheDir 'repo.git'

$script:LogFile = $null
$script:TranscriptStarted = $false
$script:TmpDir = $null
$script:BackupDir = $null
$script:Manifest = $null
$script:Type = $Type
$script:TargetVersion = ''
$script:TargetTag = ''
$script:TargetRef = ''
$script:CurrentVersion = ''
$script:CurrentRef = ''
$script:CurrentRefFull = ''
$script:GitRoot = $false
$script:GitUrl = ''
$script:RepoCanonical = ''
$script:IsGitHub = $false
$script:Owner = ''
$script:Name = ''
$script:ReleaseBase = ''
$script:UseMirror = $false
$script:MirrorPrefix = $DefaultMirrorPrefix
$script:NpmRegistry = ''
$script:GhcrMirror = $DefaultGhcrMirror
$script:DockerhubMirror = $DefaultDockerhubMirror
$script:PublicSrc = $null
$script:ComposeCmd = @()
$script:ComposeFile = $null
$script:SchemaChanged = $false

$script:Changes = @()
$script:Ts = Get-Date -Format 'yyyyMMdd-HHmmss'

# ---------- 输出 ----------

function Write-AppendLog([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($script:LogFile)) { return }
  try {
    [System.IO.File]::AppendAllText($script:LogFile, $Text + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

function Write-Say([string]$Text) {
  Write-Host $Text
  Write-AppendLog $Text
}

function Write-Info([string]$Text) {
  Write-Host "[信息] $Text" -ForegroundColor Cyan
  Write-AppendLog "[信息] $Text"
}

function Write-Ok([string]$Text) {
  Write-Host "[完成] $Text" -ForegroundColor Green
  Write-AppendLog "[完成] $Text"
}

function Write-Warn([string]$Text) {
  Write-Host "[警告] $Text" -ForegroundColor Yellow
  Write-AppendLog "[警告] $Text"
}

function Stop-WithError([string]$Text) {
  Write-Host "[错误] $Text" -ForegroundColor Red
  Write-AppendLog "[错误] $Text"
  if ($script:TranscriptStarted) {
    try { Stop-Transcript | Out-Null } catch { }
    $script:TranscriptStarted = $false
  }
  exit 1
}

function Test-CommandExists([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Show-Usage {
  Write-Host @'
Momo Backend 一键更新脚本（只更新已发布的 Release 版本）

用法:
  powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1 [选项]

选项:
  -Type <nodejs|worker|go|docker>  强制指定部署方式（默认自动探测）
  -Version <版本>                   更新到指定 Release，例如 1.8.4 / v1.8.4
  -From <版本>                      当前版本探测失败时手动指定
  -Repo <url>                       覆盖仓库地址（默认读取 git origin）
  -Yes                              跳过确认
  -DryRun                           只展示计划，不改文件、不下载、不构建
  -China                            强制优先使用国内镜像
  -NoMirror                         禁用镜像，全部直连 GitHub
  -NoBackup                         不创建备份（不推荐）
  -Keep <数量>                      保留最近几次备份，默认 5
  -Force                            允许覆盖本地 git 修改 / 强制重装当前版本
  -Rollback                         回滚到最近一次备份
  -Help                             显示本帮助

说明:
  * 只支持已发布版本；不支持分支更新。
  * Node.js / Worker 使用 git diff 只覆盖版本之间变化的源码文件；
    管理面板 public 始终从对应 Release 包中提取。
  * Go 使用 Release 预编译二进制；Docker 拉取 Release 镜像。
  * 更新完成后不会自动重启服务，只打印重启命令。
  * 数据库迁移不会自动执行；Node.js 跨版本时会打印 pnpm db:push 提示。

环境变量:
  MOMO_DOWNLOAD_MIRROR   下载镜像前缀，默认 https://ghfast.top/
  MOMO_RELEASE_BASE      覆盖 Release 下载根地址（自建镜像/制品库）
  MOMO_NPM_REGISTRY      npm/pnpm 镜像，默认 https://registry.npmmirror.com
  MOMO_GHCR_MIRROR       GHCR 镜像主机，默认 ghcr.nju.edu.cn
  MOMO_DOCKERHUB_MIRROR  Docker Hub 镜像主机，默认 docker.m.daocloud.io
'@
}

if ($Help) {
  Show-Usage
  exit 0
}

if (-not [string]::IsNullOrWhiteSpace($Branch)) {
  Write-Host '只允许更新到已经发布的 Release 版本，不支持分支更新' -ForegroundColor Red
  exit 1
}

if ($Keep -lt 1) {
  Write-Host '-Keep 必须大于 0' -ForegroundColor Red
  exit 1
}
if ($null -eq $Type -or $Type -eq '') { $script:Type = '' }

# ---------- 基础工具 ----------

function Initialize-Directories {
  if ($DryRun) { return }
  New-Item -ItemType Directory -Force -Path $StateDir, $BackupRoot, $LogDir | Out-Null
  $script:LogFile = Join-Path $LogDir ("update-$($script:Ts).log")
  try {
    Start-Transcript -Path $script:LogFile -Force | Out-Null
    $script:TranscriptStarted = $true
  } catch {
    $script:LogFile = $null
  }
}

function New-TempDirectory {
  $script:TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("momo-update." + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $script:TmpDir | Out-Null
}

function Remove-TempDirectory {
  if ($script:TmpDir -and (Test-Path -LiteralPath $script:TmpDir)) {
    Remove-Item -LiteralPath $script:TmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Assert-BasicTools {
  if (-not (Test-CommandExists 'git')) { Stop-WithError '缺少 git，请先安装' }
  if (-not (Test-CommandExists 'tar') -and -not (Test-CommandExists 'Expand-Archive')) {
    Stop-WithError '缺少 tar / Expand-Archive，无法解压'
  }
  $env:GIT_TERMINAL_PROMPT = '0'
}

# ---------- 路径 / 仓库 ----------

function ConvertTo-RelativePath([string]$FullPath) {
  $rel = $FullPath
  if ($rel.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
    $rel = $rel.Substring($Root.Length)
  }
  $rel = $rel -replace '^[\\/]+', ''
  return ($rel -replace '\\', '/')
}

function Join-RootPath([string]$RelativePath) {
  return (Join-Path $Root ($RelativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar))
}

function ConvertTo-HttpsRepo([string]$Url) {
  $u = $Url.Trim()
  $u = $u.TrimEnd('/')
  $u = $u -replace '^git@github\.com:', 'https://github.com/'
  $u = $u -replace '^ssh://git@github\.com/', 'https://github.com/'
  $u = $u -replace '^https://ghfast\.top/', ''
  $u = $u -replace '^https://ghproxy\.net/', ''
  $u = $u -replace '^https://github\.moeyy\.xyz/', ''
  $u = $u.TrimEnd('/')
  if ($u -match '^https://github\.com/' -and $u -notmatch '\.git$') {
    $u = "$u.git"
  }
  return $u
}

function Resolve-Repository {
  $repoInput = ''
  if (-not [string]::IsNullOrWhiteSpace($Repo)) {
    $repoInput = $Repo
  } elseif (Test-Path -LiteralPath (Join-Path $Root '.git')) {
    Push-Location $Root
    try {
      $repoInput = (& git remote get-url origin 2>$null)
      if ($LASTEXITCODE -ne 0) { $repoInput = '' }
    } catch { $repoInput = '' }
    Pop-Location
  } else {
    $repoInput = Get-StateValue 'repo'
  }
  if ([string]::IsNullOrWhiteSpace($repoInput)) { $repoInput = $DefaultRepo }

  $script:RepoCanonical = ConvertTo-HttpsRepo $repoInput
  if ($script:RepoCanonical -match '^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?$') {
    $script:IsGitHub = $true
    $script:Owner = $Matches[1]
    $script:Name = $Matches[2]
    $script:ReleaseBase = "https://github.com/$($script:Owner)/$($script:Name)/releases/download"
  } else {
    $script:IsGitHub = $false
    $script:ReleaseBase = ''
  }

  if ($env:MOMO_RELEASE_BASE) {
    $script:ReleaseBase = $env:MOMO_RELEASE_BASE.TrimEnd('/')
  }

  $gitDir = Join-Path $Root '.git'
  if (Test-Path -LiteralPath $gitDir) {
    Push-Location $Root
    try {
      $top = (& git rev-parse --show-toplevel 2>$null)
      if ($LASTEXITCODE -eq 0 -and $top) {
        $topPath = (Resolve-Path -LiteralPath $top).Path
        if ($topPath -eq $Root) { $script:GitRoot = $true }
      }
    } catch { }
    Pop-Location
  }
}

# ---------- 网络 / 镜像 ----------

function Test-GitRemote([string]$Url) {
  Push-Location $Root
  try {
    & git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 ls-remote --heads $Url main 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  } finally {
    Pop-Location
  }
}

function Resolve-Mirror {
  $script:MirrorPrefix = if ($env:MOMO_DOWNLOAD_MIRROR) { $env:MOMO_DOWNLOAD_MIRROR } else { $DefaultMirrorPrefix }
  if (-not $script:MirrorPrefix.EndsWith('/')) { $script:MirrorPrefix += '/' }

  $direct = $script:RepoCanonical
  $mirror = "$($script:MirrorPrefix)$direct"
  $gitclone = ''
  if ($script:IsGitHub) {
    $gitclone = "https://gitclone.com/github.com/$($script:Owner)/$($script:Name).git"
  }

  if ($NoMirror) {
    Write-Info "已禁用镜像，使用直连: $direct"
    if (-not (Test-GitRemote $direct)) { Stop-WithError "无法连接 GitHub（已指定 -NoMirror）: $direct" }
    $script:GitUrl = $direct
    $script:UseMirror = $false
    if ($env:MOMO_NPM_REGISTRY) { $script:NpmRegistry = $env:MOMO_NPM_REGISTRY }
    return
  }

  $candidates = New-Object System.Collections.ArrayList
  if ($China) {
    [void]$candidates.Add($mirror)
    if ($gitclone) { [void]$candidates.Add($gitclone) }
    [void]$candidates.Add($direct)
  } else {
    [void]$candidates.Add($direct)
    [void]$candidates.Add($mirror)
    if ($gitclone) { [void]$candidates.Add($gitclone) }
  }

  $chosen = ''
  foreach ($url in $candidates) {
    if ([string]::IsNullOrWhiteSpace($url)) { continue }
    Write-Info "检测连接: $url"
    if (Test-GitRemote $url) {
      $chosen = $url
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($chosen)) {
    Stop-WithError '无法连接 GitHub 或国内镜像，请检查网络；可尝试 -China 或 MOMO_DOWNLOAD_MIRROR'
  }

  $script:GitUrl = $chosen
  if ($chosen -ne $direct) {
    $script:UseMirror = $true
    if ($China) {
      Write-Info "已按 -China 使用国内镜像: $($script:MirrorPrefix)"
    } else {
      Write-Info "GitHub 直连不可用，已启用国内镜像: $($script:MirrorPrefix)"
    }
  } elseif ($China) {
    $script:UseMirror = $true
    Write-Info '已按 -China 启用国内依赖镜像'
  } else {
    $script:UseMirror = $false
    Write-Info 'GitHub 直连正常，使用直连'
  }

  if ($script:UseMirror) {
    $script:NpmRegistry = if ($env:MOMO_NPM_REGISTRY) { $env:MOMO_NPM_REGISTRY } else { $DefaultNpmRegistry }
    $script:GhcrMirror = if ($env:MOMO_GHCR_MIRROR) { $env:MOMO_GHCR_MIRROR } else { $DefaultGhcrMirror }
    $script:DockerhubMirror = if ($env:MOMO_DOCKERHUB_MIRROR) { $env:MOMO_DOCKERHUB_MIRROR } else { $DefaultDockerhubMirror }
  } elseif ($env:MOMO_NPM_REGISTRY) {
    $script:NpmRegistry = $env:MOMO_NPM_REGISTRY
  }
}

function Enable-MirrorEnvironment {
  if ($script:UseMirror) { return }
  $script:UseMirror = $true
  if (-not $script:NpmRegistry) {
    $script:NpmRegistry = if ($env:MOMO_NPM_REGISTRY) { $env:MOMO_NPM_REGISTRY } else { $DefaultNpmRegistry }
  }
  if (-not $script:GhcrMirror) {
    $script:GhcrMirror = if ($env:MOMO_GHCR_MIRROR) { $env:MOMO_GHCR_MIRROR } else { $DefaultGhcrMirror }
  }
  if (-not $script:DockerhubMirror) {
    $script:DockerhubMirror = if ($env:MOMO_DOCKERHUB_MIRROR) { $env:MOMO_DOCKERHUB_MIRROR } else { $DefaultDockerhubMirror }
  }
}

function Get-MirrorGitUrl {
  if (-not $script:IsGitHub -or $NoMirror) { return '' }
  return "$($script:MirrorPrefix)$($script:RepoCanonical)"
}

# ---------- git ----------

function Invoke-Git {
  param(
    [string[]]$Arguments,
    [string]$WorkDir = $Root,
    [switch]$AllowFail
  )
  Push-Location $WorkDir
  try {
    $output = & git @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0 -and -not $AllowFail) {
    $detail = ($output | Out-String).Trim()
    Stop-WithError "git $($Arguments -join ' ') 失败: $detail"
  }
  return $output
}

function Invoke-Native {
  param(
    [string]$File,
    [string[]]$Arguments,
    [string]$WorkDir = $Root,
    [switch]$AllowFail
  )
  Push-Location $WorkDir
  try {
    & $File @Arguments
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0 -and -not $AllowFail) {
    Stop-WithError "$File $($Arguments -join ' ') 执行失败（退出码 $code）"
  }
  return $code
}

function Initialize-BareCache {
  $mirror = Get-MirrorGitUrl
  $candidates = @($script:GitUrl)
  if ($mirror -and $mirror -ne $script:GitUrl) { $candidates += $mirror }
  if ($script:RepoCanonical -and $script:RepoCanonical -ne $script:GitUrl -and $script:RepoCanonical -ne $mirror) {
    $candidates += $script:RepoCanonical
  }
  foreach ($url in $candidates) {
    if ([string]::IsNullOrWhiteSpace($url)) { continue }
    if (Test-Path -LiteralPath $CacheRepo) {
      Remove-Item -LiteralPath $CacheRepo -Recurse -Force -ErrorAction SilentlyContinue
    }
    Push-Location $Root
    try {
      & git clone --bare $url $CacheRepo 2>&1 | Out-Null
      $code = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($code -eq 0) {
      if ($url -ne $script:GitUrl) {
        $script:GitUrl = $url
        Enable-MirrorEnvironment
      }
      return $true
    }
    Write-Warn "克隆失败，尝试下一个地址: $url"
  }
  return $false
}

function Ensure-Cache {
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  $valid = $false
  if (Test-Path -LiteralPath $CacheRepo) {
    Push-Location $Root
    try {
      & git "--git-dir=$CacheRepo" rev-parse --git-dir 2>$null | Out-Null
      $valid = ($LASTEXITCODE -eq 0)
    } catch { $valid = $false }
    Pop-Location
  }
  if (-not $valid) {
    if (Test-Path -LiteralPath $CacheRepo) {
      Write-Warn "更新缓存已损坏，正在重建: $CacheRepo"
      Remove-Item -LiteralPath $CacheRepo -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    Write-Info '首次使用，正在建立仓库缓存（完整裸仓库）...'
    if (-not (Initialize-BareCache)) { Stop-WithError "无法克隆仓库: $($script:RepoCanonical)" }
  } elseif (Test-Path -LiteralPath $CacheRepo) {
    Push-Location $Root
    try {
      $partial = (& git "--git-dir=$CacheRepo" config --get extensions.partialClone 2>$null)
    } finally {
      Pop-Location
    }
    if ($partial) {
      Write-Warn '旧缓存是部分克隆，可能导致 git archive 失败；正在重建为完整缓存'
      if (-not (Initialize-BareCache)) { Stop-WithError "无法克隆仓库: $($script:RepoCanonical)" }
    }
  }

  Push-Location $Root
  try {
    & git "--git-dir=$CacheRepo" remote get-url origin 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      & git "--git-dir=$CacheRepo" remote set-url origin $script:GitUrl 2>&1 | Out-Null
    } else {
      & git "--git-dir=$CacheRepo" remote add origin $script:GitUrl 2>&1 | Out-Null
    }
    & git "--git-dir=$CacheRepo" fetch --tags --force origin '+refs/tags/v*:refs/tags/v*' 2>&1 | Out-Null
    $fetchCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($fetchCode -ne 0) {
    $mirror = Get-MirrorGitUrl
    if ($mirror -and $mirror -ne $script:GitUrl) {
      Write-Warn "缓存拉取失败，切换镜像重试: $mirror"
      Push-Location $Root
      try {
        & git "--git-dir=$CacheRepo" remote set-url origin $mirror
        & git "--git-dir=$CacheRepo" fetch --tags --force origin '+refs/tags/v*:refs/tags/v*' 2>&1 | Out-Null
        $fetchCode = $LASTEXITCODE
      } finally {
        Pop-Location
      }
      if ($fetchCode -ne 0) { Stop-WithError "无法从 $mirror 拉取 Release 标签" }
      $script:GitUrl = $mirror
      Enable-MirrorEnvironment
    } else {
      Stop-WithError "无法从 $($script:GitUrl) 拉取 Release 标签"
    }
  }
}

function Ensure-Tags {
  if ($script:GitRoot) {
    Write-Info '拉取 Release 标签...'
    Push-Location $Root
    try {
      & git -C $Root fetch --tags --force $script:GitUrl '+refs/tags/v*:refs/tags/v*' 2>&1 | Out-Null
      $code = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($code -ne 0) {
      $mirror = Get-MirrorGitUrl
      if ($mirror -and $mirror -ne $script:GitUrl) {
        Write-Warn "标签拉取失败，切换镜像重试: $mirror"
        Push-Location $Root
        try {
          & git -C $Root fetch --tags --force $mirror '+refs/tags/v*:refs/tags/v*' 2>&1 | Out-Null
          $code = $LASTEXITCODE
        } finally {
          Pop-Location
        }
        if ($code -ne 0) { Stop-WithError '无法拉取 Release 标签' }
        $script:GitUrl = $mirror
        Enable-MirrorEnvironment
      } else {
        Stop-WithError "无法从 $($script:GitUrl) 拉取 Release 标签"
      }
    }
  } else {
    Ensure-Cache
  }
}

function Get-Tags {
  if ($script:GitRoot) {
    return @(Invoke-Git @('-C', $Root, 'tag', '--list', 'v*'))
  }
  return @(Invoke-Git @("--git-dir=$CacheRepo", 'tag', '--list', 'v*'))
}

function Test-Tag([string]$Tag) {
  Push-Location $Root
  try {
    if ($script:GitRoot) {
      & git -C $Root rev-parse -q --verify "refs/tags/$Tag" 2>$null | Out-Null
    } else {
      & git "--git-dir=$CacheRepo" rev-parse -q --verify "refs/tags/$Tag" 2>$null | Out-Null
    }
    return ($LASTEXITCODE -eq 0)
  } finally {
    Pop-Location
  }
}

function Normalize-Version([string]$Value) {
  return ($Value -replace '^v', '').Trim()
}

function Resolve-Target {
  if (-not [string]::IsNullOrWhiteSpace($Version)) {
    $script:TargetVersion = Normalize-Version $Version
    $script:TargetTag = "v$($script:TargetVersion)"
    if (-not (Test-Tag $script:TargetTag)) {
      Stop-WithError "Release $($script:TargetTag) 不存在（只支持已发布版本）"
    }
  } else {
    $stable = @(Get-Tags | Where-Object { $_ -match '^v\d+\.\d+\.\d+$' })
    if ($stable.Count -eq 0) { Stop-WithError '没有找到已发布的 Release 标签' }
    $latest = $stable | Sort-Object { [version]($_.Substring(1)) } -Descending | Select-Object -First 1
    $script:TargetTag = $latest
    $script:TargetVersion = $latest.Substring(1)
  }
  $script:TargetRef = $script:TargetTag
}

function Get-StateValue([string]$Key) {
  if (-not (Test-Path -LiteralPath $StateFile)) { return '' }
  foreach ($line in (Get-Content -LiteralPath $StateFile -ErrorAction SilentlyContinue)) {
    $parts = $line -split "`t", 2
    if ($parts.Count -eq 2 -and $parts[0] -eq $Key) { return $parts[1] }
  }
  return ''
}

function Write-State {
  param(
    [string]$StateType = $script:Type,
    [string]$StateVersion = $script:TargetVersion,
    [string]$StateRef = $script:TargetRef
  )
  if ($DryRun) { return }
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  $lines = @(
    "type`t$StateType",
    "version`t$StateVersion",
    "ref`t$StateRef",
    "repo`t$($script:RepoCanonical)",
    ("updated`t" + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
  )
  [System.IO.File]::WriteAllText($StateFile, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
}

function Get-PackageVersion([string]$File) {
  if (-not (Test-Path -LiteralPath $File)) { return '' }
  try {
    $json = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
    return [string]$json.version
  } catch { return '' }
}

function Get-BinaryVersion([string]$Binary) {
  if (-not (Test-Path -LiteralPath $Binary)) { return '' }
  try {
    $output = & $Binary --version 2>&1
    $text = ($output | Out-String)
    if ($text -match 'version\s+([0-9][0-9A-Za-z._-]*)') { return $Matches[1] }
  } catch { }
  return ''
}

function Get-GoBinary {
  $candidates = @()
  $candidates += Get-ChildItem -LiteralPath $Root -File -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like 'momo-backend-*' -or $_.Name -eq 'momo-backend' -or $_.Name -eq 'momo-backend.exe'
  }
  foreach ($file in $candidates) {
    if ($file.Name -match '\.(new|old)(-|$)') { continue }
    if (Get-BinaryVersion $file.FullName) { return $file.FullName }
  }
  return ''
}

function Get-CurrentVersion {
  if (-not [string]::IsNullOrWhiteSpace($From)) {
    $script:CurrentVersion = Normalize-Version $From
    if ($script:GitRoot -and ($script:Type -eq 'nodejs' -or $script:Type -eq 'worker')) {
      $script:CurrentRefFull = (Invoke-Git @('-C', $Root, 'rev-parse', 'HEAD') | Select-Object -First 1)
      $script:CurrentRef = $script:CurrentRefFull
    } else {
      $script:CurrentRef = "v$($script:CurrentVersion)"
      if (-not (Test-Tag $script:CurrentRef)) { Stop-WithError "标签 $($script:CurrentRef) 不存在" }
    }
    return
  }

  if ($script:Type -eq 'docker') {
    $script:CurrentVersion = Get-DockerVersion
    if ([string]::IsNullOrWhiteSpace($script:CurrentVersion)) {
      Stop-WithError '无法识别当前 Docker 版本，请用 -From <版本> 指定'
    }
  } elseif ($script:Type -eq 'go') {
    $bin = Get-GoBinary
    if (-not $bin) { Stop-WithError '未找到 Go 二进制（momo-backend-*）' }
    $script:CurrentVersion = Get-BinaryVersion $bin
    if ([string]::IsNullOrWhiteSpace($script:CurrentVersion)) {
      Stop-WithError '无法识别当前 Go 版本，请用 -From <版本> 指定'
    }
  } elseif ($script:GitRoot) {
    $exact = ''
    try {
      Push-Location $Root
      $exact = (& git describe --tags --exact-match 2>$null)
      Pop-Location
    } catch { }
    if ($exact) {
      $script:CurrentVersion = Normalize-Version $exact
    } else {
      $pkg = ''
      if ($script:Type -eq 'nodejs') { $pkg = Get-PackageVersion (Join-Path $Root 'nodejs\package.json') }
      if ($script:Type -eq 'worker') { $pkg = Get-PackageVersion (Join-Path $Root 'worker\package.json') }
      if ($pkg) { $script:CurrentVersion = $pkg } else { $script:CurrentVersion = Get-StateValue 'version' }
    }
    if ([string]::IsNullOrWhiteSpace($script:CurrentVersion)) { $script:CurrentVersion = 'unknown' }
  } else {
    if ($script:Type -eq 'nodejs') {
      $script:CurrentVersion = Get-PackageVersion (Join-Path $Root 'nodejs\package.json')
    } elseif ($script:Type -eq 'worker') {
      $script:CurrentVersion = Get-PackageVersion (Join-Path $Root 'worker\package.json')
    }
    if ([string]::IsNullOrWhiteSpace($script:CurrentVersion)) {
      $script:CurrentVersion = Get-StateValue 'version'
    }
    if ([string]::IsNullOrWhiteSpace($script:CurrentVersion)) {
      Stop-WithError '无法识别当前版本，请用 -From <版本> 指定（例如 -From 1.8.3）'
    }
  }

  if ($script:GitRoot -and ($script:Type -eq 'nodejs' -or $script:Type -eq 'worker')) {
    $script:CurrentRefFull = (Invoke-Git @('-C', $Root, 'rev-parse', 'HEAD') | Select-Object -First 1)
    $script:CurrentRef = $script:CurrentRefFull
    return
  }

  $stateRef = Get-StateValue 'ref'
  $stateVer = Get-StateValue 'version'
  if ($stateRef -and $stateVer -eq $script:CurrentVersion) {
    $script:CurrentRef = $stateRef
  } else {
    $script:CurrentRef = "v$($script:CurrentVersion)"
  }
  if (-not (Test-Tag $script:CurrentRef)) {
    Stop-WithError "当前版本 $($script:CurrentVersion) 对应的标签 $($script:CurrentRef) 不存在，请用 -From 指定已发布版本"
  }
}

# ---------- Docker ----------

function Test-DockerAvailable {
  if (-not (Test-CommandExists 'docker')) { return $false }
  Push-Location $Root
  try {
    & docker info 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  } finally {
    Pop-Location
  }
}

function Get-ComposeFile {
  foreach ($name in @('docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml')) {
    $path = Join-Path $Root $name
    if (Test-Path -LiteralPath $path) { return $path }
  }
  return $null
}

function Resolve-ComposeCommand {
  Push-Location $Root
  try {
    & docker compose version 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $script:ComposeCmd = @('docker', 'compose')
      return $true
    }
    if (Test-CommandExists 'docker-compose') {
      & docker-compose version 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $script:ComposeCmd = @('docker-compose')
        return $true
      }
    }
  } catch { }
  finally {
    Pop-Location
  }
  return $false
}

function Get-ComposePrefix {
  if ($script:ComposeCmd.Count -gt 1) {
    return @($script:ComposeCmd[1..($script:ComposeCmd.Count - 1)])
  }
  return @()
}

function Invoke-Compose {
  param(
    [string[]]$Arguments,
    [switch]$AllowFail
  )
  if ($script:ComposeCmd.Count -eq 0) { Stop-WithError '未找到 docker compose / docker-compose' }
  $exe = $script:ComposeCmd[0]
  $pre = @(Get-ComposePrefix)
  return (Invoke-Native $exe ($pre + $Arguments) -AllowFail:$AllowFail)
}

function Initialize-ComposeContext {
  if (-not $script:ComposeFile) { $script:ComposeFile = Get-ComposeFile }
  if ($script:ComposeFile -and $script:ComposeCmd.Count -eq 0) {
    [void](Resolve-ComposeCommand)
  }
}

function Get-DockerContainer {
  if (-not (Test-DockerAvailable)) { return '' }
  Initialize-ComposeContext
  Push-Location $Root
  try {
    $name = (& docker ps -a --filter 'name=^/momo-backend$' --format '{{.Names}}' 2>$null | Select-Object -First 1)
  } finally {
    Pop-Location
  }
  if ($name) { return $name }
  if ($script:ComposeCmd.Count -eq 0) { [void](Resolve-ComposeCommand) }
  if ($script:ComposeCmd.Count -gt 0 -and $script:ComposeFile) {
    Push-Location $Root
    try {
      $cid = (& $script:ComposeCmd[0] @(Get-ComposePrefix) -f $script:ComposeFile ps -q 2>$null | Select-Object -First 1)
      if ($cid) {
        $cname = (& docker inspect -f '{{.Name}}' $cid 2>$null)
        if ($cname) { return $cname.TrimStart('/') }
      }
    } catch { }
    finally { Pop-Location }
  }
  return ''
}

function Get-DockerImage {
  param([string]$Container)
  if ($Container) {
    Push-Location $Root
    try {
      $img = (& docker inspect -f '{{.Config.Image}}' $Container 2>$null)
      if ($img) { return $img }
    } finally { Pop-Location }
  }
  if ($script:ComposeFile) {
    $raw = Get-Content -LiteralPath $script:ComposeFile -Raw
    $m = [regex]::Match($raw, '(?m)^\s*image:\s*([^\s#]+)')
    if ($m.Success) { return $m.Groups[1].Value.Trim('"', "'") }
  }
  return ''
}

function Split-ImageRef([string]$Image) {
  if ($Image -match '@sha256:') {
    Stop-WithError "compose 使用 digest 固定镜像（$Image），无法自动切换版本；请把 image 改成 tag 形式"
  }
  if ($Image -match '^(.*):([^/:]+)$') {
    return [pscustomobject]@{ Repo = $Matches[1]; Tag = $Matches[2] }
  }
  return [pscustomobject]@{ Repo = $Image; Tag = 'latest' }
}

function Get-DockerVersion {
  if (-not (Test-DockerAvailable)) { return '' }
  Initialize-ComposeContext
  $container = Get-DockerContainer
  $image = Get-DockerImage $container
  if ($image) {
    Push-Location $Root
    try {
      $label = (& docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' $image 2>$null)
    } finally { Pop-Location }
    if ($label -and $label -ne '<no value>') { return (Normalize-Version $label) }
    $parsed = Split-ImageRef $image
    if ($parsed.Tag -match '^v?\d') { return (Normalize-Version $parsed.Tag) }
  }
  if ($container) {
    Push-Location $Root
    try {
      $out = (& docker exec $container ./momo-backend --version 2>$null | Out-String)
      if ($out -match 'version\s+([0-9][0-9A-Za-z._-]*)') { return $Matches[1] }
    } catch { }
    finally { Pop-Location }
  }
  return (Get-StateValue 'version')
}

# ---------- 部署方式探测 ----------

$script:DetectCandidates = @()

function Add-Candidate([string]$CandidateType, [int]$Score, [string]$Reason) {
  $script:DetectCandidates += [pscustomobject]@{ Type = $CandidateType; Score = $Score; Reason = $Reason }
}

function Resolve-DeploymentType {
  if (-not [string]::IsNullOrWhiteSpace($script:Type)) {
    Write-Info "使用指定部署方式: $($script:Type)"
    return
  }

  $stateType = Get-StateValue 'type'
  $script:DetectCandidates = @()

  if (Test-DockerAvailable) {
    Initialize-ComposeContext
    $container = Get-DockerContainer
    $composeRunning = $false
    if ($script:ComposeFile -and $script:ComposeCmd.Count -gt 0) {
      Push-Location $Root
      try {
        $q = (& $script:ComposeCmd[0] @(Get-ComposePrefix) -f $script:ComposeFile ps -q 2>$null | Select-Object -First 1)
        if ($q) { $composeRunning = $true }
      } catch { }
      finally { Pop-Location }
    }
    if ($container -or $composeRunning) {
      Add-Candidate 'docker' 100 '检测到运行中的 Docker 容器 / compose 项目'
    } elseif ($script:ComposeFile -and (Test-Path -LiteralPath (Join-Path $Root 'data'))) {
      Add-Candidate 'docker' 60 '发现 docker-compose.yml 与 data/（容器可能已停止）'
    }
  }
  if ($stateType -eq 'docker') { Add-Candidate 'docker' 20 '上次更新记录为 docker' }

  $goScore = 0
  $goReason = @()
  $goBin = Get-GoBinary
  if ($goBin) { $goScore += 60; $goReason += "发现 Go 二进制 $(Split-Path -Leaf $goBin)" }
  if (Test-Path -LiteralPath (Join-Path $Root 'momo.bash')) { $goScore += 20; $goReason += '发现 momo.bash' }
  if (Test-Path -LiteralPath (Join-Path $Root 'go\config\config.yaml')) { $goScore += 10; $goReason += '发现 go/config' }
  $goData = Get-ChildItem -LiteralPath (Join-Path $Root 'go\data') -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.db', '.sqlite' }
  if ($goData) { $goScore += 30; $goReason += '发现 go/data 数据库' }
  if ($stateType -eq 'go') { $goScore += 80; $goReason += '上次更新记录为 go' }
  if ($goScore -gt 0) { Add-Candidate 'go' $goScore ($goReason -join '; ') }

  $nodePkg = Join-Path $Root 'nodejs\package.json'
  $nodeScore = 0
  $nodeReason = @()
  $nodeVersion = Get-PackageVersion $nodePkg
  $nodeName = ''
  if (Test-Path -LiteralPath $nodePkg) {
    try { $nodeName = [string](Get-Content -LiteralPath $nodePkg -Raw | ConvertFrom-Json).name } catch { }
  }
  if ($nodeName -eq 'momo-backend-nodejs') {
    $nodeScore += 20; $nodeReason += '发现 nodejs/package.json'
    if (Test-Path -LiteralPath (Join-Path $Root 'nodejs\.env')) { $nodeScore += 20; $nodeReason += '.env' }
    $nodeData = Get-ChildItem -LiteralPath (Join-Path $Root 'nodejs\data') -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.db', '.sqlite' }
    if ($nodeData) { $nodeScore += 40; $nodeReason += 'data 数据库' }
    if (Test-Path -LiteralPath (Join-Path $Root 'nodejs\dist')) { $nodeScore += 15; $nodeReason += 'dist' }
    if (Test-Path -LiteralPath (Join-Path $Root 'nodejs\node_modules')) { $nodeScore += 10; $nodeReason += 'node_modules' }
    if (Test-Path -LiteralPath (Join-Path $Root 'nodejs\public')) { $nodeScore += 5; $nodeReason += 'public' }
  }
  if ($stateType -eq 'nodejs') { $nodeScore += 80; $nodeReason += '上次更新记录为 nodejs' }
  if ($nodeScore -gt 0) { Add-Candidate 'nodejs' $nodeScore ($nodeReason -join '; ') }

  $workerPkg = Join-Path $Root 'worker\package.json'
  $workerScore = 0
  $workerReason = @()
  $workerName = ''
  if (Test-Path -LiteralPath $workerPkg) {
    try { $workerName = [string](Get-Content -LiteralPath $workerPkg -Raw | ConvertFrom-Json).name } catch { }
  }
  if ($workerName -eq 'momo-backend-worker') {
    $workerScore += 15; $workerReason += '发现 worker/package.json'
    if (Test-Path -LiteralPath (Join-Path $Root 'worker\wrangler.jsonc')) { $workerScore += 25; $workerReason += 'wrangler.jsonc' }
    if (Test-Path -LiteralPath (Join-Path $Root 'worker\wrangler.example.jsonc')) { $workerScore += 5; $workerReason += 'wrangler.example.jsonc' }
    if (Test-Path -LiteralPath (Join-Path $Root 'worker\.dev.vars')) { $workerScore += 40; $workerReason += '.dev.vars' }
    if (Test-Path -LiteralPath (Join-Path $Root 'worker\.wrangler')) { $workerScore += 15; $workerReason += '.wrangler' }
    if (Test-Path -LiteralPath (Join-Path $Root 'worker\node_modules')) { $workerScore += 10; $workerReason += 'node_modules' }
    if (Test-Path -LiteralPath (Join-Path $Root 'worker\public')) { $workerScore += 5; $workerReason += 'public' }
  }
  if ($stateType -eq 'worker') { $workerScore += 80; $workerReason += '上次更新记录为 worker' }
  if ($workerScore -gt 0) { Add-Candidate 'worker' $workerScore ($workerReason -join '; ') }

  $n = $script:DetectCandidates.Count
  if ($n -eq 0) {
    Stop-WithError '没有识别到部署方式；请用 -Type nodejs|worker|go|docker 指定'
  }
  if ($n -eq 1) {
    $script:Type = $script:DetectCandidates[0].Type
    Write-Info "自动识别部署方式: $($script:Type)（$($script:DetectCandidates[0].Reason)）"
    return
  }

  $sorted = @($script:DetectCandidates | Sort-Object Score -Descending)
  if (($sorted[0].Score - $sorted[1].Score) -ge 40) {
    $script:Type = $sorted[0].Type
    Write-Info "自动识别部署方式: $($script:Type)（$($sorted[0].Reason)）"
    return
  }

  if ($Yes) {
    $list = ($script:DetectCandidates | ForEach-Object { "$($_.Type)($($_.Score))" }) -join ' '
    Stop-WithError "检测到多个可能的部署方式: $list；请用 -Type 指定"
  }

  Write-Host '检测到多个可能的部署方式：' -ForegroundColor Yellow
  for ($i = 0; $i -lt $script:DetectCandidates.Count; $i++) {
    $item = $script:DetectCandidates[$i]
    Write-Host ("  {0}) {1,-8} 分数 {2,-3}  {3}" -f ($i + 1), $item.Type, $item.Score, $item.Reason)
  }
  $choice = Read-Host "请选择 [1-$n]"
  if ($choice -notmatch '^\d+$' -or [int]$choice -lt 1 -or [int]$choice -gt $n) {
    Stop-WithError '无效选择'
  }
  $script:Type = $script:DetectCandidates[[int]$choice - 1].Type
  Write-Info "使用部署方式: $($script:Type)"
}

# ---------- 下载 / 解压 ----------

function Release-AssetUrl([string]$Asset) {
  if ([string]::IsNullOrWhiteSpace($script:ReleaseBase)) {
    Stop-WithError '当前仓库不是 GitHub 仓库，无法下载 Release 资产'
  }
  return "$($script:ReleaseBase)/$($script:TargetTag)/$Asset"
}

function Invoke-Download {
  param([string]$Url, [string]$Destination, [string]$Label)
  $urls = New-Object System.Collections.ArrayList
  if ($script:UseMirror) { [void]$urls.Add("$($script:MirrorPrefix)$Url") }
  [void]$urls.Add($Url)
  if (-not $NoMirror) {
    [void]$urls.Add("$($script:MirrorPrefix)$Url")
    if ($script:MirrorPrefix -ne $DefaultMirrorPrefix) { [void]$urls.Add("$($DefaultMirrorPrefix)$Url") }
    [void]$urls.Add("https://ghproxy.net/$Url")
  }
  $seen = @{}
  foreach ($candidate in $urls) {
    if ([string]::IsNullOrWhiteSpace($candidate) -or $seen.ContainsKey($candidate)) { continue }
    $seen[$candidate] = $true
    Write-Info "下载 ${Label}: $candidate"
    try {
      if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue }
      Invoke-WebRequest -Uri $candidate -OutFile $Destination -UseBasicParsing -TimeoutSec 600 -MaximumRedirection 10
      if ((Test-Path -LiteralPath $Destination) -and ((Get-Item -LiteralPath $Destination).Length -gt 0)) {
        return
      }
    } catch {
      Write-Warn "下载失败: $candidate"
    }
  }
  Stop-WithError "下载失败: $Url"
}

function Expand-ZipFile([string]$Zip, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Expand-Archive -LiteralPath $Zip -DestinationPath $Destination -Force
}

function Get-TarExe {
  $sysTar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path -LiteralPath $sysTar) { return $sysTar }
  return 'tar'
}

function Expand-TarGz([string]$File, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Invoke-Native (Get-TarExe) @('-xzf', $File, '-C', $Destination) | Out-Null
}

function Prepare-PublicAsset {
  $asset = "$($script:Type).zip"
  $url = Release-AssetUrl $asset
  if ($DryRun) {
    Write-Info "将下载并提取管理面板: $url"
    $script:PublicSrc = $null
    return
  }
  $zip = Join-Path $script:TmpDir $asset
  $dest = Join-Path $script:TmpDir "release-$($script:Type)"
  Invoke-Download $url $zip $asset
  Expand-ZipFile $zip $dest
  $candidate = Join-Path $dest "$($script:Type)\public"
  if (-not (Test-Path -LiteralPath $candidate)) { $candidate = Join-Path $dest 'public' }
  if (-not (Test-Path -LiteralPath $candidate)) { Stop-WithError "Release 包中未找到 $($script:Type)/public" }
  $script:PublicSrc = $candidate
  Write-Ok "已获取 $($script:Type) 的 public"
}

# ---------- 备份 ----------

function Compute-BackupDir {
  if ($NoBackup) {
    $script:BackupDir = $null
    return
  }
  $from = $script:CurrentVersion
  if ([string]::IsNullOrWhiteSpace($from)) { $from = 'unknown' }
  $from = $from -replace '[/\\]', '_'
  $script:BackupDir = Join-Path $BackupRoot ("$($script:Ts)-$($script:Type)-$from-to-$($script:TargetVersion)")
}

function Add-ManifestLine([string]$Line) {
  if ([string]::IsNullOrWhiteSpace($script:Manifest)) { return }
  [System.IO.File]::AppendAllText($script:Manifest, $Line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function Initialize-Backup {
  Compute-BackupDir
  if (-not $script:BackupDir) {
    $script:Manifest = $null
    Write-Warn '已按 -NoBackup 跳过备份'
    return
  }
  if ($DryRun) {
    $script:Manifest = $null
    return
  }
  $manifestPath = Join-Path $script:BackupDir 'manifest.txt'
  if (Test-Path -LiteralPath $manifestPath) {
    $script:Manifest = $manifestPath
    return
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $script:BackupDir 'files'), (Join-Path $script:BackupDir 'db'), (Join-Path $script:BackupDir 'archives') | Out-Null
  $script:Manifest = $manifestPath
  [System.IO.File]::WriteAllText($script:Manifest, '', (New-Object System.Text.UTF8Encoding($false)))
  Add-ManifestLine "type`t$($script:Type)"
  Add-ManifestLine "fromVersion`t$($script:CurrentVersion)"
  Add-ManifestLine "toVersion`t$($script:TargetVersion)"
  Add-ManifestLine "fromRef`t$($script:CurrentRef)"
  Add-ManifestLine "toRef`t$($script:TargetRef)"
  Add-ManifestLine "git`t$([int]$script:GitRoot)"
  Add-ManifestLine ("created`t" + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
}

function Backup-File {
  param(
    [string]$Kind,
    [string]$State,
    [string]$RelativePath
  )
  if ($DryRun -or -not $script:BackupDir) { return }
  if ($RelativePath -match '(^|/)\.\.(/|$)' -or $RelativePath -match "`t") {
    Write-Warn "跳过异常路径备份: $RelativePath"
    return
  }
  $src = Join-RootPath $RelativePath
  $dest = Join-Path (Join-Path $script:BackupDir 'files') ($RelativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar)
  if ($State -ne 'added' -and (Test-Path -LiteralPath $src)) {
    $parent = Split-Path -Parent $dest
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    try { Copy-Item -LiteralPath $src -Destination $dest -Force } catch { Write-Warn "备份失败: $RelativePath"; return }
  }
  if ($Kind -eq 'config') {
    Add-ManifestLine "config`t$RelativePath"
  } else {
    Add-ManifestLine "$Kind`t$State`t$RelativePath"
  }
}

function Backup-Config([string]$RelativePath) {
  if (Test-Path -LiteralPath (Join-RootPath $RelativePath)) {
    Backup-File 'config' 'modified' $RelativePath
  }
}

function Backup-Archive {
  param([string]$Kind, [string]$RelativePath)
  if ($DryRun -or -not $script:BackupDir) { return }
  $src = Join-RootPath $RelativePath
  if (-not (Test-Path -LiteralPath $src)) {
    Add-ManifestLine "archive-absent`t$Kind`t$RelativePath"
    return
  }
  $baseName = ($RelativePath -replace '/', '_')
  $zipName = "$baseName.zip"
  $zipDest = Join-Path (Join-Path $script:BackupDir 'archives') $zipName
  try {
    Compress-Archive -Path (Join-Path $src '*') -DestinationPath $zipDest -Force
    Add-ManifestLine "archive`t$Kind`t$RelativePath`t$zipName"
  } catch {
    Write-Warn "目录备份失败: $RelativePath"
  }
}

function Get-DbFiles {
  $result = @()
  foreach ($dir in @((Join-Path $Root 'nodejs\data'), (Join-Path $Root 'go\data'), (Join-Path $Root 'data'))) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $result += Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.db', '.sqlite' }
  }
  return $result
}

function Backup-DbFiles {
  if ($DryRun -or -not $script:BackupDir) { return }
  foreach ($file in (Get-DbFiles)) {
    $rel = ConvertTo-RelativePath $file.FullName
    $dest = Join-Path (Join-Path $script:BackupDir 'db') ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    $ok = $false
    if (Test-CommandExists 'sqlite3') {
      try {
        & sqlite3 $file.FullName ".backup '$dest'" 2>&1 | Out-Null
        $ok = ($LASTEXITCODE -eq 0)
      } catch { $ok = $false }
    }
    if (-not $ok) {
      try {
        Copy-Item -LiteralPath $file.FullName -Destination $dest -Force
        foreach ($suffix in @('-wal', '-shm')) {
          if (Test-Path -LiteralPath ($file.FullName + $suffix)) {
            Copy-Item -LiteralPath ($file.FullName + $suffix) -Destination ($dest + $suffix) -Force
          }
        }
      } catch {
        Write-Warn "数据库备份失败: $rel"
        continue
      }
    }
    Add-ManifestLine "db`t$rel"
  }
}

function Backup-Configs {
  switch ($script:Type) {
    'nodejs' {
      Backup-Config 'nodejs/.env'
      Backup-Config 'nodejs/.env.local'
      Backup-Config 'nodejs/.env.production'
    }
    'worker' {
      Backup-Config 'worker/wrangler.jsonc'
      Backup-Config 'worker/wrangler.e2e.jsonc'
      Backup-Config 'worker/.dev.vars'
      Backup-Config 'worker/.env'
    }
    'go' {
      Backup-Config 'go/config/config.yaml'
      Backup-Config 'config/config.yaml'
    }
    'docker' {
      Backup-Config 'docker-compose.yml'
      Backup-Config 'docker-compose.yaml'
      Backup-Config 'compose.yml'
      Backup-Config 'compose.yaml'
      Backup-Config '.env'
    }
  }
}

# ---------- git diff ----------

function Test-ProtectedPath([string]$Path) {
  if ($Path.StartsWith('.momo-update/')) { return $true }
  if ($Path -match '(^|/)\.env($|\.)') { return $true }
  if ($Path -match '^(nodejs|worker|public)/public/') { return $true }
  if ($Path -match '^(nodejs|go|data)/data/') { return $true }
  if ($Path -match '(^|/)(node_modules|dist|logs|\.wrangler)/') { return $true }
  if ($Path -match '(^|/)\.dev\.vars') { return $true }
  if ($Path -match '(^|/)wrangler\.(jsonc|e2e\.jsonc)$') { return $true }
  if ($Path -match '\.(db|db-wal|db-shm|sqlite)$') { return $true }
  return $false
}

function Get-Changes {
  param([string]$Base, [string]$Target, [string]$Scope)
  $gitArgs = @('-c', 'core.quotePath=false', 'diff', '--name-status', '--no-renames', $Base, $Target)
  if (-not [string]::IsNullOrWhiteSpace($Scope)) { $gitArgs += @('--', $Scope) }
  if ($script:GitRoot) {
    $out = Invoke-Git (@('-C', $Root) + $gitArgs)
  } else {
    $out = Invoke-Git (@("--git-dir=$CacheRepo") + $gitArgs)
  }
  $list = @()
  foreach ($line in $out) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split "`t", 2
    if ($parts.Count -lt 2) { continue }
    $list += [pscustomobject]@{ Status = $parts[0]; Path = $parts[1] }
  }
  return $list
}

function Backup-Changes {
  foreach ($change in $script:Changes) {
    switch -Regex ($change.Status) {
      '^A' { Backup-File 'file' 'added' $change.Path }
      '^D' { Backup-File 'file' 'deleted' $change.Path }
      default { Backup-File 'file' 'modified' $change.Path }
    }
  }
}

function Check-GitState {
  if (-not $script:GitRoot) { return }
  $dirty = @(Invoke-Git @('-C', $Root, 'status', '--porcelain', '--untracked-files=no'))
  if ($dirty.Count -gt 0) {
    if ($Force) {
      Write-Warn '检测到本地 git 修改，-Force 已启用，将先备份再覆盖：'
      $dirty | ForEach-Object { Write-Host "  $_" }
      if ($script:BackupDir) {
        $patch = Join-Path $script:BackupDir 'local-changes.patch'
        try {
          $patchText = ((Invoke-Git @('-C', $Root, 'diff', 'HEAD') | Out-String) + [Environment]::NewLine + (Invoke-Git @('-C', $Root, 'diff', '--cached') | Out-String))
          [System.IO.File]::WriteAllText($patch, $patchText, (New-Object System.Text.UTF8Encoding($false)))
          Add-ManifestLine "localPatch`tlocal-changes.patch"
        } catch { }
      }
      Invoke-Git @('-C', $Root, 'reset', '--hard', 'HEAD') | Out-Null
    } else {
      $dirty | ForEach-Object { Write-Host "  $_" }
      if ($DryRun) {
        Write-Warn 'dry-run：工作区有未提交修改，实际更新会中止；请在真正更新前提交/暂存，或使用 -Force'
      } else {
        Stop-WithError '工作区有未提交的 git 修改；请先提交/暂存，或使用 -Force（会先备份再覆盖）'
      }
    }
  }

  $aheadText = (Invoke-Git @('-C', $Root, 'rev-list', '--count', "$($script:TargetRef)..HEAD") | Select-Object -First 1)
  $ahead = 0
  [void][int]::TryParse([string]$aheadText, [ref]$ahead)
  if ($ahead -gt 0 -and -not $Force) {
    if ($DryRun) {
      Write-Warn "dry-run：当前 HEAD 含有目标 Release 之外的本地提交（$ahead 个），实际更新会中止"
    } else {
      Stop-WithError "当前 HEAD 含有目标 Release 之外的本地提交（$ahead 个）；请先处理，或使用 -Force"
    }
  }
}

function Get-TargetTree {
  $zip = Join-Path $script:TmpDir 'source.zip'
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Invoke-Git @("--git-dir=$CacheRepo", 'archive', '--format=zip', "--output=$zip", $script:TargetRef, '--', $script:Type) | Out-Null
  $tree = Join-Path $script:TmpDir 'target-tree'
  Expand-ZipFile $zip $tree
  return $tree
}

function Apply-NonGitChanges {
  $tree = Get-TargetTree
  Backup-Changes
  $applied = 0
  $skipped = 0
  foreach ($change in $script:Changes) {
    if (Test-ProtectedPath $change.Path) {
      Write-Warn "跳过受保护文件: $($change.Path)"
      $skipped++
      continue
    }
    $dst = Join-RootPath $change.Path
    if ($change.Status -match '^D') {
      Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
      $applied++
      continue
    }
    $src = Join-Path $tree ($change.Path -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $src)) {
      Write-Warn "目标版本缺少文件: $($change.Path)"
      continue
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $applied++
  }
  Write-Info "已应用 $applied 个文件变更，跳过 $skipped 个受保护文件"
}

# ---------- 安装 / 构建 ----------

function Get-PackageManager {
  if (Test-CommandExists 'pnpm') { return @('pnpm') }
  if (Test-CommandExists 'corepack') {
    Push-Location $Root
    try {
      & corepack pnpm --version 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { return @('corepack', 'pnpm') }
    } catch { }
    finally { Pop-Location }
  }
  if (Test-CommandExists 'npm') {
    Write-Warn '未找到 pnpm，回退到 npm（可能与 pnpm-lock.yaml 不完全一致）'
    return @('npm')
  }
  Stop-WithError '未找到 pnpm / npm，请先安装 Node.js 与 pnpm'
}

function Invoke-PackageCommand {
  param(
    [string[]]$Pm,
    [string[]]$Arguments,
    [string]$WorkDir
  )
  if ($script:NpmRegistry) { $env:npm_config_registry = $script:NpmRegistry }
  $exe = $Pm[0]
  $pre = @()
  if ($Pm.Count -gt 1) { $pre = $Pm[1..($Pm.Count - 1)] }
  Invoke-Native $exe ($pre + $Arguments) -WorkDir $WorkDir | Out-Null
}

function Ensure-NodeNative {
  param([string[]]$Pm)
  $dir = Join-Path $Root 'nodejs'
  $native = Join-Path $dir 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'node_modules\better-sqlite3'))) { return }
  if (Test-Path -LiteralPath $native) { return }
  if ($Pm[0] -eq 'npm') {
    Write-Warn 'better-sqlite3 原生模块未构建；npm 通常会自动执行 install 脚本，如仍失败请手动处理'
    return
  }

  $ws = Join-Path $dir 'pnpm-workspace.yaml'
  $created = $false
  if (Test-Path -LiteralPath $ws) {
    $content = Get-Content -LiteralPath $ws -Raw
    if ($content -notmatch 'better-sqlite3') {
      Write-Warn "检测到 $ws，但未允许 better-sqlite3 构建；请手动添加 onlyBuiltDependencies"
      return
    }
  } else {
    Write-Warn 'better-sqlite3 原生模块缺失，正在临时启用 pnpm 构建脚本'
    [System.IO.File]::WriteAllText($ws, "onlyBuiltDependencies:`n  - better-sqlite3`n", (New-Object System.Text.UTF8Encoding($false)))
    $created = $true
  }

  try {
    Invoke-PackageCommand $Pm @('rebuild', 'better-sqlite3') $dir
  } catch {
    Write-Warn '重新构建失败，请手动执行 pnpm approve-builds'
  } finally {
    if ($created) { Remove-Item -LiteralPath $ws -Force -ErrorAction SilentlyContinue }
  }
  if (Test-Path -LiteralPath $native) {
    Write-Ok 'better-sqlite3 原生模块已构建'
  } else {
    Write-Warn 'better-sqlite3 仍未构建；请进入 nodejs/ 执行 pnpm approve-builds'
  }
}

function Install-AndBuildNode {
  $pm = Get-PackageManager
  if (Test-CommandExists 'node') {
    Push-Location $Root
    try {
      $major = [int](& node -p "process.versions.node.split('.')[0]" 2>$null)
      if ($major -lt 22) { Write-Warn 'Node.js 版本低于 22，可能无法运行' }
    } catch { }
    finally { Pop-Location }
  }
  Write-Info '安装 Node.js 依赖...'
  try {
    Invoke-PackageCommand $pm @('install') (Join-Path $Root 'nodejs')
  } catch {
    Stop-WithError '依赖安装失败；可用 -Rollback 回滚'
  }
  Ensure-NodeNative $pm
  Write-Info '构建 Node.js...'
  try {
    Invoke-PackageCommand $pm @('run', 'build') (Join-Path $Root 'nodejs')
  } catch {
    Stop-WithError '构建失败；可用 -Rollback 回滚'
  }
  Write-Ok 'Node.js 构建完成'
}

function Install-Worker {
  $pm = @(Get-PackageManager)
  Write-Info '安装 Worker 依赖...'
  if ($pm[0] -eq 'npm') {
    try {
      Invoke-PackageCommand $pm @('install') (Join-Path $Root 'worker')
    } catch {
      Stop-WithError '依赖安装失败；可用 -Rollback 回滚'
    }
    Write-Ok 'Worker 依赖安装完成'
    return
  }

  try {
    Invoke-PackageCommand $pm @('install', '--ignore-scripts') (Join-Path $Root 'worker')
  } catch {
    Stop-WithError '依赖安装失败；可用 -Rollback 回滚'
  }

  $ws = Join-Path (Join-Path $Root 'worker') 'pnpm-workspace.yaml'
  $created = $false
  if (Test-Path -LiteralPath $ws) {
    $content = Get-Content -LiteralPath $ws -Raw
    if ($content -notmatch 'workerd') {
      Write-Warn "检测到 $ws，但未允许 workerd/esbuild/sharp 构建；请手动添加 onlyBuiltDependencies"
    }
  } else {
    [System.IO.File]::WriteAllText($ws, "onlyBuiltDependencies:`n  - esbuild`n  - sharp`n  - workerd`n", (New-Object System.Text.UTF8Encoding($false)))
    $created = $true
  }
  if ($created -or ((Get-Content -LiteralPath $ws -Raw) -match 'workerd')) {
    try {
      Invoke-PackageCommand $pm @('rebuild', 'esbuild', 'sharp', 'workerd') (Join-Path $Root 'worker')
    } catch {
      Write-Warn 'Worker 原生依赖构建失败，请进入 worker/ 执行 pnpm approve-builds'
    }
  }
  if ($created) { Remove-Item -LiteralPath $ws -Force -ErrorAction SilentlyContinue }
  Write-Ok 'Worker 依赖安装完成'
}

# ---------- 更新流程 ----------

function Replace-Public {
  param([string]$RelativePath)
  if (-not $script:PublicSrc) { return }
  if ($DryRun) {
    Write-Info "将替换管理面板: $RelativePath"
    return
  }
  $dest = Join-RootPath $RelativePath
  Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Copy-Item -LiteralPath $script:PublicSrc -Destination $dest -Recurse -Force
  Write-Ok "已更新管理面板: $RelativePath"
}

function Print-RestartHelp {
  Write-Host ''
  Write-Host '下一步（脚本不会自动重启服务）：' -ForegroundColor White
  switch ($script:Type) {
    'nodejs' {
      $printedPm2 = $false
      if (Test-CommandExists 'pm2') {
        Push-Location $Root
        try {
          $list = (& pm2 jlist 2>$null | Out-String)
          if ($list -match 'momo-backend') {
            Write-Host '  pm2 restart momo-backend'
            $printedPm2 = $true
          }
        } catch { }
        finally { Pop-Location }
      }
      if (-not $printedPm2) {
        Write-Host "  cd `"$Root\nodejs`""
        Write-Host '  pnpm start    # 或 pm2 / systemd 对应的 restart'
      }
      if ($script:SchemaChanged) {
        Write-Host ''
        Write-Host '检测到数据库 schema 变更，请确认后执行：' -ForegroundColor Yellow
        Write-Host "  cd `"$Root\nodejs`" && pnpm db:push"
        Write-Host "  脚本已备份数据库到: $($script:BackupDir)\db"
      }
    }
    'worker' {
      Write-Host "  cd `"$Root\worker`" && pnpm run deploy"
      Write-Host '  Worker 首次请求会自动迁移 D1；如报数据库错误，可在 D1 控制台执行 worker/schemas/comment.sql。'
    }
    'go' {
      if (Test-Path -LiteralPath (Join-Path $Root 'momo.bash')) {
        Write-Host "  cd `"$Root`""
        Write-Host '  # Linux: ./momo.bash 选择 3) 重启服务'
      } else {
        Write-Host '  按你原来的方式重启 Go 二进制 / Windows 服务。'
      }
    }
    'docker' {
      Initialize-ComposeContext
      if ($script:ComposeCmd.Count -eq 0) { [void](Resolve-ComposeCommand) }
      if ($script:ComposeCmd.Count -gt 0 -and $script:ComposeFile) {
        $exe = $script:ComposeCmd[0]
        $pre = @(Get-ComposePrefix)
        $cmd = (@($exe) + $pre + @('-f', $script:ComposeFile, 'up', '-d')) -join ' '
        Write-Host "  $cmd"
        $ps = (@($exe) + $pre + @('-f', $script:ComposeFile, 'ps')) -join ' '
        Write-Host "  查看状态: $ps"
      } else {
        Write-Host '  docker compose up -d'
      }
    }
  }
  Write-Host ''
}

function Update-NodeJs {
  Prepare-PublicAsset
  Initialize-Backup
  Backup-Configs
  Backup-DbFiles
  Backup-Archive 'public' 'nodejs/public'
  Backup-Archive 'dist' 'nodejs/dist'

  $scope = if ($script:GitRoot) { '' } else { 'nodejs' }
  $script:Changes = @(Get-Changes $script:CurrentRef $script:TargetRef $scope)

  if ($script:Changes.Count -eq 0) {
    Write-Info '源码没有差异，仅更新管理面板并重新构建'
  } else {
    Write-Info "检测到 $($script:Changes.Count) 个源码文件变更"
    $script:Changes | Select-Object -First 20 | ForEach-Object { Write-Host "  $($_.Status)  $($_.Path)" }
  }

  if ($script:GitRoot) {
    Check-GitState
    if ($script:Changes.Count -gt 0) {
      Backup-Changes
      if (-not $DryRun) {
        Invoke-Git @('-C', $Root, 'checkout', '--detach', $script:TargetRef) | Out-Null
        if ($script:BackupDir) {
          $envBackup = Join-Path $script:BackupDir 'files\nodejs\.env'
          if (Test-Path -LiteralPath $envBackup) {
            Copy-Item -LiteralPath $envBackup -Destination (Join-Path $Root 'nodejs\.env') -Force -ErrorAction SilentlyContinue
          }
        }
      } else {
        Write-Info "将执行: git checkout --detach $($script:TargetRef)"
      }
    }
  } else {
    if ($script:Changes.Count -gt 0 -and -not $DryRun) {
      Apply-NonGitChanges
    } elseif ($DryRun) {
      Write-Info "将应用 git diff: $($script:CurrentRef)..$($script:TargetRef) -- nodejs"
    }
  }

  Replace-Public 'nodejs/public'

  if ($DryRun) {
    Write-Info '将执行: cd nodejs && pnpm install && pnpm run build'
    return
  }

  Install-AndBuildNode

  if ($script:GitRoot) {
    $schema = Invoke-Git @('-C', $Root, 'diff', '--name-only', $script:CurrentRefFull, $script:TargetRef, '--', 'nodejs/src/orm/schema.ts')
    if ($schema) { $script:SchemaChanged = $true }
  } else {
    foreach ($change in $script:Changes) {
      if ($change.Path -eq 'nodejs/src/orm/schema.ts') { $script:SchemaChanged = $true }
    }
  }

  Write-State
  Prune-Backups
  Print-RestartHelp
}

function Update-Worker {
  Prepare-PublicAsset
  Initialize-Backup
  Backup-Configs
  Backup-DbFiles
  Backup-Archive 'public' 'worker/public'

  $scope = if ($script:GitRoot) { '' } else { 'worker' }
  $script:Changes = @(Get-Changes $script:CurrentRef $script:TargetRef $scope)

  if ($script:Changes.Count -eq 0) {
    Write-Info '源码没有差异，仅更新管理面板并安装依赖'
  } else {
    Write-Info "检测到 $($script:Changes.Count) 个源码文件变更"
    $script:Changes | Select-Object -First 20 | ForEach-Object { Write-Host "  $($_.Status)  $($_.Path)" }
  }

  if ($script:GitRoot) {
    Check-GitState
    if ($script:Changes.Count -gt 0) {
      Backup-Changes
      if (-not $DryRun) {
        Invoke-Git @('-C', $Root, 'checkout', '--detach', $script:TargetRef) | Out-Null
        if ($script:BackupDir) {
          $wranglerBackup = Join-Path $script:BackupDir 'files\worker\wrangler.jsonc'
          if (Test-Path -LiteralPath $wranglerBackup) {
            Copy-Item -LiteralPath $wranglerBackup -Destination (Join-Path $Root 'worker\wrangler.jsonc') -Force -ErrorAction SilentlyContinue
          }
        }
      } else {
        Write-Info "将执行: git checkout --detach $($script:TargetRef)（保留 wrangler.jsonc）"
      }
    }
  } else {
    if ($script:Changes.Count -gt 0 -and -not $DryRun) {
      Apply-NonGitChanges
    } elseif ($DryRun) {
      Write-Info "将应用 git diff: $($script:CurrentRef)..$($script:TargetRef) -- worker"
    }
  }

  Replace-Public 'worker/public'

  if ($DryRun) {
    Write-Info '将执行: cd worker && pnpm install'
    return
  }

  Install-Worker
  Write-State
  Prune-Backups
  Print-RestartHelp
}

function Update-Go {
  param([string]$OsName, [string]$ArchName)
  if ($ArchName -ne 'amd64') {
    Stop-WithError "Release 只提供 amd64 的 Go 包（当前架构: $ArchName）；请自行编译"
  }
  $asset = if ($OsName -eq 'windows') { 'go-windows-amd64.zip' } else { 'go-linux-amd64.tar.gz' }
  $url = Release-AssetUrl $asset

  $goBin = Get-GoBinary
  if (-not $goBin) { Stop-WithError '未找到 Go 二进制（momo-backend-*）' }

  if ($DryRun) {
    Write-Info "将下载: $url"
    Write-Info "将替换: $(Split-Path -Leaf $goBin) 和 public/，保留 config/ 与 data/"
    return
  }

  $pkg = Join-Path $script:TmpDir 'go-package'
  New-Item -ItemType Directory -Force -Path $pkg | Out-Null
  if ($OsName -eq 'windows') {
    $zip = Join-Path $script:TmpDir $asset
    Invoke-Download $url $zip $asset
    Expand-ZipFile $zip $pkg
  } else {
    $tgz = Join-Path $script:TmpDir $asset
    Invoke-Download $url $tgz $asset
    Expand-TarGz $tgz $pkg
  }

  $newBin = Get-ChildItem -LiteralPath $pkg -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'momo-backend-*' } | Select-Object -First 1
  if (-not $newBin) { Stop-WithError 'Go Release 中未找到二进制' }
  $newVersion = Get-BinaryVersion $newBin.FullName
  if (-not $newVersion) { Stop-WithError '无法运行新 Go 二进制验证版本' }
  if ($newVersion -ne $script:TargetVersion) {
    Write-Warn "新二进制版本 $newVersion 与目标 $($script:TargetVersion) 不一致"
  }

  $newPublic = Get-ChildItem -LiteralPath $pkg -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'public' } | Select-Object -First 1
  $newMomoBash = Get-ChildItem -LiteralPath $pkg -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'momo.bash' } | Select-Object -First 1

  Initialize-Backup
  Backup-Configs
  Backup-DbFiles
  $binRel = ConvertTo-RelativePath $goBin
  Backup-File 'file' 'modified' $binRel
  Backup-Archive 'public' 'public'
  if (Test-Path -LiteralPath (Join-Path $Root 'momo.bash')) { Backup-File 'file' 'modified' 'momo.bash' }

  $old = "$goBin.old-$($script:Ts)"
  try {
    Move-Item -LiteralPath $goBin -Destination $old -Force
  } catch {
    Copy-Item -LiteralPath $newBin.FullName -Destination "$goBin.new" -Force -ErrorAction SilentlyContinue
    Stop-WithError "二进制正在运行且无法替换；已保存为 $goBin.new，请停止服务后手动替换（旧文件仍在）"
  }
  try {
    Copy-Item -LiteralPath $newBin.FullName -Destination $goBin -Force
  } catch {
    Move-Item -LiteralPath $old -Destination $goBin -Force -ErrorAction SilentlyContinue
    Stop-WithError '替换 Go 二进制失败，已尝试恢复'
  }

  if ($newPublic -and (Test-Path -LiteralPath $newPublic.FullName)) {
    $publicDest = Join-Path $Root 'public'
    Remove-Item -LiteralPath $publicDest -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $newPublic.FullName -Destination $publicDest -Recurse -Force
  }
  if ($newMomoBash -and $OsName -ne 'windows') {
    Copy-Item -LiteralPath $newMomoBash.FullName -Destination (Join-Path $Root 'momo.bash') -Force -ErrorAction SilentlyContinue
  }

  $finalVersion = Get-BinaryVersion $goBin
  if ($finalVersion -ne $script:TargetVersion) {
    Stop-WithError "更新后版本校验失败（$finalVersion != $($script:TargetVersion)）"
  }

  Write-State
  Prune-Backups
  Print-RestartHelp
  Write-Say "旧二进制保留在: $old（确认运行正常后可删除）"
}

function Update-Docker {
  if (-not (Test-DockerAvailable)) { Stop-WithError 'Docker 不可用' }
  Initialize-ComposeContext
  if (-not $script:ComposeFile) { Stop-WithError '未找到 docker-compose.yml / compose.yml' }
  if ($script:ComposeCmd.Count -eq 0 -and -not (Resolve-ComposeCommand)) { Stop-WithError '未找到 docker compose / docker-compose' }

  $container = Get-DockerContainer
  $image = Get-DockerImage $container
  if ([string]::IsNullOrWhiteSpace($image)) { Stop-WithError '无法从 compose 文件解析镜像名' }
  $parsed = Split-ImageRef $image
  $repo = $parsed.Repo
  $tag = $parsed.Tag

  $targetImage = "${repo}:$($script:TargetVersion)"
  $mirrorRef = ''
  if ($script:UseMirror) {
    if ($repo -like 'ghcr.io/*') { $mirrorRef = "$($script:GhcrMirror)/$($repo.Substring(8))" }
    elseif ($repo -like 'docker.io/*') { $mirrorRef = "$($script:DockerhubMirror)/$($repo.Substring(10))" }
    elseif ($repo -notmatch '^[^/]+\.[^/]+/') { $mirrorRef = "$($script:DockerhubMirror)/$repo" }
  }

  if ($DryRun) {
    Write-Info "将拉取镜像: $targetImage"
    if ($mirrorRef) { Write-Info "优先尝试镜像: ${mirrorRef}:$($script:TargetVersion)" }
    Write-Info "将把 $targetImage 标记为 ${repo}:$tag"
    Write-Info '将备份数据库并保留当前镜像为 rollback tag'
    Write-Info "将执行: $($script:ComposeCmd -join ' ') -f $($script:ComposeFile) up -d"
    return
  }

  $pulled = $false
  if ($mirrorRef) {
    Write-Info "拉取镜像（国内镜像）: ${mirrorRef}:$($script:TargetVersion)"
    Push-Location $Root
    try {
      & docker pull "${mirrorRef}:$($script:TargetVersion)"
      if ($LASTEXITCODE -eq 0) {
        & docker tag "${mirrorRef}:$($script:TargetVersion)" $targetImage
        if ($LASTEXITCODE -eq 0) { $pulled = $true } else { Stop-WithError '镜像打标签失败' }
      } else {
        Write-Warn '国内镜像拉取失败，回退直连'
      }
    } finally { Pop-Location }
  }
  if (-not $pulled) {
    Write-Info "拉取镜像: $targetImage"
    Push-Location $Root
    try {
      & docker pull $targetImage
      if ($LASTEXITCODE -ne 0) { Stop-WithError "拉取镜像失败: $targetImage" }
    } finally { Pop-Location }
  }

  Initialize-Backup
  Backup-Configs
  Backup-DbFiles

  $imgId = ''
  Push-Location $Root
  try {
    $imgId = (& docker image inspect -f '{{.Id}}' "${repo}:$tag" 2>$null)
    if (-not $imgId -and $container) {
      $imgId = (& docker inspect -f '{{.Image}}' $container 2>$null)
    }
  } finally { Pop-Location }

  $backupTag = "${repo}:rollback-$($script:Ts)"
  if ($imgId) {
    Push-Location $Root
    try {
      & docker tag $imgId $backupTag 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        Add-ManifestLine "docker`t$repo`t$tag`t$backupTag"
      } else {
        Write-Warn '无法创建镜像回滚标签'
      }
    } finally { Pop-Location }
  } else {
    Write-Warn '未找到当前镜像，无法创建镜像回滚标签'
  }

  if ($tag -ne $script:TargetVersion) {
    if ($tag -ne 'latest') {
      Write-Warn "compose 固定了镜像标签 $tag；脚本会把新版本打上同一标签，建议改成 latest 或 $($script:TargetVersion)"
    }
    Push-Location $Root
    try {
      & docker tag $targetImage "${repo}:$tag"
      if ($LASTEXITCODE -ne 0) { Stop-WithError "无法把新镜像标记为 ${repo}:$tag" }
    } finally { Pop-Location }
  }

  Write-State
  Prune-Backups
  Print-RestartHelp
}

# ---------- 清理 / 回滚 ----------

function Prune-Backups {
  if ($NoBackup -or -not (Test-Path -LiteralPath $BackupRoot)) { return }
  $dirs = @(Get-ChildItem -LiteralPath $BackupRoot -Directory | Sort-Object Name -Descending)
  for ($i = $Keep; $i -lt $dirs.Count; $i++) {
    Remove-Item -LiteralPath $dirs[$i].FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Restore-Archive {
  param([string]$RelativePath, [string]$ArchiveFile)
  $archive = Join-Path (Join-Path $script:BackupDir 'archives') $ArchiveFile
  if (-not (Test-Path -LiteralPath $archive)) {
    Write-Warn "备份缺少目录归档: $ArchiveFile"
    return
  }
  $dest = Join-RootPath $RelativePath
  Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  if ($ArchiveFile -like '*.zip') {
    Expand-Archive -LiteralPath $archive -DestinationPath $dest -Force
  } else {
    Invoke-Native (Get-TarExe) @('-xzf', $archive, '-C', $Root) | Out-Null
  }
}

function Invoke-Rollback {
  if (-not (Test-Path -LiteralPath $BackupRoot)) { Stop-WithError '没有可用的备份目录' }
  $latest = Get-ChildItem -LiteralPath $BackupRoot -Directory | Sort-Object Name | Select-Object -Last 1
  if (-not $latest) { Stop-WithError '没有可用的备份' }
  $script:BackupDir = $latest.FullName
  $manifest = Join-Path $script:BackupDir 'manifest.txt'
  if (-not (Test-Path -LiteralPath $manifest)) { Stop-WithError "备份缺少 manifest.txt: $($script:BackupDir)" }

  $rbType = ''
  $rbFromVersion = ''
  $rbToVersion = ''
  $rbFromRef = ''
  $rbGit = 0
  $rbDockerRepo = ''
  $rbDockerTag = ''
  $rbDockerBackup = ''
  $files = @()
  $configs = @()
  $archives = @()
  $archivesAbsent = @()
  $dbs = @()

  foreach ($line in (Get-Content -LiteralPath $manifest)) {
    $parts = $line -split "`t"
    switch ($parts[0]) {
      'type' { $rbType = $parts[1] }
      'fromVersion' { $rbFromVersion = $parts[1] }
      'toVersion' { $rbToVersion = $parts[1] }
      'fromRef' { $rbFromRef = $parts[1] }
      'git' { $rbGit = [int]$parts[1] }
      'docker' { $rbDockerRepo = $parts[1]; $rbDockerTag = $parts[2]; $rbDockerBackup = $parts[3] }
      'file' { $files += [pscustomobject]@{ State = $parts[1]; Path = $parts[2] } }
      'config' { $configs += $parts[1] }
      'archive' { $archives += [pscustomobject]@{ Kind = $parts[1]; Path = $parts[2]; File = $parts[3] } }
      'archive-absent' { $archivesAbsent += $parts[2] }
      'db' { $dbs += $parts[1] }
    }
  }

  Write-Info "找到备份: $($script:BackupDir)"
  Write-Info "类型: $(if ($rbType) { $rbType } else { 'unknown' })  版本: $(if ($rbFromVersion) { $rbFromVersion } else { '?' }) -> $(if ($rbToVersion) { $rbToVersion } else { '?' })"
  if ($DryRun) { Write-Info 'dry-run：不会执行回滚'; return }

  if (-not $Yes) {
    $answer = Read-Host '回滚会把源码/管理面板/数据库恢复到更新前，继续? [y/N]'
    if ($answer -notmatch '^[yY]') { Stop-WithError '已取消' }
  }

  if ($rbType) { $script:Type = $rbType }

  if ($rbGit -eq 1 -and $rbFromRef -and (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
    Write-Info "回滚 git 版本到 $rbFromRef"
    try {
      Invoke-Git @('-C', $Root, 'checkout', '-f', '--detach', $rbFromRef) | Out-Null
      $patch = Join-Path $script:BackupDir 'local-changes.patch'
      if (Test-Path -LiteralPath $patch) {
        Push-Location $Root
        try {
          & git apply $patch 2>$null
          if ($LASTEXITCODE -eq 0) { Write-Info '已恢复更新前的本地 git 修改' }
          else { Write-Warn "本地修改补丁无法自动应用，已保留: $patch" }
        } finally { Pop-Location }
      }
    } catch {
      Write-Warn 'git checkout 回滚失败，将仅恢复备份文件'
    }
  }

  foreach ($file in $files) {
    $rel = $file.Path
    if ($rel -match '(^|/)\.\.(/|$)') { Write-Warn "跳过异常路径: $rel"; continue }
    $dst = Join-RootPath $rel
    if ($file.State -eq 'added') {
      Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
      continue
    }
    $src = Join-Path (Join-Path $script:BackupDir 'files') ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    if (Test-Path -LiteralPath $src) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
      Copy-Item -LiteralPath $src -Destination $dst -Force
    } else {
      Write-Warn "备份缺少文件: $rel"
    }
  }

  foreach ($rel in $configs) {
    $src = Join-Path (Join-Path $script:BackupDir 'files') ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    $dst = Join-RootPath $rel
    if (Test-Path -LiteralPath $src) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
      Copy-Item -LiteralPath $src -Destination $dst -Force
    }
  }

  foreach ($archive in $archives) {
    Restore-Archive $archive.Path $archive.File
  }

  foreach ($rel in $archivesAbsent) {
    Write-Info "移除更新时新增的目录: $rel"
    Remove-Item -LiteralPath (Join-RootPath $rel) -Recurse -Force -ErrorAction SilentlyContinue
  }

  if ($dbs.Count -gt 0) {
    Write-Warn '即将恢复数据库；如果服务仍在运行，请先停止服务，否则可能损坏数据'
  }
  foreach ($rel in $dbs) {
    $src = Join-Path (Join-Path $script:BackupDir 'db') ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    $dst = Join-RootPath $rel
    if (-not (Test-Path -LiteralPath $src)) { Write-Warn "备份缺少数据库: $rel"; continue }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Remove-Item -LiteralPath ($dst + '-wal') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath ($dst + '-shm') -Force -ErrorAction SilentlyContinue
    foreach ($suffix in @('-wal', '-shm')) {
      if (Test-Path -LiteralPath ($src + $suffix)) {
        Copy-Item -LiteralPath ($src + $suffix) -Destination ($dst + $suffix) -Force
      }
    }
  }

  if ($rbDockerBackup) {
    Write-Info "恢复 Docker 镜像: $rbDockerBackup -> ${rbDockerRepo}:$rbDockerTag"
    Push-Location $Root
    try {
      & docker tag $rbDockerBackup "${rbDockerRepo}:$rbDockerTag" 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Warn '镜像回滚失败' }
    } finally { Pop-Location }
  }

  if ($rbFromVersion -and $rbFromVersion -ne 'unknown') {
    Write-State -StateType $script:Type -StateVersion $rbFromVersion -StateRef $rbFromRef
  }

  Write-Ok "回滚完成（备份仍保留: $($script:BackupDir)）"
  Print-RestartHelp
}

# ---------- 系统信息 ----------

function Get-OsArch {
  $osName = 'linux'
  $archName = 'amd64'
  if ($env:OS -eq 'Windows_NT') { $osName = 'windows' }
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -eq 'AMD64') { $archName = 'amd64' }
  elseif ($arch -eq 'ARM64') { $archName = 'arm64' }
  elseif ($arch -eq 'x86') { $archName = '386' }
  return [pscustomobject]@{ Os = $osName; Arch = $archName }
}

# ---------- 主流程 ----------

$exitCode = 0
try {
  Initialize-Directories
  New-TempDirectory
  if ($DryRun) {
    $CacheDir = Join-Path $script:TmpDir 'cache'
    $CacheRepo = Join-Path $CacheDir 'repo.git'
  }
  Assert-BasicTools

  Write-Host "Momo Backend 更新脚本 v$ScriptVersion" -ForegroundColor White
  Write-Host "根目录: $Root"
  if ($DryRun) { Write-Host 'dry-run 模式：不会修改部署文件' -ForegroundColor Yellow }

  Resolve-Repository

  if ($Rollback) {
    Invoke-Rollback
    exit 0
  }

  Resolve-DeploymentType
  Resolve-Mirror
  Ensure-Tags
  Resolve-Target
  Get-CurrentVersion
  Compute-BackupDir

  if (-not $DryRun -and $script:CurrentVersion -ne 'unknown' -and $script:CurrentVersion -eq $script:TargetVersion -and -not $Force) {
    switch ($script:Type) {
      'nodejs' { if (Test-Path -LiteralPath (Join-Path $Root 'nodejs\public')) { Write-Ok "当前已是最新版本 $($script:TargetVersion)"; exit 0 } }
      'worker' { if (Test-Path -LiteralPath (Join-Path $Root 'worker\public')) { Write-Ok "当前已是最新版本 $($script:TargetVersion)"; exit 0 } }
      default { Write-Ok "当前已是最新版本 $($script:TargetVersion)"; exit 0 }
    }
  }

  if ($script:CurrentVersion -ne 'unknown' -and $script:CurrentVersion -ne $script:TargetVersion) {
    $currentV = $null
    $targetV = $null
    try { $currentV = [version]$script:CurrentVersion; $targetV = [version]$script:TargetVersion } catch { }
    if ($currentV -and $targetV -and $currentV -gt $targetV -and -not $Force) {
      Write-Warn "当前版本 $($script:CurrentVersion) 高于目标版本 $($script:TargetVersion)（降级）"
      if (-not $Yes) {
        $answer = Read-Host '确认降级? [y/N]'
        if ($answer -notmatch '^[yY]') { Stop-WithError '已取消' }
      }
    }
  }

  Write-Host ''
  Write-Host '更新计划' -ForegroundColor White
  Write-Host "  部署类型: $($script:Type)"
  Write-Host "  当前版本: $(if ($script:CurrentVersion) { $script:CurrentVersion } else { 'unknown' })"
  Write-Host "  目标版本: $($script:TargetVersion) ($($script:TargetTag))"
  $source = if ($script:GitRoot) { "git 仓库 $Root" } else { "临时缓存 $CacheRepo" }
  Write-Host "  源码来源: $source"
  Write-Host "  仓库地址: $($script:GitUrl)"
  $mirrorText = if ($script:UseMirror) { '国内镜像' } else { '直连' }
  Write-Host "  镜像模式: $mirrorText"
  if ($NoBackup) { Write-Host '  备份目录: 已禁用' } else { Write-Host "  备份目录: $($script:BackupDir)" }

  if (-not $DryRun -and -not $Yes) {
    Write-Host ''
    $answer = Read-Host '即将执行更新，继续? [y/N]'
    if ($answer -notmatch '^[yY]') { Stop-WithError '已取消' }
  }

  $osArch = Get-OsArch
  switch ($script:Type) {
    'nodejs' { Update-NodeJs }
    'worker' { Update-Worker }
    'go' { Update-Go -OsName $osArch.Os -ArchName $osArch.Arch }
    'docker' { Update-Docker }
    default { Stop-WithError "未知部署类型: $($script:Type)" }
  }

  if (-not $DryRun) {
    Write-Ok "更新完成：$($script:CurrentVersion) -> $($script:TargetVersion)"
    Write-Say "日志: $(if ($script:LogFile) { $script:LogFile } else { '（未写入）' })"
  }
} finally {
  Remove-TempDirectory
  if ($script:TranscriptStarted) {
    try { Stop-Transcript | Out-Null } catch { }
    $script:TranscriptStarted = $false
  }
}

exit $exitCode
