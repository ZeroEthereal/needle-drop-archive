# Workers Observability 与日志说明

## 旧逻辑（本需求开始前的固定基线）

项目没有在 Wrangler 配置中启用 Workers Observability。Cloudflare 仍提供聚合指标和实时 `wrangler tail`，但不会为项目保存可在控制台回查的逐次 Worker 调用日志；问题发生后，如果没有同时开启实时日志，就无法按发生时间还原对应请求。

## 新逻辑

公开部署模板 `wrangler.jsonc` 默认启用 Workers Observability，并将 `head_sampling_rate` 设为 `1`。每次全新部署都会以 100% 采样保存 Worker 调用日志，包括请求和响应元数据、执行结果、资源耗时、未捕获异常，以及 Worker 主动输出的结构化 `console` 日志。

本功能用于诊断，不改变页面、API、D1、Workflow、Cron、Access 或网易云同步行为，也不会修复浏览器网络中断。日志只覆盖到达 Worker 的请求，不补录启用前的历史，不引入旧版私有配置迁移逻辑。

## 三种部署方式

| 部署方式 | 配置继承方式 | 额外操作 |
| --- | --- | --- |
| Deploy to Cloudflare | Cloudflare 从 GitHub 仓库读取 `wrangler.jsonc` | 无 |
| Agent 辅助部署 | `bootstrap-cloudflare.ps1` 以 `wrangler.jsonc` 为模板生成私有配置 | 无 |
| 完整手动部署 | 构建和 Wrangler 部署读取公开或生成后的私有配置 | 无 |

## 日志范围与隐私

Cloudflare 会保存调用日志以及 Worker 中的 `console` 输出。项目不得记录网易 Cookie、Access JWT、Secret、邮箱或其他身份凭据。当前自定义运行日志仅在网易请求失败时记录端点、错误分类、HTTP/API 状态、是否可重试和错误摘要。

Cloudflare 免费 Workers 套餐当前包含每天 200,000 条日志并保留 3 天；付费 Workers 套餐包含每月 2,000 万条日志并保留 7 天。当前项目流量适合完整采样；扩大流量后可根据 [Cloudflare Workers Logs 文档](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) 调低 `head_sampling_rate`。

## 实现文件

- `wrangler.jsonc`：公开配置源，为所有全新部署启用 Observability。
- `DEPLOYMENT.md`：记录运维入口、日志能力、保留期与隐私要求。
- `DEPLOY_WITH_AGENT.md`：将 Observability 纳入 Agent 部署验收范围。
- `README.md`：在架构能力和文档入口中公开本功能。

## 可复用验证方法

1. 运行 `npm run deploy:dry-run`，确认 Wrangler 能读取配置并生成完整部署产物。
2. 检查生成的 `dist/server/wrangler.json`，确认其中包含 `observability.enabled: true` 和 `head_sampling_rate: 1`。
3. 完成部署并访问一个 `/api/*` 接口，然后在 Cloudflare 的 **Workers & Pages → 当前 Worker → Observability** 查询该调用。
4. 用不存在的请求路径验证筛选条件能区分正常响应和错误响应，但不要为了测试输出凭据或个人数据。

## 依赖变更

- 依赖名称与版本：无变更。
- 用途：Observability 是 Cloudflare Worker 的平台配置，不需要 npm 运行库。
- 兼容性：项目锁定的 Wrangler `4.112.0` 与当前配置 schema 均支持该字段。
- Manifest 与锁文件：`package.json`、`package-lock.json` 均不修改。
- 部署产物：配置随 Worker 部署元数据发布，不新增前端或 Worker 运行时代码。
- 发布方式：继续按项目既有流程发布完整 Worker 与 Static Assets；无需安装服务器端依赖或改用其他发布包。
