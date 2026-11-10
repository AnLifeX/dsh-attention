# DSH rc.5 兼容性与 dsh-pet 调研

检查日期：2026-11-02。对象：本仓库 dsh-attention 0.4.1、npm 发布的 DSH 0.2.1-rc.5，以及 PC2005-cloud/dsh-pet 0.4.0，源码提交 `3f65e3eba87421bdc722200d916d14752c4fab20`。

## 兼容性结论

本次接口检查未发现使插件整体无法加载的变更；发现并修复一处问答调用身份缺失。结论限于发布包接口、配置加载和自动测试，不代表完成桌面版端到端验收。

| 接入点 | rc.5 核对结果 |
| --- | --- |
| 安装元数据 | engines.dsh 范围覆盖目标版本；Cordis ~4.0.5 满足本插件 ^4.0.2；rc.5 配置组合输出包含 dsh-attention |
| 会话生命周期 | session/created、session/event，以及 api-session/added/status/removed 仍存在；status 参数仍为 sessionId、running |
| 发送与停止 | sessionController.prompt(request, signal) 与 cancel({sessionId}) 保持；queue、content、requestId 的使用匹配 |
| 审批 | approval/request 的 agent、toolName、callId、reason、signal 和 waterfall 形态匹配 |
| 问答 | 官方请求使用 wait.callId；旧代码仅取顶层 callId，丢失精确身份；现优先取 wait.callId，并保留旧字段回退 |
| 网页卡片同步 | uiSession.sessionStatus 中仍有 pendingInteraction；问题卡片仍提供 callId、questions 与 answer()，新增身份可直接用于原有精确匹配 |
| 导航与设置 | uiWorkspace.openSession 仍接受 SessionId；adapter.current、settings.section 和 slots 注册接口保持 |
| 流与 HTTP | llm/stream 仍为 AsyncIterable waterfall；webServer.register 的 exact 路由和 connection.authenticatedUrl 仍可用 |

身份修复避免同一会话重复使用题目 ID 时，将上一条原生答案匹配到另一工具调用的网页问题卡。回归检查覆盖新旧字段、两字段并存时优先级、无调用标识的请求；已有客户端测试覆盖不同调用标识不互相结算。

rc.5 另引入/提供带前台等待期限的问题：wait.timed 为 true 时，宿主可能结束前台等待并继续工作，网页问题仍可通过持久投影回答。本插件沿用请求 signal 结束原生卡，不接管计时、不为 continued 问题重新建立原生卡；超时后的回答应在官方网页完成。这是当前能力边界。

验证：npm test（74 项通过）；npm run check 通过；隔离安装的 rc.5 CLI 能运行并组合现有 Web profile。未修改全局 dsh 安装，未启动真实模型对话、审批弹窗或桌面应用验收。终端 PATH 中的 dsh 实际仍为 0.2.0-rc.2，不能据此推断独立桌面应用的版本。

组合现有 Web profile 时还发现两个其他插件被 rc.5 的兼容闸门跳过：dsh-web-search-plugin@0.4.1、dsh-better-sidebar@0.19.1；它们声明的旧 DSH peer 版本不满足 rc.5。此次没有改动它们，也没有设置版本豁免。

## dsh-pet 为什么表现丰富

调研对象是 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，npm 包名 dsh-pet。它与 mjw-git 的 @dsh-pet/pet（token 经验养成）是不同项目。

| 观察到的实现 | 对本项目的启发 |
| --- | --- |
| 100+ 透明视频动作，按类别/权重选择，尽量不连续重复；工作状态驱动专用动作 | 丰富感主要来自资产和调度。我们可先增加少量待机变体、点击反馈与事件动作优先级 |
| A/B 两个 video 元素，后台加载并等 loadeddata 后再交换前台；世代号丢弃迟到结果，清理旧播放事件与 blob | 视频切换不露空白，快速点击不会让旧加载覆盖新动作；本项目是预解码 WPF 图集，不必照搬视频播放层 |
| 素材先统一角色大小、地面线、站姿与动作首尾；睡觉拆成入睡、循环、醒来 | 应先保证动作衔接和角色位置一致，再追求动作数量；不是单纯提高帧率 |
| 共用物理模块处理拖拽、释放惯性、碰撞与弹簧挤压，浏览器和 Electron 两端共用 | 当前 Windows WPF 实现可先增加拖拽释放反馈；跨端引擎迁移是独立项目 |
| HTTP 控制提供占用锁和播放回执；用户拖拽、隐藏、关闭可撤销第三方占用 | 若接入其他桌宠，必须考虑抢占与失败恢复；不能让审批提示被随机动作覆盖 |
| 浏览器 overlay、Electron 透明置顶窗和独立模式 | 跨平台与丰富视频有明确的运行时成本；我们当前 WPF 路线仍适合 Windows 通知工具 |

素材流程见 [MAKE-YOUR-OWN-PET.md](https://github.com/PC2005-cloud/dsh-pet/blob/main/MAKE-YOUR-OWN-PET.md)：AI 绿幕视频、透明抠像、位置归一化，再编码 VP9-alpha。作者说明现有动作采用 PR 手工抠像，因此质量也来自人工资产处理。Safari 的透明视频需要额外的 HEVC-alpha mov 素材，不能把“能播放 webm”等同于“保留透明”。

源码定位：[动画换源](https://github.com/PC2005-cloud/dsh-pet/blob/3f65e3eba87421bdc722200d916d14752c4fab20/dsh-pet/src/client/pet/animation/animation.ts)、[动作选择](https://github.com/PC2005-cloud/dsh-pet/blob/3f65e3eba87421bdc722200d916d14752c4fab20/dsh-pet/src/client/pet/animation/next-animation.ts)、[会话状态监听](https://github.com/PC2005-cloud/dsh-pet/blob/3f65e3eba87421bdc722200d916d14752c4fab20/dsh-pet/src/host/plugin/session-watch.ts)。

## 可合作的边界与建议

建议保留 dsh-attention 的重点：可靠的审批、提问、完成提醒与直接回复。先优化现有宠物的动作素材、切换优先级和触摸反馈，不急于加入养成、聊天、语音或迁移 Electron。

dsh-pet 已有 [HTTP API](https://github.com/PC2005-cloud/dsh-pet/blob/main/API.md)，可在占用锁下显示指定气泡、播放动作，也能扩展菜单。它的 [Cordis API](https://github.com/PC2005-cloud/dsh-pet/blob/main/CORDIS-API.md) 主要提供客户端状态读取和宿主扩展注册，不能直接当成气泡/动作控制 API。README 对 Cordis 能力的概括与专项文档有出入，集成时应以固定版本的契约和源码为准。

若以后增加“借用 dsh-pet 形象”的可选接入，原生审批决议、取消处理、网页卡片结算仍应由 attention 负责。dsh-pet 的现有 API 不能直接替代多题选择和权限决议。两插件同时启用系统通知也可能重复提醒，需要明确由谁发送。此次仅调研，没有安装、启用或集成 dsh-pet。
