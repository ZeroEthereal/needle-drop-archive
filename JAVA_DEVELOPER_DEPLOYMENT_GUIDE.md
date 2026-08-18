# 旧部署指南迁移说明

本文件原先记录了特定电脑上的开发工具路径和旧版部署步骤，已经不适合作为开源项目的通用说明。为避免继续传播过期命令，部署文档现已统一到以下入口：

- 小白首选和三种路径总览：[README.md](./README.md)
- Windows/Cloudflare 完整手动步骤：[DEPLOYMENT.md](./DEPLOYMENT.md)
- 通用 Agent 辅助部署提示词：[DEPLOY_WITH_AGENT.md](./DEPLOY_WITH_AGENT.md)
- 开发者架构和代码说明：[PROJECT_GUIDE.md](./PROJECT_GUIDE.md)
- 数据与凭据边界：[SECURITY.md](./SECURITY.md)

正式部署不依赖任何固定盘符、IDE 或本机 SDK 路径。Windows 脚本只要求 Node.js、npm 和 npx 可以从 `PATH` 找到，并始终调用项目自己的部署程序。

## 依赖变更

此次文档迁移没有新增、升级、替换或删除依赖；`package.json` 的依赖区和 `package-lock.json` 的依赖解析不变。
