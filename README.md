# 拾针：网易云歌单防丢服务

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ZeroEthereal/needle-drop-archive)

“拾针”会持续保存同一网易账号下 1–20 个歌单及网易云盘的账号视角快照，记录歌曲消失、变灰和时长错配，并按设置发送邮件提醒。它不下载、上传或保存音乐文件。

Needle Drop Archive is a self-hosted Cloudflare application that monitors up to 20 NetEase Cloud Music playlists and personal cloud storage under one account. Each user deploys and owns an independent instance and its data.

当前版本坚持“一名用户部署一套实例，一个实例绑定一个网易账号”。同一账号可选择 1–20 个可访问歌单，包含自建、私密或收藏的他人歌单；新增监控的歌单必须非空。网易云盘随账号自动纳入监控，不占歌单名额。

## 三种部署方式

### 1. Deploy to Cloudflare（推荐，无需下载）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ZeroEthereal/needle-drop-archive)

在浏览器中完成 GitHub 与 Cloudflare 授权后，Cloudflare 会复制仓库、创建 D1、构建并部署 Worker、Static Assets、Workflow 和 Cron。部署表单中务必勾选 **“创建专用 Git 存储库”**：Cloudflare 会把实例的 D1 binding ID 写入复制后的仓库配置，使用私有仓库可以避免把该实例标识公开。

按钮部署完成后，还需在 Cloudflare 控制台启用一次 Access，并填写 `ALLOWED_EMAIL`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 三个变量。保存变量后，如果控制台只创建了新版本而没有自动切换流量，请到 **Deployments / Versions** 将该版本“提升”到 100% 流量。未完成这些步骤时网站保持锁定，不会显示个人数据。

> 如果一键部署提示“无法获取存储库内容”，请检查 GitHub 仓库是否可访问、授权状态及网络环境。共享出口的访问额度也可能影响仓库读取。可更换网络重试，或使用下面的 **Agent 辅助部署**。

### 2. 下载项目后让通用 Agent 辅助部署（Windows）

把项目下载到 Windows 电脑，打开能够执行 Windows 终端命令的 Agent，复制 [Agent 部署提示词](./DEPLOY_WITH_AGENT.md)。Agent 会调用项目正式脚本完成检查、资源创建或复用、迁移、构建和部署，只在 Cloudflare 登录授权、Access 网页设置及网易扫码时请用户参与。

### 3. 按文档手动部署

希望完全掌握每一步，或需要排查问题时，请使用 [完整部署与运维指南](./DEPLOYMENT.md)。本地自动安装脚本支持 Windows；macOS/Linux 用户优先使用官方按钮。

三条路径调用同一套 migration 和部署程序，不维护三套业务实现。重新执行部署会复用已有 D1 和 `SESSION_ENCRYPTION_KEY`，不会因为本地项目被删除或重新下载而清空线上数据。

## 推荐几个音乐资源站

- 歌曲宝：https://www.gequbao.com/
- gdstudio：https://music.gdstudio.xyz/
- openflac：https://www.openflac.com/

## 工作方式

每个歌单或云盘任务读取一份完整快照，校验成员、歌曲资料和当前账号的可播结果后直接对账：

- `missing`（消失）：已记录的歌曲不在当前完整成员列表中；
- `grey`（变灰）：歌曲仍在成员列表，但当前账号不可播放；
- `mismatch`（错配）：歌曲可播放，有效时长与该歌曲 ID 的固定基准不同，最小差异为 1 毫秒；
- 快照不完整或上游读取失败：该任务失败，不提交歌曲状态；其他任务已成功提交的结果保留；
- 歌曲重新出现且可播放时，按时长判断正常或错配；时长缺失时保留已有错配；
- 点击“完成”会删除该歌曲的共享资料及全部歌单、云盘引用；之后再次同步到该 ID 时按新歌曲建立基准。

异常在当次完整快照对账后生效。

首次打开网站时，用户依次完成“连接网易云 → 扫码登录 → 读取可访问歌单 → 勾选 1–20 个非空歌单 → 建立所选歌单基线”。云盘监控项随绑定创建，普通绑定不预先读取云盘基线，首次同步时建立。已配置后可以：

- “重新授权”：同一网易 UID 无损替换加密会话；不同 UID 在新账号整组歌单完整验证成功前不会影响当前实例；
- “管理监控歌单”：先为全部新增项建立基线，全部成功后原子更新选择；取消监控前会列出受影响歌单并要求确认。
- “从网易云重建基线”：确认后为当前账号本次选择的非空歌单及云盘获取新快照；整组成功才原子替换歌曲状态、待找回和已结束同步记录，读取失败不动原数据。

每天北京时间 03:17 会按歌单顺序同步，最后同步云盘；“同步状态”的按钮执行同样的全量流程，各歌单和云盘页的按钮只同步当前监控项。待找回按网易歌曲 ID 合并，汇总状态优先级为“消失 → 变灰 → 错配”，来源标签显示各自真实状态。

页面提供“待找回、同步状态、歌单歌曲、网易云盘”四个主入口，以及独立设置入口。同步历史显示北京时间最近 7 个自然日的已结束批次，每页 10 条；后台创建批次时清理超过 30 天的已结束记录。

设置中的邮件通知默认关闭。配置邮件发送服务后，可按变灰、消失、错配、待找回总数的阈值及自动同步失败启用通知；手动同步不发通知。网易会话会由同步任务加密复用，失效时需要重新授权。

## 架构与数据安全

- vinext/React 页面由 Worker 渲染，前端静态资源由 Workers Static Assets 提供，Hono API 在同一 Worker 中运行；
- D1 保存实例配置、歌曲状态、同步历史及加密后的网易会话；
- `SESSION_ENCRYPTION_KEY` 只保存在 Worker Secret，与 D1 分离；
- 一个批次协调 Workflow 顺序派发逐歌单 Workflow，Cron Trigger 每天启动一次全量批次；
- Workers Observability 默认保存全部 Worker 调用日志，便于在 Cloudflare 控制台按请求、响应和异常排查问题；
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

本地 loopback 请求在 `ALLOW_LOCAL_DEV` 不为字符串 `false` 时跳过 Access；开发示例显式设为 `true`，生产公开模板固定为 `false`。

## 验证与更新

```powershell
npm run verify
npm run deploy:dry-run
```

`npm run deploy:full` 构建后按 `DB` binding 应用尚未执行的 D1 migration、检查实例和 Secret，再发布 Worker；`npm run deploy` 复用已有构建。migration、Secret 查询或发布物身份检查失败时停止发布。业务数据以网易云为准，开发升级不要求历史数据留档；恢复操作见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 文档

- [完整部署、Access、恢复与卸载](./DEPLOYMENT.md)
- [通用 Agent 辅助部署入口](./DEPLOY_WITH_AGENT.md)
- [项目结构与开发指南](./PROJECT_GUIDE.md)
- [安全、隐私与漏洞报告](./SECURITY.md)

## 限制与声明

本项目使用网易云音乐非公开 Web 接口，不使用官方 OAuth；接口、登录风控和返回结构可能变化。本项目是独立的非官方开源项目，与网易、网易云音乐及其关联公司没有隶属、授权、赞助或背书关系。部署者应自行评估平台条款、所在地区法律及账号风险。

## 许可证与依赖

项目采用 [MIT License](./LICENSE)。依赖版本由 `package-lock.json` 锁定，运行、构建和验证依赖均需安装；生产发布完整 Worker、Static Assets、两个 Workflow 和 Cron，无需服务器端安装 npm 依赖。
