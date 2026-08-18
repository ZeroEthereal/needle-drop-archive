# “一张活动歌曲表”工作流设计

“一张活动歌曲表”的核心意思是：

> 系统当前还在管理的每个网易云歌曲 ID，只允许在数据库中存在一行；这一行自己注明目前属于“正常”还是“异常”。

它不是把歌曲资料、异常信息全部塞进一个大字段，而是由两张职责清晰的表配合。

## 1. 两张核心表分别负责什么

### `songs`：歌曲资料表

只保存歌曲是什么：

```text
song_id
歌名
歌手
专辑
封面
网易云链接
```

它不负责判断正常、变灰或消失。

### `managed_songs`：活动歌曲表

保存歌曲目前是否仍被系统管理，以及属于哪个状态：

```text
song_id                         主键，保证每个网易云 ID 只有一行
bucket                          normal 或 anomaly
anomaly_type                    grey、missing 或 null
first_seen_at                   首次纳入时间
last_seen_at                    最近一次同步看见时间
last_playable_at                最近一次确认可播放的时间
confirmed_at                    正式确认异常的时间
updated_at                      更新时间
```

`managed_songs.song_id` 是主键，因此数据库本身不允许同一个网易云 ID 出现两行。

这就从根本上保证：

```text
歌曲 A 不可能同时属于正常和异常
```

所谓“正常表”和“异常表”，就是对这张表的两种查询：

```sql
-- 正常表
WHERE bucket = 'normal'

-- 异常表
WHERE bucket = 'anomaly'
```

页面看起来仍然可以是两个列表，区别只是后台没有复制两份数据。

---

## 2. 第一次建立基线

假设网易云当前有歌曲 A、C、D。

同步后：

`songs`：

```text
A 的歌曲资料
C 的歌曲资料
D 的歌曲资料
```

`managed_songs`：

```text
A | normal
C | normal
D | normal
```

此时统计：

```text
歌单歌曲 = 3
正常播放 = 3
变灰 = 0
消失 = 0
```

---

## 3. 新增歌曲

你在网易云收藏歌曲 B。

下一次同步发现：

```text
网易云有 B
managed_songs 没有 B
```

系统在同一个事务里执行：

```text
向 songs 写入 B 的歌曲资料
向 managed_songs 插入 B，bucket = normal
```

结果：

```text
A | normal
B | normal
C | normal
D | normal
```

这就是“把 B 纳入正常表管理”。

无论 B 是否为了替代 A，系统都不关心。A 和 B 是两个网易云 ID，两者完全独立。

---

## 4. 同步发现歌曲 A 变灰

第一次播放查询发现 A 当前拿不到播放地址。Workflow 只对这些疑似灰歌再次查询账号级播放状态。

如果第二次仍不可播放，系统在本次同步中直接更新 A 的同一行：

```text
song_id = A
bucket = anomaly
anomaly_type = grey
confirmed_at = 本次观察时间
```

如果第二次已经恢复播放，A 保持 `normal`；如果复核失败或结果不完整，整次同步失败，不写入任何歌曲状态。

统计仍然是：

```text
歌单歌曲 = 正常播放 + 变灰 + 消失
```

观察和确认都在同一次同步中完成，不依赖用户再次点击同步。

---

## 5. 变灰确认后的结果

两次播放查询都确认 A 无法播放后，系统更新的仍是 A 的同一行：

```text
bucket: normal → anomaly
anomaly_type: null → grey
```

这就是“从正常表移动到异常表”。

由于没有插入第二行，因此不存在转移过程中产生重复数据的风险。

结果：

```text
A | anomaly | grey
B | normal
C | normal
D | normal
```

统计：

```text
歌单歌曲 = 4
正常播放 = 3
变灰 = 1
消失 = 0
```

页面：

- “待找回”查询到 A；
- “歌单歌曲”也查询到 A，并标注“已变灰”；
- 正常歌曲查询不会把 A 当成正常播放；
- 所有查询合并后 A 仍然只有一份。

---

## 6. 歌曲 A 消失

第一次完整歌单快照中没有 A 时，Workflow 会再次读取完整成员。只有两次成员集合完全一致且 A 仍然不存在，才在本次同步中更新：

```text
A | anomaly
anomaly_type = missing
```

