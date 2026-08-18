# 安全、隐私与漏洞报告

“拾针”采用“一名用户部署一套 Cloudflare 实例”的模式。每个实例只绑定一个 Cloudflare Access 用户、一个网易云账号和一个歌单；项目维护者不提供集中服务器，也不会代替部署者持有账号数据。

## 数据保存边界

| 数据 | 保存位置 | 保护方式 | 是否应进入 Git |
| --- | --- | --- | ---: |
| 网易登录 Cookie | D1 `netease_sessions` | Worker 使用 AES-256-GCM 和随机 nonce 加密后保存 | 否 |
| Cookie 解密密钥 | Cloudflare Worker Secret `SESSION_ENCRYPTION_KEY` | 与 D1 分离，Cloudflare 控制台和 Wrangler 不回显其值 | 否 |
| 网易 UID、昵称、头像 | D1 `instance_config` | D1 持久化；应用层按普通账号元数据保存 | 否 |
| 当前歌单 ID、名称、封面和所有者 | D1 `instance_config` | D1 持久化 | 否 |
| 歌曲、异常状态和同步历史 | D1 `songs`、`managed_songs`、`sync_runs` | D1 持久化 | 否 |
| 二维码 challenge | D1 `netease_auth_flows` | AES-256-GCM 密文，登录完成、取消或过期后清理 | 否 |
| 待确认会话与重绑进度 | D1 `netease_sessions`、`pending_playlist_bindings` | 会话加密；目标账号和歌单元数据按普通字段保存 | 否 |
| Access 允许邮箱、团队域名和 Audience | Cloudflare Worker 变量及本地 `wrangler.private.jsonc` | 私有实例配置 | 否 |
| D1 UUID | Cloudflare binding 及本地 `wrangler.private.jsonc` | 私有实例标识 | 否 |
| 未选中的歌单列表 | 登录后的受保护 API 响应 | 只短暂传输，不长期保存 | 否 |

D1 中只有网易 Cookie 和二维码 challenge 额外进行应用层加密。UID、昵称、歌单元数据和歌曲集合虽然不是登录凭据，但仍属于个人数据；能够管理该 Cloudflare 账户的人可以查询这些字段。

删除本地项目目录不会影响已部署实例：代码在 Worker，业务数据在 D1，密钥在 Worker Secret，Access、Workflow、Cron 和 bindings 在 Cloudflare。删除 Cloudflare 资源则是另一回事，会导致对应线上能力或数据消失。

## 不会进入公共仓库的配置

公共仓库只跟踪可直接用于自动资源配置的 `wrangler.jsonc` 和本地开发示例 `.dev.vars.local.example`。公开 Wrangler 模板不包含 D1 UUID、Access 邮箱、团队域名、Audience 或网易个人标识，只保留安全的 `ALLOW_LOCAL_DEV=false`。以下本地内容已由 `.gitignore` 排除：

- `.dev.vars` 与其他 `.env*` 文件；
- `wrangler.private.jsonc`；
- `.wrangler/` 本地状态和日志；
- `dist/`、`.next/`、`.vinext/` 等构建产物；
- 本地覆盖文件、缓存、调试日志和依赖目录。

Deploy to Cloudflare 会为新实例自动配置 D1 binding，并把实际 binding ID 写入用户复制后的 Git 仓库配置。因此按钮部署时必须勾选 **“创建专用 Git 存储库”**；该 ID 不是凭据，但属于实例私有标识，不应公开。后续通过 Git 构建部署时，公开配置中的 `keep_vars=true` 会保留用户在 Cloudflare 控制台设置的 Access 变量。Windows 辅助部署则把资源 ID 和 Access 标识写入被忽略的 `wrangler.private.jsonc`。

正式部署程序查询 Secret 时只读取名称，不读取或输出值。全新且没有业务配置的实例缺少 `SESSION_ENCRYPTION_KEY` 时，程序会生成 32 字节随机密钥，通过短期 secrets 文件上传，并立即删除文件；已有 Secret 永远复用。数据库已存在业务配置但 Secret 缺失，或 Secret 查询失败时，部署会失败关闭，不会擅自覆盖密钥。

