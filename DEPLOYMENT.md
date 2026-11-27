# 拾针部署指南

本项目采用“一名用户一套 Cloudflare 实例”。每个实例只管理一个网易云账号，监控 1–20 个歌单及该账号云盘，维护者不提供集中服务器。

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

下面记录全部 Windows 手动步骤。macOS 和 Linux 用户建议使用官方按钮。

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

### 3. 验证并部署锁定实例

最省事的正式入口是：

```powershell
.\scripts\setup-cloudflare.ps1 -SkipInstall
```

若 D1 已存在，脚本会核对并复用资源，再执行验证和部署。业务数据以网易云为准，开发升级不要求导出或历史留档。
脚本会在复用同名 D1 前要求确认；自动化环境只有在用户已经核对资源后，才可显式传入 `-ReuseExisting -NonInteractive`。

也可以逐步执行：

```powershell
npm run verify
npm run deploy:full
```

`npm run deploy:full` 先构建，`npm run deploy` 使用已有构建；两者先验证生成配置继承了所选源配置的 Worker、D1 和同步 Workflow 身份，再执行以下步骤：

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

## Workers Observability

三种部署方式都会继承 `wrangler.jsonc` 中的 Observability 配置，无需在 Cloudflare 控制台额外启用。项目默认以 `head_sampling_rate: 1` 保存全部 Worker 调用日志；部署完成后，可在 **Workers & Pages → 当前 Worker → Observability** 中按请求路径、响应状态、执行结果和异常筛选日志。

日志只从启用后的新请求开始保存，不补录历史，也不记录尚未到达 Worker 的浏览器网络失败。日志额度、保留期和计费以 [Cloudflare Workers Logs 文档](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) 及账户套餐为准；流量扩大时按需要调低 `head_sampling_rate`。

Worker 代码不得把网易 Cookie、Access JWT、Secret、邮箱或其他身份凭据写入 `console`。网易请求失败日志记录端点、分类、状态和错误摘要；邮件失败日志记录事件、批次 ID 和安全错误代码。部署后可检查 `dist/server/wrangler.json` 中的 Observability 配置，并访问受保护接口，在控制台核对新请求日志。

## 邮件通知配置

邮件通知默认关闭，不影响基础监控与三种部署方式。要启用通知，需先在自己的 Cloudflare 账户完成邮件发送服务及收件地址验证，在部署配置中加入 `send_email` binding，binding 名称为 `NOTIFICATION_EMAIL`，并配置有效的发件地址变量 `NOTIFICATION_EMAIL_FROM`。项目使用 `cloudflare:email` 的 `EmailMessage` 和 binding 的 `send()`；平台权限、可用发件身份与收件限制以 [Cloudflare Send Email binding 文档](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) 为准。

本地发布把配置写入被忽略的 `wrangler.private.jsonc`，按钮部署用户在自己的实例配置中维护。保留既有 binding、域名、Access 变量和 Secret；收件人由 `ALLOWED_EMAIL` 决定。部署后打开“设置”，确认邮件服务可用，再开启通知并保存规则。

