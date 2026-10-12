# 拾针项目与开发指南

## 产品与数据原则

一个部署实例服务一名用户，绑定一个网易云账号，可监控 1–20 个可访问歌单。业务数据以该账号和所选歌单的当前网易云结果为依据。开发升级不要求历史数据留档、数据库导出或备份；需要重建时保留账号、监控选择、正式加密会话和 Worker Secret，重新取得完整基线。

结构、密钥和登录链路必须保持可用。同步不会修复错误的数据库结构或替换加密密钥。当前结果无法重建已经从歌单消失的历史记录。

## 技术结构

- vinext/React 提供页面，Static Assets 承载前端资源，Hono 提供同源 API。
- D1 保存配置、共享歌曲资料、逐歌单状态、批次及加密会话。
- 一个批次 Workflow 顺序派发逐歌单 Workflow；同一逐歌单 Workflow 还负责待绑定歌单的基线准备。
- Cron 每天北京时间 03:17 创建全量批次；手动操作可创建全量或单个歌单批次。
- Cloudflare Access 保护整个实例；Worker 校验 JWT、精确邮箱及写请求来源。

## 代码职责

| 模块 | 职责 |
|---|---|
| app/components/MusicVault.tsx | 页面数据载入、同步操作、扫码与轮询 |
| app/components/SyncHistory.tsx | 历史同步列表与按需刷新 |
| worker/api.ts | HTTP 参数校验、状态汇总及任务创建 |
| worker/instance-config.ts | 当前账号与实例配置读取 |
| worker/auth-flows.ts、session-store.ts、secrets.ts | 扫码、会话加密及重新授权 |
| worker/workflow.ts、sync-batches.ts | 批次协调与逐歌单任务派发 |
| worker/multi-sync-runner.ts | 一个歌单的同步编排 |
| worker/playlist-set-binding.ts | 整组歌单基线准备与原子生效 |
| worker/snapshot-verifier.ts | 同一次同步内复核疑似异常 |
| lib/sync/db.ts | 公共 D1 数据库接口类型 |
| lib/sync/snapshot.ts | 网易账号快照到状态算法输入的转换 |
| lib/sync/state-machine.ts | 独立的逐歌单状态算法 |
| lib/sync/repository.ts | 唯一业务仓储，逐歌单提交、查询与完成操作 |
| lib/sync/song-storage.ts、storage.ts | 歌曲元数据、会话及设置存储 |
| lib/netease | 网易 Web 协议适配、完整分页及云盘匹配 |

## 数据库模型

初始化文件为 drizzle/0000_current_schema.sql，直接建立当前结构。

| 表 | 用途 |
|---|---|
| instance_config | 单例账号配置、绑定版本和实例状态；不保存某一个歌单的字段 |
| monitored_playlists | 监控选择、歌单资料、排列和独立基线标志 |
| songs | 共享歌曲资料、首次身份、错配观察信息、别名、译名及长度 |
| playlist_song_states | 联合主键为歌单 ID 和歌曲 ID，保存状态、确认时间及歌单内位置 |
| sync_batches | 全量或单歌单同步批次及结果汇总 |
| sync_playlist_tasks | 批次内每个歌单的阶段、结果和错误 |
| pending_playlist_sets | 尚未生效的整组监控选择 |
| pending_playlist_baselines | 各待绑定歌单已验证的临时基线 |
| netease_auth_flows | 加密扫码挑战、授权状态与期限 |
| netease_sessions | 正式和临时加密会话，正式会话 ID 为 primary |
| settings | 页面操作需要的短期设置，例如二维码创建限速 |
| d1_migrations | Wrangler 管理的已应用初始化和迁移记录 |

歌单资料与歌曲状态有外键约束。完成歌曲会删除共享歌曲资料，并级联删除所有歌单中的该歌曲引用；取消一个监控歌单只删除该歌单状态，仍被其他歌单引用的歌曲保留。

## 同步与基线

每次任务读取账号配置、正式会话、歌单成员和完整歌曲详情。首次基线由 monitored_playlists.baseline_established 明确决定；未建立基线的歌单直接从完整快照创建资料和状态，成功提交后设置标志。后续同步比较已保存的逐歌单状态。

