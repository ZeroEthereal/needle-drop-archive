# 使用 Agent 部署拾针（Windows）

这条路径适合不熟悉命令行、但已经使用 Codex、Claude Code 或其他能够在项目目录运行终端命令的编码 Agent 的用户。

Agent 只负责部署用户自己的 Cloudflare 实例。项目维护者不会取得用户的 Cloudflare、网易云或 D1 数据。

## 用户只需要做什么

1. 在 Windows 上安装 Node.js 22.13 或更高版本。
2. 下载或克隆本项目，并用编码 Agent 打开项目根目录。
3. 把下面整段提示词交给 Agent。
4. Cloudflare 登录页面出现时，由用户本人登录并授权。
5. 按 Agent 指引在 Cloudflare 中启用 Access，并填写自己的邮箱。
6. 部署完成后，用网易云音乐 App 扫码并选择一个歌单。

## 可直接复制的提示词

```text
请完整阅读项目根目录的 DEPLOY_WITH_AGENT.md 和 DEPLOYMENT.md，然后在 Windows 上帮助我把这个项目部署到我自己的 Cloudflare 账户。

必须遵守：
1. 不要修改网易登录、歌曲同步、D1 业务模型或页面业务代码。
2. 不要自行升级、增加或删除任何 npm 依赖。
3. 使用项目提供的 scripts/setup-cloudflare.ps1 和正式 npm scripts；不要临时发明另一套部署流程。
4. 真实 Cookie、SESSION_ENCRYPTION_KEY、Access Audience、团队域名、邮箱和 D1 UUID不得输出到聊天、日志或 Git。
5. 创建或复用云端资源前先告诉我资源名称；发现同名既有资源时复用，不要创建重复实例，也不要删除任何既有资源。
6. 需要我亲自完成 Cloudflare 登录、Access 网页设置、邮箱验证码或网易云扫码时再暂停。
7. migration、Secret 状态或备份检查失败时停止，不得绕过安全检查。
8. 最后运行项目验证，并只报告不含个人标识的结果：Worker、D1、Workflow、Cron、Secret 名称、Access 是否就绪，以及网站能否打开。

现在先检查环境和 Git 状态，然后执行安全部署。
```

## Agent 应执行的正式入口

```powershell
npm ci
.\scripts\setup-cloudflare.ps1 -SkipInstall
```

脚本会完成环境检查、D1 创建或复用、已有数据库桌面备份、全部 migration、Secret 安全初始化、构建、部署和 Access 收尾提示。发现同名 D1 时会要求用户确认复用；Agent 不得替用户猜测。已经由用户明确确认后，非交互重试才可增加 `-ReuseExisting -NonInteractive`。

如果 Agent 不能操作浏览器，用户按照 [DEPLOYMENT.md 的 Access 收尾](./DEPLOYMENT.md#cloudflare-access-收尾)完成网页操作，再把团队域名和 Audience 交给 Agent继续执行。不要把这些值发送到公开 Issue。

## 成功标准

- 网站只能由 Access 允许的邮箱进入；
- 页面可以生成网易云登录二维码；
- 扫码后可以选择歌单并建立首份基线；
- D1、Workflow 和每日 Cron 均属于用户自己的 Cloudflare 账户；
- 删除本地项目目录不会影响已经部署的实例。

## 依赖变更

本部署方案不新增、升级、替换或删除 npm 依赖。仍使用仓库锁定的完整 Worker + Static Assets 发布形式。
