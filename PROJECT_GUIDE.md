# 拾针项目与开发指南

## 产品与数据原则

一个部署实例服务一名用户，绑定一个网易云账号，监控 1–20 个可访问歌单及该账号的网易云盘。新增歌单必须非空；已建立基线的歌单允许后来清空，云盘允许为空。业务数据以该账号当前网易云结果为依据。开发升级不要求历史数据留档、数据库导出或备份；需要重建时保留账号、监控选择、正式加密会话和 Worker Secret，重新取得完整基线。

结构、密钥和登录链路必须保持可用。同步不会修复错误的数据库结构或替换加密密钥。当前结果无法重建已经从歌单消失的历史记录。

## 技术结构

- vinext/React 由 Worker 渲染页面，Static Assets 承载前端静态资源，Hono 提供同源 API。
- D1 保存配置、共享歌曲资料、逐歌单状态、批次及加密会话。
- 一个批次 Workflow 顺序派发逐歌单 Workflow；同一逐歌单 Workflow 还负责待绑定歌单的基线准备。
- Cron 每天北京时间 03:17 创建全量批次，按歌单顺序执行后同步云盘；手动操作可创建全量、单歌单或云盘批次。
- Cloudflare Access 保护整个实例；Worker 校验 JWT、精确邮箱及写请求来源。

## 代码职责

| 模块 | 职责 |
|---|---|
| app/components/MusicVault.tsx | 页面数据载入、同步操作、扫码与轮询 |
| app/components/SyncHistory.tsx | 历史同步列表与按需刷新 |
| app/components/EmailNotificationSettings.tsx | 设置页邮件通知规则与保存 |
| worker/api.ts | HTTP 参数校验、状态汇总及任务创建 |
| worker/instance-config.ts | 当前账号与实例配置读取 |
| worker/auth-flows.ts、session-store.ts、secrets.ts | 扫码、会话加密及重新授权 |
| worker/workflow.ts、sync-batches.ts | 批次协调与逐歌单任务派发 |
| worker/multi-sync-runner.ts | 一个歌单或云盘的同步编排 |
| worker/playlist-set-binding.ts | 整组歌单基线准备与原子生效 |
| worker/email-notifications.ts、lib/email-notifications.ts | 自动同步后的邮件发送、规则及阈值校验 |
| lib/database-limit.ts | D1 每日配额错误识别与恢复时间 |
| lib/sync/db.ts | 公共 D1 数据库接口类型 |
| lib/sync/snapshot.ts | 网易账号快照到状态算法输入的转换 |
| lib/sync/state-machine.ts | 独立的逐歌单状态算法 |
| lib/sync/repository.ts | 唯一业务仓储，逐歌单提交、查询与完成操作 |
| lib/sync/song-storage.ts、storage.ts | 歌曲元数据及通用设置存储；网易会话由 worker/session-store.ts 管理 |
| lib/netease | 网易 Web 协议适配、完整分页及云盘匹配 |

## 数据库模型

数据库按文件顺序应用 `drizzle` 中全部迁移：`0000_current_schema.sql` 建立基础结构，`0001_cloud_monitoring.sql` 为已配置实例加入云盘监控项，`0002_song_duration_mismatch.sql` 增加固定时长基准和错配时长。时长迁移仅将有效的已有时长写入基准。已执行的迁移不重复执行，后续结构变更使用新迁移。

| 表 | 用途 |
|---|---|
| instance_config | 单例账号配置、绑定版本和实例状态；不保存某一个歌单的字段 |
| monitored_playlists | 歌单资料、排列和独立基线标志；云盘使用固定 ID netease-cloud |
| songs | 共享歌曲资料、首次身份、时长基准、错配观察信息、别名及译名 |
| playlist_song_states | 联合主键为歌单 ID 和歌曲 ID，保存状态、确认时间及歌单内位置 |
| sync_batches | 全量或单歌单同步批次及结果汇总 |
| sync_playlist_tasks | 批次内每个歌单的阶段、结果和错误 |
| pending_playlist_sets | 尚未生效的整组监控选择 |
| pending_playlist_baselines | 各待绑定歌单已验证的临时基线 |
| netease_auth_flows | 加密扫码挑战、授权状态与期限 |
| netease_sessions | 正式和临时加密会话，正式会话 ID 为 primary |
| settings | 二维码创建限速、邮件通知设置、规则触发状态和自动批次邮件处理记录 |
| d1_migrations | Wrangler 管理的已应用初始化和迁移记录 |

歌单资料与歌曲状态有外键约束。完成歌曲会删除共享歌曲资料，并级联删除所有歌单和云盘中的该歌曲引用；取消一个监控歌单只删除该歌单状态，仍被其他监控项引用的歌曲保留。

## 同步与基线

每次任务读取账号配置、正式会话、歌单成员和完整歌曲详情。首次基线由 monitored_playlists.baseline_established 明确决定；未建立基线的歌单直接从完整快照创建资料和状态，成功提交后设置标志。后续同步比较已保存的逐歌单状态。

每次对账使用一份通过完整性校验的快照。

