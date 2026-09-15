# 网易登录与歌单绑定实现说明

## 用户流程

新实例在同步状态页点击“连接网易云”，扫码后自动读取当前账号全部可访问歌单。用户勾选 1–20 个非空歌单，后台逐歌单 Workflow 完整读取成员、歌曲详情和账号可播状态；只有整组基线验证成功，实例才切换为该账号和全部歌单。

已配置实例只提供两个账号相关操作：

- “重新授权”：同一 UID 无损替换加密会话、昵称和头像，保留歌单与全部历史；不同 UID 暂存为加密待确认会话，并进入新账号的歌单选择。
- “管理监控歌单”：使用当前正式会话重新列出歌单，预选当前集合。全部新增歌单建立基线后才原子加入，取消监控项二次确认后永久删除。任一新增基线失败时，原选择和状态不变。
- “从网易云重建基线”：当前账号全部已选非空歌单都重新读取并复核；确认后启动临时基线，整组成功才一次性替换旧歌曲状态、待找回及旧同步记录。任一歌单失败时正式数据不变。

当前数据模型只支持一个实例、一个网易账号，但可监控 1–20 个歌单。完整状态、同步和页面规则见 `MULTI_PLAYLIST_MONITORING.md`。

## 会话卡片头像展示

旧逻辑只在同步状态页的网易云会话卡片中显示固定音符图标，虽然账号头像已经随登录资料保存并由状态接口返回，界面并未使用该字段。

新逻辑在账号头像地址存在且图片加载成功时显示网易云头像，并禁止图片请求携带来源页面信息；地址缺失或图片加载失败时继续显示原音符图标。该展示直接复用现有 `profile.avatarUrl` 数据，不额外请求账号接口，也不改变授权、会话保存、同步或歌单绑定流程。

## 数据与隐私边界

| 数据 | 保存位置 | 说明 |
| --- | --- | --- |
| 正式账号与版本 | D1 `instance_config` | 单例记录，包含 `binding_version` |
| 监控歌单元数据 | D1 `monitored_playlists` | 固定表，记录各歌单基线建立标志和网易列表顺序 |
| 正式与短期待确认网易会话 | D1 `netease_sessions` | Cookie 先以 Worker Secret 中的密钥执行 AES-256-GCM 加密 |
| 二维码 challenge | D1 `netease_auth_flows` | 只保存密文；不进入响应、URL 或日志，结束或过期后删除 |
| 待调整进度与临时基线 | D1 `pending_playlist_sets`、`pending_playlist_baselines` | 只保存目标集合、版本、Workflow ID、基线和安全错误信息 |
| 歌曲与逐歌单状态 | D1 `songs`、`playlist_song_states` | 同一歌曲资料可被多个歌单引用，状态按联合主键独立保存 |
| `SESSION_ENCRYPTION_KEY` | Worker Secret | 绝不写入 D1 或受 Git 跟踪文件 |
| Access、D1 和 Workflow 配置 | Cloudflare Worker 变量与 binding | 在访问 D1 之前已经需要；按钮路径保存在 Cloudflare，Windows 本地路径可保存在被 Git 忽略的 `wrangler.private.jsonc`，不迁入 D1 |

未选中的歌单只在分页 API 响应中短暂出现，不长期保存。网易登录只用于读取音乐账号；网站访问身份仍由 Cloudflare Access 独立验证。

## 原子切换与并发保护

歌单集合 Workflow 先在 D1 事务外依次完成全部新增项的上游读取和完整性验证，再通过一次 D1 `batch()`：

1. 以旧 `binding_version` 为条件更新正式配置并递增版本；
2. 保留继续监控歌单的状态，删除取消监控项；切换账号时删除旧账号的歌单状态；
3. 写入全部新增项的共享歌曲资料与逐歌单基线；
4. 必要时把待确认会话提升为 `primary`；
5. 删除待确认集合、临时基线、会话和登录流程。

后续语句都用账号 UID 和新版本作为事务内保护条件。第一条条件更新未命中时，任何删除和写入都不会发生。D1 `batch()` 任一语句失败会回滚整个批次，随后仅把待集合任务标记为失败。

逐歌单同步在启动时捕获 `binding_version`。歌曲提交、成功记录和刷新后的正式会话都要求版本仍匹配；集合变更后才完成的旧 Workflow 会以配置变化结束，不能覆盖新歌单或新账号会话。

## 旧私有实例迁移

迁移 `0005_instance_playlist_binding.sql` 只创建新表和版本字段，不删除任何歌曲、异常、同步历史或正式会话。部署后的第一次状态读取或同步会在新配置仍为空时，把旧 Worker 变量中的 UID、歌单 ID 和 `settings.netease_profile` 迁入 `instance_config`，设置 `binding_version = 1`，随后删除旧 profile 设置。这个兼容桥只用于现有私有实例；迁移完成后旧 UID/歌单变量可从 Worker 配置移除，公开模板不再提供这些回退值。

公开仓库只跟踪不含个人标识和资源 UUID 的自动资源配置 `wrangler.jsonc`。Deploy to Cloudflare 在用户自己的账户中配置 D1 binding，Access 标识由用户写入 Cloudflare Worker 变量；Windows 脚本则优先读取被 `.gitignore` 忽略的 `wrangler.private.jsonc`。两条路径都不会把 D1 UUID、Access 域名、Audience 或允许邮箱写入公开 Git 历史，本地目录删除后也不影响已经部署到 Cloudflare 的资源。

删除本地项目不会影响线上运行：代码已经部署在 Worker，业务数据在 D1，加密钥匙在 Worker Secret，Access 与资源 binding 在 Cloudflare。

## 发布前检查

- 先备份远程 D1，再应用迁移；比较迁移前后的歌曲数、异常数、同步历史数和正式会话数。
- 在当前私有实例演练同账号重新授权，确认绑定版本、歌单和历史不变。
- 再演练一次重绑；确认新基线成功前旧数据不变，成功后一次性切换。
- 完成远程验证后再清理受跟踪配置和 Git 历史中的个人标识。

## 依赖变更

- 依赖变更：无。
- 未新增、升级、替换或删除 npm 依赖。
- `package.json` 的依赖区和 `package-lock.json` 不变。
- `package.json` 的项目脚本复用正式迁移、Secret 检查和部署包装器，并在 Wrangler 运行期间临时隐藏本地 `.dev.vars`；这不是依赖变更，`package-lock.json` 的依赖解析不变。
- 当前 Node.js、vinext、Hono、Cloudflare Vite 插件、Wrangler 与 Worker 运行时组合保持兼容。
- 发布形式仍为完整 Worker + Static Assets + Workflow；无需服务端安装，也不改变项目现有完整发布包流程。