如果两次成员集合发生变化、第二次重新出现 A，或复核请求失败，整次同步不写入歌曲状态。

统计随之从：

```text
正常播放 -1
消失 +1
```

但“歌单歌曲”总数不变，因为 A 仍然是你尚未处理的歌曲。

页面“歌单歌曲”也会继续显示 A，并明确标注“已消失”。

---

## 7. 你人工找回歌曲

按照你描述的流程：

1. 找到音频 B；
2. 上传 B 到网易云云盘；
3. 收藏 B；
4. 删除旧的变灰歌曲 A；
5. 回到网站点击 A 的“完成”。

A 和 B 始终没有任何绑定关系。

### 如果先同步，再点击完成

同步发现 B 是新的网易云 ID：

```text
插入 B | normal
```

A 保持：

```text
A | anomaly | grey
```

此时暂时是：

```text
A 是异常歌曲
B 是正常歌曲
```

点击 A 的“完成”后：

```text
删除 managed_songs 中的 A
删除 songs 中已经没有引用的 A
```

B 完全不受影响。

最终：

```text
B | normal
```

### 如果先点击完成，再同步

点击后先删除 A：

```text
managed_songs 中没有 A
songs 中也删除 A
```

此时 A 在正常和异常中都不存在。

下一次同步发现 B：

```text
插入 songs 的 B
插入 managed_songs 的 B | normal
```

最终结果完全相同。

所以处理顺序确实不重要。

---

## 8. 你主动删除歌曲

假设你主动从网易云删除歌曲 A。

系统在同一次同步内取得两份一致的完整成员快照后立即确认为：

```text
A | anomaly | missing
```

你在网站点击“完成”：

```text
删除 managed_songs 中的 A
删除 songs 中的 A
```

因为你不会重新收藏它，后续快照中也没有 A，所以系统不会再创建 A。

最终：

```text
正常表没有 A
异常表没有 A
歌曲资料表也没有 A
```

这与人工找回使用完全相同的“完成”逻辑，不需要询问完成原因。

---

## 9. 自动恢复

假设 A 已经是异常歌曲：

```text
A | anomaly | grey
```

但网易云后来自己恢复了。

任意一次完整同步发现 A 已经在歌单中并且可以播放：

```text
bucket: anomaly → normal
anomaly_type: grey → null
```

结果：

```text
A | normal
```

这是对同一行更新，不是先插入正常表再删除异常表，所以任何时刻都只有一份 A。

统计变化：

```text
正常播放 +1
变灰 -1
歌单歌曲不变
```

如果消失歌曲重新出现且恢复可播放，同样处理。

如果消失歌曲只是重新出现但仍然不可播放，则继续保留为原来的“消失异常”；以后任意一次完整同步确认它可以播放，就立即恢复正常。

---

## 10. 变灰之后又从歌单消失

假设 A 已经确认变灰：

```text
A | anomaly | grey
```

你在找回过程中把旧 A 从网易云删除。

即使同步正好发生，系统也不会把 A 改成“消失”，因为：

```text
A 已经属于 anomaly
A 的异常类型已经锁定为 grey
```

系统只会继续保留：

```text
A | anomaly | grey
```

直到：

- 你点击“完成”，将 A 删除；或者
- 系统任意一次完整同步观察到同一个 A 恢复正常，将它立即转回 normal。

这就解决了旧系统可能把“变灰 A”二次判定成“消失 A”的问题。

---

## 11. 页面如何读取

### “待找回”

查询：

```text
bucket = anomaly
```

可以继续按：

```text
anomaly_type = grey
anomaly_type = missing
```

进行筛选。

### “歌单歌曲”

直接读取 `managed_songs` 全部活动记录：

```text
normal + anomaly
```

并根据字段显示：

```text
normal                正常，不显示异常标签
anomaly + grey        已变灰
anomaly + missing     已消失
```

### 同步状态

四张卡的查询口径：

```text
歌单歌曲 = COUNT(所有 managed_songs)

正常播放 = COUNT(bucket = normal)

变灰 = COUNT(bucket = anomaly AND anomaly_type = grey)

消失 = COUNT(bucket = anomaly AND anomaly_type = missing)
```

数据库天然满足：

```text
歌单歌曲 = 正常播放 + 变灰 + 消失
```

不设置中间状态或对应卡片；“本轮新增”卡片也不显示。
