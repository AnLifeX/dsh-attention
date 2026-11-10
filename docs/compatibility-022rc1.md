# DSH 0.2.2-rc.1 兼容性检查

检查日期：2026-11-10。对象：本工作区 dsh-attention 0.4.1，以及 npm 发布的 DSH 0.2.2-rc.1 系列包。

## 结论与检查边界

npm latest / next 均指向 0.2.2-rc.1。现有核心接入点未发现不兼容变更，暂不需要修改提醒逻辑或提高插件自身的 Node.js 门槛。结论基于发布包的声明与实现、版本范围验证和本项目自动测试；没有启动新版完整宿主或完成真实审批、问答和桌面唤回验收。

| 接入点 | 核对结果 |
| --- | --- |
| 安装范围 | `engines.dsh: >=0.1.2-alpha.3 <0.3.0-0` 在官方 `includePrerelease: true` 规则下接受目标版本 |
| Cordis | 宿主使用 4.1.0，满足插件 `^4.0.2`；未在新版 Cordis 下做完整插件生命周期验收 |
| 会话事件 | `session/created`、`session/event` 保留；`api-session/added/status/removed` 保留，status 仍发布 sessionId、running |
| 发送与停止 | 宿主 `sessionController.prompt(request, signal)`、`cancel({sessionId})` 保留；内部 commands 的第二参数不同，不是本插件调用入口 |
| 审批与问答 | approval/request waterfall、审批结果字符串和身份字段保留；问答仍支持 wait.callId、结构化 answers 和 signal |
| 网页卡片同步 | uiSession.sessionStatus 中的 pendingInteraction 保留；原有客户端同步回归测试通过 |
| 导航与设置 | uiWorkspace.openSession 与 settings.section 保留；新提供 settings.section.icon，本次未迁移现有图标实现 |
| HTTP 与链接 | webServer exact 路由及 connection.authenticatedUrl 保留 |

限时问答的已有边界仍适用：结束前台等待后不重新创建原生卡，应在官方页面继续回答。新版原生问题卡的专用呈现、推荐项预选等视觉行为不代表本插件已逐项同步。

## 精简插件详情

官方 `@deepseek-ai/dsh-plugin-detail@0.2.2-rc.1` 优先读取 locale JSON 中的 `meta.detail`；未声明时回退包内 README。路径相对包根目录，支持按语言链选择。

本次为 zh / en 分别指定 `locale/detail.zh.md` 和 `locale/detail.en.md`。完整 README 保留，详情仅包含功能、开启方式、平台要求与完整文档链接；文件位于已有 files 白名单的 locale 目录，无需新增运行时依赖或修改导出。

验证：

- `npm test`：74 项通过；`npm run check` 通过。
- 修改详情元数据后，定向元数据回归测试通过。
- 使用官方新版 `readPackageDocument(localFiles(...), ...)` 实际读取，zh-CN 选择中文，en-US 选择英文，ja 按官方语言链回退英文。
- `npm pack --dry-run --json` 确认两份详情文档及中英文 locale JSON 均进入发布包。
- semver 断言确认 DSH 与 Cordis 范围均接受目标版本。

## Node.js

DSH 0.2.2-rc.1 的发布包声明 `engines.node: >=24.9.0`；本机 PATH 的 Node 为 22.21.0，不满足新版宿主要求。本插件仍声明 >=18，并在当前 Node 22 上通过测试。

继续运行原有 DSH 可以暂不升级 Node。使用新版 CLI / dsh web 时应提供符合要求的 Node；可用独立或便携运行时，无需替换其他项目的 Node。官方桌面版应使用其配套命令和运行环境，本次未核验本机桌面安装或内置运行时。

本次仅在临时目录下载发布包，未升级全局 Node / DSH，未修改用户 profile，未发布插件。

来源：[官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)、[DSH 发布包](https://www.npmjs.com/package/@deepseek-ai/dsh)、[插件详情读取器源码目录](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/util/plugin-detail)。