- 消失：完整成员中缺少已记录的歌曲 ID。
- 变灰：歌曲仍在成员列表，当前账号无法播放。
- 错配：歌曲可播放，本次有效时长与该 ID 的固定基准相差至少 1 毫秒。已有歌曲沿用迁移时保存的有效时长，时长为空的歌曲使用首次取得的有效时长。歌名和歌手保留用于展示和找回。
- 恢复：歌曲重新出现且可播放时，按本次时长判定正常或错配。时长缺失时保留已有错配，其他状态继续按成员和播放结果更新。
- 不完整或风控：该歌单任务失败，歌曲状态保留上次成功结果。

歌名和歌手按该 ID 首次保存的身份保留；别名优先于译名显示，列表时长按毫秒向下取整为分秒。正常状态可更新专辑、封面及展示资料，错配和变灰保留原展示资料；时长缺失且已有错配证据时同样保留。歌曲顺序跟随上游，消失项保留原位置，其余成员跳过这些位置排列；完成歌曲释放全部来源中的位置。

歌单成员以完整 `trackIds` 为准：返回成员少于摘要数量时失败，成员多于摘要数量时使用成员列表并记录警告。歌曲资料依次使用标准详情、云盘详情和歌单内嵌详情；严格模式下仍缺资料就失败。云盘通过完整分页读取成员并归一歌曲 ID。可播结果必须包含每个请求 ID，且该项 `code=200`、`url` 非空才视为可播放；播放 URL 不离开适配器。

适配器通过 `lib/netease/index.ts` 导出 `NeteaseClient`、不透明会话及标准化类型，仅向 `music.163.com`、`interface.music.163.com` 的 `/api/` 路径发送请求。Cookie 保存在会话对象的 WeakMap 中，普通 JSON 序列化只返回脱敏信息；`serializeNeteaseSession()` 是交给 Worker 立即加密的明文边界，不能返回浏览器、记录日志或发送邮件。协议错误不能降级成歌曲不可播放；上游的元数据回退和 ID 归一属于当前有效协议处理。

歌曲资料、歌单状态、基线标志和任务成功结果在同一 D1 batch 中提交。全量同步逐歌单提交，一个歌单失败不撤销其他歌单已经成功的提交；账号级失败按当前批次规则停止剩余工作。

普通绑定先准备全部新增歌单，全部成功才使整组选择生效。云盘监控项随绑定创建，首次同步时建立基线。明确重建基线时，先为本次选择的全部歌单和云盘准备完整快照，再一次性替换状态。歌单基线准备在事务外完成，正式配置、歌曲状态、会话提升、已结束批次清理和临时记录删除在同一 D1 batch 中执行。

首次扫码或扫码得到不同 UID 时，会话暂存为加密待确认会话；整组歌单基线成功后才提升为正式会话。同 UID 重新授权直接替换加密会话并更新昵称、头像，保留绑定版本、歌单和业务记录。头像缺失或图片加载失败时显示音符图标，头像请求不携带来源页面信息。二维码 challenge 只在后端解密生成同源 SVG，不作为 API 参数或明文响应字段返回。

绑定事务以旧 `binding_version` 为条件，后续写入以新版本及 UID 保护。同步任务的状态提交和刷新会话同样要求绑定版本仍匹配。手动同步与正在准备或运行的绑定互斥；每日批次遇到正在执行的工作会等待，执行前按当前版本更新监控集合。歌单任务失败可重试，账号失效、UID 不符或风控会停止后续任务。

## HTTP 接口与页面

| 接口 | 行为 |
|---|---|
| GET /api/sync/status | 当前配置、登录记录、歌单统计、批次进度与异常汇总 |
| POST /api/sync | 无目标时全量同步；playlistId 指定歌单；source: "cloud" 指定云盘，两种目标不能同时传入 |
| GET /api/sync/history | 分页读取同步历史 |
| GET /api/recovery | 按网易歌曲 ID 合并的异常歌曲列表 |
| POST /api/recovery/:songId/complete | 完成异常歌曲，删除相关业务引用 |
| GET /api/likes | 当前监控歌单的歌曲、筛选和分页 |
| GET /api/cloud | 云盘歌曲、筛选和分页 |
| POST /api/netease/auth-flows | 创建加密扫码流程 |
| POST /api/netease/auth-flows/:id/poll | 检查扫码授权进度 |
| GET /api/netease/auth-flows/:id/qr | 同源二维码图像 |
| POST /api/netease/auth-flows/:id/cancel | 取消未进入活动绑定的登录流程 |
| POST /api/netease/playlists | 查询当前账号可选择的歌单 |
| POST /api/playlist-binding | 创建整组绑定或重建任务 |
| GET /api/settings/email-notifications | 邮件规则和发送服务可用状态 |
| PUT /api/settings/email-notifications | 校验并保存邮件通知设置 |

绑定接口接收 `playlistIds` 数组（1–20 个不重复的数字字符串），可带登录流程 `flowId`；取消监控需 `confirmedRemoval: true`，重建需 `freshBaseline: true` 和 `confirmedFreshBaseline: true`，且只能使用当前正式账号。新增或重建的歌单必须非空。

