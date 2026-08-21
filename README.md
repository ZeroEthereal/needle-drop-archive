# 拾针：网易云歌单防丢服务

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ZeroEthereal/needle-drop-archive)

“拾针”会持续保存一个网易云歌单的账号视角快照，发现歌曲消失或变灰时及时提醒，避免歌曲悄无声息地从收藏中丢失。它不下载、上传或保存音乐文件。

Needle Drop Archive is a self-hosted Cloudflare application that monitors one NetEase Cloud Music playlist for missing or unavailable tracks. Each user deploys and owns an independent instance and its data.

当前版本坚持“一名用户部署一套实例，一个实例绑定一个网易账号和一个歌单”。歌单可以是自建、私密或收藏的他人歌单；收藏歌单会显示所有者，并提醒对方修改也会被记录为变化。

## 最方便的三种部署方式

### 1. Deploy to Cloudflare（推荐，无需下载）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ZeroEthereal/needle-drop-archive)

在浏览器中完成 GitHub 与 Cloudflare 授权后，Cloudflare 会复制仓库、创建 D1、构建并部署 Worker、Static Assets、Workflow 和 Cron。部署表单中务必勾选 **“创建专用 Git 存储库”**：Cloudflare 会把实例的 D1 binding ID 写入复制后的仓库配置，使用私有仓库可以避免把该实例标识公开。

> **注意：** 如果一键部署提示“无法获取存储库内容”或无法继续，通常是因为 Cloudflare 部署页面读取公开 GitHub 仓库时使用了匿名请求，而当前网络或 VPN 节点的共享出口 IP 已被其他用户消耗完 GitHub 的匿名访问额度，并不代表项目代码有问题。请不要反复重试，建议改用下面的 **Agent 辅助部署**，让 Agent 自动完成部署和配置。

按钮部署完成后，还需在 Cloudflare 控制台启用一次 Access，并填写 `ALLOWED_EMAIL`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 三个变量。保存变量后，如果控制台只创建了新版本而没有自动切换流量，请到 **Deployments / Versions** 将该版本“提升”到 100% 流量。未完成这些步骤时网站保持锁定，不会显示个人数据。

### 2. 下载项目后让通用 Agent 辅助部署（Windows）

把项目下载到 Windows 电脑，打开能够执行 Windows 终端命令的 Agent，复制 [Agent 部署提示词](./DEPLOY_WITH_AGENT.md)。Agent 会调用项目正式脚本完成检查、资源创建或复用、备份、迁移、构建和部署，只在 Cloudflare 登录授权、Access 网页设置及网易扫码时请用户参与。

### 3. 按文档手动部署

希望完全掌握每一步，或需要排查问题时，请使用 [完整部署与运维指南](./DEPLOYMENT.md)。首版本地自动安装脚本正式支持 Windows；macOS/Linux 用户优先使用官方按钮。

三条路径调用同一套 migration 和部署程序，不维护三套业务实现。重新执行部署会复用已有 D1 和 `SESSION_ENCRYPTION_KEY`，不会因为本地项目被删除或重新下载而清空线上数据。

## 工作方式

每次同步先取得完整歌单成员和歌曲详情，再对疑似异常做同一次同步内的技术复核：

- 疑似 `missing`：重新读取完整成员，两份稳定快照都不存在才确认消失；
- 疑似 `grey`：只复查相关歌曲，两次都不可播放才确认变灰；
- 复核失败、成员集合变化或结果不完整：整次同步失败，既有状态不写入也不覆盖；
- 已确认异常后来恢复可播放：自动回到正常列表；
- 异常持续存在：保留到用户在页面点击“完成”。

因此真实异常会在当次完整复核后立即进入异常列表，不等待跨自然日确认。

首次打开网站时，用户依次完成“连接网易云 → 扫码登录 → 自动读取全部可访问歌单 → 选择一个歌单 → 自动建立基线”。已配置后可以：

- “重新授权”：同一网易 UID 无损替换加密会话；不同 UID 在新账号和新歌单完整验证成功前不会影响旧实例；
- “重绑歌单”：新基线成功后原子切换，失败时保留旧账号、旧歌单和旧历史。

网易会话会由定时任务加密复用，无需每天扫码。

## 架构与数据安全

- vinext/React 页面由 Workers Static Assets 提供，Hono API 在 Worker 中运行；
- D1 保存实例配置、歌曲状态、同步历史及加密后的网易会话；
- `SESSION_ENCRYPTION_KEY` 只保存在 Worker Secret，与 D1 分离；
- Cloudflare Workflow 执行同步，Cron Trigger 每天启动一次；
- Cloudflare Access 保护整个网站；Worker 还会验证 JWT 签名、issuer、Audience、精确邮箱和写请求来源；
- 网易登录只负责读取音乐账号，不能替代网站的 Cloudflare Access 身份认证；
- 未选中的歌单列表只在受保护响应中短暂传输，不长期保存。

线上代码、D1、Secret、Workflow、Cron、bindings 和 Access 都保存在部署者自己的 Cloudflare 账户中。部署成功后删除本地项目不会影响线上运行。完整的数据边界和密钥丢失处理见 [SECURITY.md](./SECURITY.md)。

## 本地开发

要求 Node.js `>=22.13.0`。项目不需要真实网易 UID 或歌单 ID写进配置：

```powershell
npm ci
Copy-Item .dev.vars.local.example .dev.vars
node -e "const b=crypto.getRandomValues(new Uint8Array(32)); console.log(Buffer.from(b).toString('base64'))"
```

把输出写入被 Git 忽略的 `.dev.vars` 中的 `SESSION_ENCRYPTION_KEY=`，然后运行：

```powershell
npm run db:migrate:local
npm run dev
```

本地仅在 `ALLOW_LOCAL_DEV=true` 且请求来自 loopback 时跳过 Access；生产公开模板固定为 `false`。

## 验证与更新

```powershell
npm run verify
npm run deploy:dry-run
```

生产部署程序会先构建，再按 `DB` binding 应用全部 D1 migration，最后发布 Worker。migration、Secret 查询或完整性检查失败时都会停止发布。现有数据库升级前应先导出备份，详细步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 文档

- [完整部署、Access、备份、恢复与卸载](./DEPLOYMENT.md)
- [通用 Agent 辅助部署入口](./DEPLOY_WITH_AGENT.md)
- [项目结构与开发指南](./PROJECT_GUIDE.md)
- [安全、隐私与漏洞报告](./SECURITY.md)
- [网易登录与歌单绑定设计](./NETEASE_LOGIN_AND_PLAYLIST_BINDING.md)
- [歌曲状态工作流](./MANAGED_SONGS_WORKFLOW.md)
- [未来开发方向](./FUTURE_DEVELOPMENT_DIRECTIONS.md)

## 限制与声明

本项目使用网易云音乐非公开 Web 接口，不使用官方 OAuth；接口、登录风控和返回结构可能变化。本项目是独立的非官方开源项目，与网易、网易云音乐及其关联公司没有隶属、授权、赞助或背书关系。部署者应自行评估平台条款、所在地区法律及账号风险。

## 许可证与依赖

项目采用 [MIT License](./LICENSE)。本次 `v0.1.0` 部署改造没有新增、升级、替换或删除 npm 依赖，`package-lock.json` 的依赖解析保持不变；生产仍发布完整 Worker 与 Static Assets。