部署前仍应执行 `git status`、受跟踪文件扫描和 Git 历史扫描。`.gitignore` 只能阻止尚未跟踪的文件被普通 `git add` 加入，不能自动抹掉已经提交过的 Secret。

## 严禁提交到 Issue、讨论区或日志的内容

不要在 GitHub Issue、Discussion、Pull Request、截图、CI 日志或公开聊天中提交：

- 网易 Cookie，尤其是 `MUSIC_U`、`MUSIC_A`、`__csrf` 等字段；
- `SESSION_ENCRYPTION_KEY` 或任何旧密钥；
- 二维码 challenge、尚未完成的登录二维码或完整登录响应；
- `.dev.vars`、`wrangler.private.jsonc`、D1 完整导出文件；
- Cloudflare API Token、Access JWT、Access Audience、团队域名；
- 不必要的真实邮箱、网易 UID、歌单 ID、昵称和头像；
- 包含上述内容的 Wrangler 输出、网络抓包、浏览器存储或 Cloudflare 日志。

复现问题时应使用虚构 ID、删减后的结构、错误代码和不含上游正文的日志。仅仅把 Cookie 中间几位替换为星号通常不够安全，优先完全移除整个字段。

## 私密报告安全问题

正式公开仓库应启用 GitHub Private vulnerability reporting。请从仓库的 **Security → Report a vulnerability** 私密提交，不要先开公开 Issue。

报告应包含：

1. 受影响版本或 commit；
2. 不含真实凭据的最小复现步骤；
3. 可能影响的数据和攻击前提；
4. 建议修复方向；
5. 是否已经在公开渠道披露。

如果仓库暂未提供私密报告入口，请不要发送 Cookie、Secret 或 D1 数据；等待维护者开通私密渠道后再提交完整细节。

## `SESSION_ENCRYPTION_KEY` 丢失或泄露

### 只丢失本地副本

如果线上 Worker Secret 仍然存在，只是本地没有保存副本，在线实例会继续正常运行，普通重新部署也不会删除已有 Secret。不要因为本地找不到密钥就生成新值并覆盖线上 Secret。

### 线上 Secret 被删除或覆盖

旧网易会话密文无法恢复，但歌曲基线和历史不需要删除：

1. 先导出并备份远程 D1；
2. 不要删除 `instance_config`、`songs`、`managed_songs` 或 `sync_runs`；
3. 清理 `pending_playlist_bindings`、`netease_auth_flows` 和 `netease_sessions` 中无法解密的会话流程；
4. 生成新的 32 字节随机密钥，并通过 `wrangler secret put SESSION_ENCRYPTION_KEY` 保存；
5. 打开网站执行“重新授权”，重新建立加密会话；
6. 手动同步一次，确认原歌单和历史仍然存在。

清理顺序必须先处理待绑定记录，再处理认证流程和会话，以满足 D1 外键约束。执行任何恢复 SQL 前都应先备份数据库。

### 怀疑密钥或 Cookie 已泄露

先在网易云官方账号安全入口撤销相关登录态，再更换 Worker Secret，并按上述流程仅重建会话。不要通过清空整个 D1 解决会话泄露问题。

## Cloudflare Access

Cloudflare Access 和网易扫码是两套独立身份：

- Access 决定谁能进入管理网站；
- 网易会话决定后台读取哪个音乐账号。

生产实例必须保持 `ALLOW_LOCAL_DEV=false`，Access policy 只允许实例所有者的精确邮箱，并关闭未受同等策略保护的预览入口。Worker API 还会验证 Access JWT 的签名、issuer、Audience 和邮箱，并对写请求校验同源 `Origin` 与 `X-Requested-With`。

## 上游接口与非隶属声明

本项目使用网易云音乐的非公开 Web 接口，不使用官方 OAuth，也没有可限制为只读的授权 scope。接口、登录策略、风控和返回结构可能随时变化；不完整的上游结果会使本次同步失败，而不是覆盖既有快照。

本项目是独立的非官方开源项目，与网易、网易云音乐及其关联公司没有隶属、授权、赞助或背书关系。部署者应自行评估其所在地区的法律、平台条款和账号风险，不得使用本项目下载、分发或规避版权保护。

## 支持范围

以仓库最新正式 GitHub Release 为主要审计和支持对象；旧版本可能要求先升级后再提供修复。