- 消失：再次读取完整成员，两份稳定结果均不包含歌曲才确认。
- 变灰：复查相关歌曲，两次均不可播放才确认。
- 错配：复查歌曲名称和歌手身份，稳定变化才确认；保留最初身份供找回使用。
- 不完整、风控或复核失败：该歌单任务失败，不提交部分歌曲状态。
- 恢复：再次确认正常后，自动清除该歌单异常状态。

歌曲资料、歌单状态、基线标志和任务成功结果在同一 D1 batch 中提交。全量同步逐歌单提交，一个歌单失败不撤销其他歌单已经成功的提交；账号级失败按当前批次规则停止剩余工作。

绑定时先准备全部新增歌单，全部成功才使整组选择生效。重新授权同一账号只更新会话。更换账号或明确重建基线时按整组绑定流程替换业务状态。

## HTTP 接口与页面

| 接口 | 行为 |
|---|---|
| GET /api/sync/status | 当前配置、登录记录、歌单统计、批次进度与异常汇总 |
| POST /api/sync | 创建全量或指定歌单的同步批次 |
| GET /api/sync/history | 分页读取同步历史 |
| GET /api/recovery | 按网易歌曲 ID 合并的异常歌曲列表 |
| POST /api/recovery/:songId/complete | 完成异常歌曲，删除相关业务引用 |
| GET /api/likes | 当前监控歌单的歌曲、筛选和分页 |
| POST /api/netease/auth-flows | 创建加密扫码流程 |
| POST /api/netease/auth-flows/:id/poll | 检查扫码授权进度 |
| GET /api/netease/auth-flows/:id/qr | 同源二维码图像 |
| POST /api/netease/playlists | 查询当前账号可选择的歌单 |
| POST /api/playlist-binding | 创建整组绑定或重建任务 |

状态查询读取本站已保存结果，不触发网易全量同步。页面打开或恢复可见时刷新一次；只有同步、绑定或扫码在进行时每 2 秒查询，隐藏时暂停，空闲与结束时停止。历史列表在打开、恢复可见、批次结果变化、翻页或重试时刷新。完成歌曲后刷新异常列表、当前歌单列表和状态统计。

API 使用当前响应格式，页面仅映射该格式，并对无效值作安全降级。上游网易协议差异在 lib/netease 内适配。

## 安全与配置

SESSION_ENCRYPTION_KEY 只保存在 Worker Secret。D1 中的会话与扫码挑战使用 AES-GCM，加密值不返回前端。普通部署必须保留已有密钥；配置实例缺少密钥或查询失败时停止发布。密钥异常按 SECURITY.md 处理。

公开 wrangler.jsonc 不包含个人 Access 标识或 D1 UUID。真实配置放在被忽略的 wrangler.private.jsonc 或 Cloudflare 控制台。生产关闭本地认证跳过和预览入口。Worker 日志不得包含网易 Cookie、Secret、Access JWT 或加密载荷。

## 开发、验证与发布

Node.js 要求与 package.json 保持一致。依赖以 package-lock.json 为准，不在日常维护中自动升级。

使用 npm ci 安装，按 .dev.vars.local.example 配置本地测试会话密钥，再运行 npm run db:migrate:local 和 npm run dev。不要复制生产密钥到本地。

npm run verify 执行类型检查、Lint、现有测试、网易适配器自检和生产构建。新版测试直接使用当前初始化结构，不通过历史版本建表。验证还应覆盖首次基线、异常复核、空歌单、跨歌单状态、顺序、分页、完成操作及提交失败。

npm run deploy:full 从当前配置构建，验证发布物身份，应用当前迁移、检查实例与 Secret，再发布 Worker、Assets、Workflow 和 Cron。重复部署复用资源。需要数据重建时保持配置和正式登录，清空业务记录并标记基线未建立；手动或自动同步可建立当前基线。

项目只支持当前结构实例和全新安装。后续结构变化使用新的迁移文件；已应用当前初始化记录的数据库不会重复初始化。开发升级不自动创建业务数据备份，也不写入桌面留档。

操作指南见 DEPLOYMENT.md，账号与绑定见 NETEASE_LOGIN_AND_PLAYLIST_BINDING.md，多歌单规则见 MULTI_PLAYLIST_MONITORING.md。修改依赖时须明确说明版本、用途、清单和锁文件变化及发布影响；发布形式为 Worker、Static Assets、两个 Workflow 和 Cron。
