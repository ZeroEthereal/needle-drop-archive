# 拾针部署指南

本项目采用“一名用户一套 Cloudflare 实例”。每个实例只管理一个网易云账号和一个歌单，维护者不提供集中服务器。

## 选择部署方式

### 方式一：Deploy to Cloudflare（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ZeroEthereal/needle-drop-archive)

适合不想下载代码或安装 Node.js 的用户。用户需要 GitHub 和 Cloudflare 账户，整个流程在浏览器中完成，不依赖 Agent。

Cloudflare 会把公开仓库复制到用户自己的 GitHub 账户，创建并绑定 D1，运行构建和 migration，部署 Worker、Static Assets、Workflow 与 Cron，并连接 Workers Builds。

在部署表单中务必勾选 **“创建专用 Git 存储库”**。自动资源配置会把该实例的 D1 binding ID 写入复制后的仓库配置；它不是数据库密码，但属于实例私有标识，不应放进公开仓库。若已经误建为公开仓库，应立即在 GitHub 仓库设置中将其改为 Private，并检查提交历史中没有其他个人配置。

部署按钮完成后，实例会保持锁定，直到用户完成本页的 [Cloudflare Access 收尾](#cloudflare-access-收尾)。这是安全设计，不是部署失败。

### 方式二：Agent 辅助部署

Windows 用户可以下载项目后，把 [DEPLOY_WITH_AGENT.md](./DEPLOY_WITH_AGENT.md) 中的提示词交给任意能够运行终端命令的编码 Agent。

### 方式三：完整手动部署

下面记录全部 Windows 手动步骤。macOS 和 Linux 首版建议使用官方按钮。

## Windows 手动部署

### 1. 准备环境

- Node.js `>=22.13.0`；
- Git；
- 一个 Cloudflare 账户；
- 一个可以接收验证码的邮箱；
- 网易云音乐 App。

在项目根目录运行：

```powershell
npm ci
npx wrangler login
npx wrangler whoami
```

`npm ci` 严格使用 `package-lock.json`，不会替换项目依赖版本。

### 2. 创建或复用 D1

```powershell
.\scripts\bootstrap-cloudflare.ps1
```

脚本会：

- 查询当前 Cloudflare 账户中是否已有同名 D1；
- 创建或复用 `needle-drop-archive`；
- 生成被 `.gitignore` 排除的 `wrangler.private.jsonc`；
- 把真实 D1 UUID 只写入私有配置。

重复执行会复用现有私有配置和 D1，不会创建重复实例。

### 3. 验证、备份并部署锁定实例

最省事的正式入口是：

```powershell
.\scripts\setup-cloudflare.ps1 -SkipInstall
```

若 D1 已存在，脚本会先把 SQL 导出到 Windows 桌面的 `needle-drop-archive-backups`，再执行验证和部署。
脚本会在复用同名 D1 前要求确认；自动化环境只有在用户已经核对资源后，才可显式传入 `-ReuseExisting -NonInteractive`。

也可以逐步执行：

```powershell
npm run verify
npm run deploy:full
```

正式部署程序严格按以下顺序运行：

1. 应用 `drizzle` 中尚未执行的 D1 migrations；
2. 查询 `instance_config` 是否已经包含正式配置；
3. 只查询 Worker Secret 的名称；
4. 全新未配置实例缺少 `SESSION_ENCRYPTION_KEY` 时生成一次随机密钥；
5. 已配置实例缺少密钥、Secret 查询失败或 migration 失败时停止；
6. 部署 Worker、Assets、Workflow 和 Cron。

已有 `SESSION_ENCRYPTION_KEY` 永远不会被普通部署覆盖。

## Cloudflare Access 收尾

Access 决定谁能进入管理网站；网易扫码决定后台读取哪个音乐账号，两者互不替代。

### 1. 启用 Access

1. 打开 Cloudflare Dashboard 的 **Workers & Pages**；
2. 进入刚部署的 Worker；
3. 打开 **Settings → Domains & Routes**；
4. 在 `workers.dev` 地址旁点击 **Enable Cloudflare Access**；
5. Allow policy 只填写实例所有者自己的精确邮箱；
6. 启用 One-time PIN 身份提供方；
7. 保持 Preview URLs 关闭。

### 2. 记录两个 Access 值

在 Access 应用设置中记录：

- 团队域名，例如 `your-team.cloudflareaccess.com`；
- Application Audience，即 `AUD`。

它们不是网易 Cookie，但属于实例私有标识，不要提交到 GitHub Issue 或截图中。

### 3A. 官方按钮用户：在控制台填写变量

进入 Worker 的 **Settings → Variables and Secrets**，添加三个普通文本变量：

| 变量 | 内容 |
|---|---|
| `ALLOWED_EMAIL` | Access policy 中允许的精确邮箱 |
| `ACCESS_TEAM_DOMAIN` | Access 团队域名 |
| `ACCESS_AUD` | Access Application Audience |

保存并部署变量。公开 `wrangler.jsonc` 设置了 `keep_vars=true`，后续 Git 构建会保留这些控制台变量。

当前 Cloudflare 控制台可能只为变量变更创建一个新 Worker 版本，而不自动把线上流量切换过去。保存后打开 **Deployments / Versions**：若新版本尚未承载流量，使用版本菜单中的 **“提升版本”**，确认将它提升到 100%。随后重新打开网站；页面应从“还差一步：配置 Cloudflare Access”变为 Access 登录或“尚未登录”状态。

### 3B. 本地或 Agent 用户：写入私有配置

```powershell
.\scripts\bootstrap-cloudflare.ps1 `
  -AllowedEmail "you@example.com" `
  -AccessTeamDomain "your-team.cloudflareaccess.com" `
  -AccessAudience "replace-with-your-aud" `
  -Confirm:$false

npm run deploy:full
```

真实值只进入被忽略的 `wrangler.private.jsonc`。

## 首次使用验收

1. 打开 Worker 的 `workers.dev` 地址；
2. 使用允许邮箱接收 Access 验证码；
3. 进入“同步状态”，点击“连接网易云”；
4. 用网易云音乐 App 扫码并确认；
5. 选择一个非空歌单并二次确认；
6. 等待首份基线完成；
7. 手动同步一次，确认同步状态成功。

## 本地开发

```powershell
Copy-Item .dev.vars.local.example .dev.vars
node -e "const b=crypto.getRandomValues(new Uint8Array(32)); console.log(Buffer.from(b).toString('base64'))"
```

把输出仅写入本地 `.dev.vars` 的 `SESSION_ENCRYPTION_KEY=`，然后运行：

```powershell
npm run db:migrate:local
npm run dev
```

本地仅在 loopback 地址和 `ALLOW_LOCAL_DEV=true` 时跳过 Access。不要把生产密钥复制到本地。

## 更新、备份与恢复

- 修改生产数据库前先运行 D1 export；Wrangler 应用 migration 时还会创建服务器端备份；
- `npm run deploy` 要求已有生产构建；需要从头构建可用 `npm run deploy:full`；
- `npm run deploy:dry-run` 只验证发布物，不修改线上资源；
- Secret 只在全新未配置实例自动生成一次；
- 密钥丢失时不要清空歌曲历史，按 [SECURITY.md](./SECURITY.md#session_encryption_key-丢失或泄露)恢复并重新扫码；
- 官方按钮创建的用户仓库不会自动获得上游项目更新，低门槛升级仍属于未来开发方向。

## 卸载边界

删除本地目录不会影响线上。真正卸载需要在用户自己的 Cloudflare 账户中删除 Worker、D1、Workflow 和 Access 应用。

删除 D1 会永久删除歌曲基线和历史。执行前必须导出备份，并核对资源名称和 ID；本项目不会提供“一键删除全部资源”的脚本。

## 常见失败

- 页面提示“还差一步：配置 Cloudflare Access”：Worker 已部署但三个 Access 变量尚未完成；
- 已填写三个变量但页面仍提示未配置：到 **Deployments / Versions** 检查变量生成的新版本是否已提升到 100% 流量；
- migration 失败：部署程序会停止，不会继续发布依赖新表结构的代码；
- 已配置实例缺少 Secret：停止部署并按安全文档恢复，不能自动生成新密钥；
- 网易二维码或上游请求失败：与 Cloudflare 基础设施部署无关，旧 D1 历史不会被清空。

## 依赖变更

- 依赖变更：无；
- 未新增、升级、替换或删除 npm 依赖；
- `package-lock.json` 的依赖解析保持不变；
- 发布物仍是完整 Worker + Static Assets + Workflow，不需要服务器端另行安装依赖。
