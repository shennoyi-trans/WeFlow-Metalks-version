# WeFlow 聊天媒体与通话时间索引

在「导出」中选择 WeFlow 详细 JSON，勾选需要的媒体。将聊天 JSON、同名的 `.json.timeline.jsonl` 和媒体目录一起交给 Metalks。保留导出目录的层级，索引里的路径相对于聊天文件所在目录。单独导出 TXT、ChatLab、WeClone CSV、Excel 或 HTML 也会生成时间索引。

每条已选媒体消息对应一行 JSON。公共字段包括版本号 `schemaVersion: 1`、会话 ID、原始本地与服务端消息 ID、发送人、收发方向、消息类型、Unix 秒数和 UTC 时间。消息 ID 按字符串保存。导入器应优先用详细 JSON 的 `platformMessageId` 对应索引的 `serverId`。正文的 `localId` 可以是导出序号。

图片、语音、视频、表情和文件使用带 UTC 时间与消息标识摘要的文件名。重复发送同一文件时，每次发送都有自己的索引记录。已选但缺少原件的消息使用 `availability: "unavailable"`、`relativePath: null`。缺少时间的消息使用 `timestamp: null` 和 `unknown-time` 文件名前缀。

语音和视频通话单独记为 `type: "call"`。其中 `call.kind` 指明类型，`status` 记录接听、未接、取消、拒绝、忙线或其他设备接听，`durationSeconds` 来自微信提示，`summary` 保留原提示。无法判定的类型或状态写为 `unknown`。普通会话导出包含这些事件，语音或视频专项导出只包含对应类型的通话。通话事件记录的是通话历史。

## 源码与验证

本分支基于官方历史提交 `93d46a3183b98bfe5073ea89ecaa32a4f80f79d3`。该快照的 package.json 标记为 4.3.0，官方发布工作流会按标签替换版本号。实现沿用之前针对 Windows 4.5.1 安装包验证过的 v1 索引协议。

- `electron/services/exportTimeline.ts` 负责文件名、通话解析和 JSONL 写入。
- `electron/services/exportService.ts` 将各格式实际输出的媒体路径传给索引写入器，保证正文、索引与磁盘路径一致。
- 安装锁文件中的开发依赖后，运行 `node --test scripts/test-export-timeline.cjs`。用例通过正常导出入口运行，使用合成消息和临时目录，无需微信账户。