歌曲列表按 `state` 和 `query` 筛选；待找回按 `type`、`playlistId`、`query` 筛选，状态均支持消失、变灰和错配。待找回按歌曲 ID 合并，展示优先级为消失、变灰、错配；筛选匹配底层来源状态，来源筛选不裁掉该歌曲的其他异常标签。“最后正常”取异常上下文中最早的非空时间。搜索使用原歌名、歌手和专辑，不使用错配后的观察资料。完成操作在同步或绑定期间拒绝执行，已恢复正常的歌曲不会被删除。

主导航顺序为“待找回 → 同步状态 → 歌单歌曲 → 网易云盘”，设置有独立入口。歌单列表首次选中特殊类型 5 的“我喜欢的音乐”，否则按保存歌曲总数最大、网易列表顺序优先选择。切换歌单时作废上一个歌单的分页和搜索请求。

状态查询读取本站已保存结果，不触发网易全量同步。页面打开或恢复可见时刷新一次；只有同步、绑定或扫码在进行时每 2 秒查询，隐藏时暂停，空闲与结束时停止。历史列表在打开、恢复可见、批次结果变化、翻页或重试时刷新。完成歌曲后刷新异常列表、当前歌单列表和状态统计。

API 使用当前响应格式，页面仅映射该格式，并对无效值作安全降级。上游网易协议差异在 lib/netease 内适配。

同步历史接口只显示北京时间今天及前六个自然日的已结束批次，每页 10 条；只有批次成功、任务数量匹配且全部任务成功时才显示成功。创建批次时清理超过 30 天的已结束记录，调整监控集合时清除已结束批次。D1 每日配额耗尽时返回带恢复时间的 503 错误，页面显示对应提示。

## 邮件通知

规则保存在 `settings` 中，通知默认关闭；默认勾选“变灰达到 1 首”和同步失败提醒。每项歌曲阈值必须为正安全整数，启用时至少选择一项规则或失败提醒。发送需要 `NOTIFICATION_EMAIL` binding、有效的 `NOTIFICATION_EMAIL_FROM` 和 `ALLOWED_EMAIL`；收件人为实例允许邮箱。

只有每日自动批次检查邮件，手动同步不发邮件。批次失败时按设置发送失败监控项；全量成功时按当前去重异常统计检查变灰、消失、错配和待找回总数阈值。同一规则持续达到阈值只提醒一次，自动检查发现低于阈值后可再次触发，修改该规则或通知总开关也会重置相应触发状态。

每个每日批次先记录发送尝试再调用邮件服务，避免重复发送；发送失败不会自动重发，也不改变同步结果。异常提醒包含完整待找回名单；名单大于 64 KiB 时使用文本附件，大于 17 MiB 时尝试 gzip，压缩后仍超限则发送失败。邮件日志只记录事件、批次 ID 和安全错误代码。

## 安全与配置

SESSION_ENCRYPTION_KEY 只保存在 Worker Secret。D1 中的会话与扫码挑战使用 AES-GCM，加密值不返回前端。普通部署必须保留已有密钥；配置实例缺少密钥或查询失败时停止发布。密钥异常按 SECURITY.md 处理。

公开 wrangler.jsonc 不包含个人 Access 标识或 D1 UUID。真实配置放在被忽略的 wrangler.private.jsonc 或 Cloudflare 控制台。生产关闭本地认证跳过和预览入口。Worker 日志不得包含网易 Cookie、Secret、Access JWT 或加密载荷。

## 开发、验证与发布

Node.js 要求与 package.json 保持一致。依赖以 package-lock.json 为准，不在日常维护中自动升级。

使用 npm ci 安装，按 .dev.vars.local.example 配置本地测试会话密钥，再运行 npm run db:migrate:local 和 npm run dev。不要复制生产密钥到本地。

npm run verify 执行类型检查、Lint、现有测试、网易适配器自检和生产构建。验证还应覆盖首次基线、一次完整对账、毫秒级时长比较、空歌单、跨歌单状态、顺序、分页、完成操作及提交失败。

npm run deploy:full 从当前配置构建，验证发布物身份，应用当前迁移、检查实例与 Secret，再发布 Worker、Assets、Workflow 和 Cron。重复部署复用资源。需要数据重建时保持配置和正式登录，清空业务记录并标记基线未建立；手动或自动同步可建立当前基线。

项目只支持当前结构实例和全新安装。后续结构变化使用新的迁移文件；已应用当前初始化记录的数据库不会重复初始化。开发升级不自动创建业务数据备份，也不写入桌面留档。

操作指南见 [DEPLOYMENT.md](./DEPLOYMENT.md)，安全边界见 [SECURITY.md](./SECURITY.md)，部署提示词见 [DEPLOY_WITH_AGENT.md](./DEPLOY_WITH_AGENT.md)。项目级 Agent 开发指令统一放在根目录 `AGENTS.md`，与部署提示词分开维护。修改依赖时须明确说明版本、用途、清单和锁文件变化及发布影响；发布形式为完整 Worker、Static Assets、两个 Workflow 和 Cron，无需服务器端另装 npm 依赖。
