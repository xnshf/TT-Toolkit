# [Feature] 为角色聊天的 branch/checkpoint 提供唯一的具体聊天稳定身份

## 要解决的问题 / Problem to solve

扩展、Agent 功能或其它需要把状态长期关联到某一具体聊天的使用者，在角色聊天创建 branch 或 checkpoint 后，无法通过公开的 `api.chat.current.handle().stableId()` 区分原聊天与新聊天。

当前角色聊天的 `stableId()` 读取 `chat_metadata.integrity`。branch/checkpoint 会创建新的 JSONL 文件，并在 branch 的 `chat_metadata.main_chat` 中回链原聊天，但同时复制原 `integrity`。因此两个不同 `ChatRef`、不同文件名的聊天会返回相同的 `stableId`。

这使调用方无法可靠判断某个持久状态、异步任务或资源所有权究竟属于原聊天还是某个分支；而群聊 branch 使用新的聊天 ID，不存在同样的不一致。

## 期望结果 / Desired outcome

调用方应能获得一个语义明确、可唯一标识**具体聊天**的稳定身份，以便安全地区分原聊天、branch 和 checkpoint。

可接受的设计方向包括：

- 将 `stableId` 定义为具体聊天身份：重命名后保持不变，新的 branch/checkpoint 获得新的 ID；或
- 若 `stableId` 有意表示分支谱系，则明确文档化该语义，并额外提供一个唯一的具体聊天 ID。

无论采用哪种方案，角色聊天和群聊应提供一致、可供扩展使用的身份语义。

## 使用场景 / Use cases

1. 聊天工具箱或第三方扩展为某一聊天保存轻量状态、书签、后台任务或处理结果。用户从该聊天创建 branch 后，两份聊天的状态不应被当成同一份资源。
2. Agent 或其它按聊天身份管理 workspace 的功能，需要在删除一个 branch 时只处理该 branch 的资源，而不影响原聊天或同谱系的其它聊天。

该需求影响桌面端和移动端的角色聊天；群聊可作为一致性参照。

## 已有替代方式 / Current alternatives

调用方可以使用 `ChatRef`（角色标识与文件名）区分当前文件，但文件名会因重命名而改变，无法替代稳定身份；每个扩展自行维护另一套迁移和关联逻辑，也无法形成宿主级的一致契约。

## 兼容性与取舍 / Compatibility and tradeoffs

- 既有角色 branch/checkpoint 已可能共享 `integrity`，迁移必须避免把多个历史聊天静默合并为同一资源或误删状态。
- 若直接改变 `stableId` 的语义会影响现有扩展，新增明确的“具体聊天 ID”并保留旧字段的谱系语义，可能是更平滑的兼容路径。
- 具体字段名、迁移时机和是否改写既有聊天文件可由项目结合 SillyTavern 扩展生态与跨平台数据约束决定；本建议不限定实现方式。

## 补充信息 / Additional context

### 运行时复现

在 TauriTavern `2.2.0`（本地源码提交 `439216353260`）中，创建并打开角色聊天 branch 后，Console 输出：

```text
refChanged: true
stableIdSame: true
```

即原聊天和 branch 的 `ChatRef` 不同，但 `stableId` 相同。

### JSONL 文件头部证据

仅读取两份聊天 JSONL 的第一行头部，未读取或记录消息正文：

| 字段 | 原聊天 | `Branch #1` |
| --- | --- | --- |
| 文件名 | `<original>.jsonl` | `<original> - Branch #1.jsonl` |
| 文件大小 | 6,573,344 bytes | 6,573,416 bytes |
| 消息记录数 | 211 | 211 |
| `chat_metadata.main_chat` | 缺失 | `<original>` |
| `chat_metadata.integrity` | `<same UUID>` | `<same UUID>` |

这表明新文件是实际 branch，且两个独立文件复制了相同的 `integrity`。两者大小相差 72 bytes，资源管理器按 MB 显示时可能看起来相同。

### 复现注意事项

请从目标消息的菜单创建 branch，或显式指定消息 ID。当前不带参数的 `/branch-create` 在本次运行中会从楼层 `0` 创建只含开场白的 branch；这是独立的命令默认参数问题，不影响上述身份冲突的文件与 API 证据。

## 提交前确认 / Before submitting

- [ ] 已搜索现有 Issue，未发现相同建议。