只在每日自动同步后检查通知，手动同步不发邮件。可按变灰、消失、错配、待找回总数设置正整数阈值，或启用自动同步失败提醒。持续超过同一阈值不会每天重复提醒，每个每日批次至多尝试发送一次；规则和名单处理见 [开发指南](./PROJECT_GUIDE.md#邮件通知)。

## 使用受保护的自定义域名

已拥有并托管在 Cloudflare 的域名可以直接绑定当前 Worker，无需更换 D1、Workflow、账号或加密 Secret。在未占用的子域名上配置 Custom Domain，不覆盖其他网站的 DNS 记录。

先把完整子域名加入现有 Cloudflare Access 应用的公共主机名目标，路径留空，继续使用原来的精确邮箱 Allow 规则。复用同一应用时，`ACCESS_AUD` 不变。确认保护目标保存后，在部署使用的 `wrangler.private.jsonc` 中添加：

```json
"routes": [
  { "pattern": "archive.example.com", "custom_domain": true }
]
```

使用 `npm run deploy:full` 重新生成并发布包含该路由的构建。Cloudflare 会建立子域名的 DNS 记录和证书。后续更新继续使用包含 `routes` 的私有配置；若重新生成私有配置，也要保留这些路由。

验收时同时检查未登录请求会进入 Access 登录页，以及登录后首页、歌单和状态接口能读取真实数据。自定义域名与 `workers.dev` 可以同时保留；两个公开入口都必须受到 Access 保护。

如果浏览器显示 1101，而当前 Worker 的实时和历史日志都没有对应请求，先对照本机 DNS 与公开 DNS 的解析结果，并检查代理或中转路径。错误页本身不能证明异常发生在项目代码中。Zero Trust 套餐提示也应独立核对，不能据此认定套餐开通会解决该错误。

## 首次使用验收

1. 打开 Worker 已配置并受 Access 保护的访问地址；
2. 使用允许邮箱接收 Access 验证码；
3. 进入“同步状态”，点击“连接网易云”；
4. 用网易云音乐 App 扫码并确认；
5. 勾选 1–20 个可访问的非空歌单并保存；
6. 等待全部新增歌单的基线完成，确认导航包含待找回、同步状态、歌单歌曲、网易云盘，并有设置入口；
7. 在“同步状态”手动发起一次全量同步，确认逐歌单及云盘结果；也可在单个歌单页或云盘页只同步该项。云盘普通绑定后在首次同步时建立基线，允许为空。

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

本地 loopback 请求在 `ALLOW_LOCAL_DEV` 不为字符串 `false` 时跳过 Access，开发示例显式设为 `true`。生产保持 `false`，不要把生产密钥复制到本地。账号与歌单在页面选择，不需要旧版 UID 或歌单环境变量。

## 更新与恢复

- 全新安装按顺序应用 `drizzle` 中全部迁移；已有实例只应用尚未执行的迁移，不修改已发布迁移记录。必要时通过页面重建基线，保留账号、监控选择、正式会话和 Secret；
- `npm run deploy` 要求已有生产构建；需要从头构建可用 `npm run deploy:full`；
- `npm run deploy:dry-run` 只验证发布物，不修改线上资源；
- Secret 只在全新未配置实例自动生成一次；
- 密钥丢失时不要清空歌曲历史，按 [SECURITY.md](./SECURITY.md#session_encryption_key-丢失或泄露)恢复并重新扫码；
- 官方按钮创建的用户仓库不会自动获得上游项目更新；更新代码时需保留该实例的私有资源配置。

## 卸载边界

删除本地目录不会影响线上。真正卸载需要在用户自己的 Cloudflare 账户中删除 Worker、D1、Workflow 和 Access 应用。

删除 D1 会永久删除歌曲基线和历史。执行前必须核对资源名称和 ID；本项目不会提供“一键删除全部资源”的脚本。

## 常见失败

- 页面提示“还差一步：配置 Cloudflare Access”：Worker 已部署但三个 Access 变量尚未完成；
- 已填写三个变量但页面仍提示未配置：到 **Deployments / Versions** 检查变量生成的新版本是否已提升到 100% 流量；
- migration 失败：部署程序会停止，不会继续发布依赖新表结构的代码；
- 已配置实例缺少 Secret：停止部署并按安全文档恢复，不能自动生成新密钥；
- 网易二维码或上游请求失败：与 Cloudflare 基础设施部署无关，旧 D1 历史不会被清空。

## 发布产物

生产构建位于 `dist`，包含前端静态资源、服务端 Worker 及生成配置；`.wrangler/deploy/config.json` 指向本次构建。保留配套元数据后可使用 `npm run deploy` 发布该构建。发布形式为完整 Worker、Static Assets、两个 Workflow 和 Cron，不需要服务器端另行安装 npm 依赖。不要把私有构建配置或 Secret 文件提交 Git。
