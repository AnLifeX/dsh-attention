# dsh-attention

DeepSeek Harness 插件：当会话需要你处理 **审批 / 提问 / 选择**，或一轮对话结束时，弹出可点击的 Windows 系统通知；浏览器标签休眠后唤醒时强制重连，避免提权卡片卡死。

和现成的 `dsh-notify`（任务结束提示）、`dsh-approval-notify`（仅提权提示、不能在卡片里点允许）不同：这里的 Toast **可以允许 / 拒绝 / 直接回复 / 发送下一步**，并且带休眠唤醒。

## 为什么能在网页休眠时还通知到

通知走 **dsh 宿主 Node 进程**，不是浏览器 `Notification`。标签被 Edge/Chrome 冻住时 JS 停了，但宿主还在跑，`events.mux` 上的 `approval/requested` / `question/requested` 以及 `host/session-status` 照样能弹 Toast。

点 Toast 只会提醒；真正点选走屏幕右下角的 **原生选择窗**（Windows Forms）。点一个选项就会提交，会话继续。系统通知上的自定义协议在未打包应用里经常点了没反应，所以选项不再放在 Toast 按钮上。内部仍用 `apiProxy.respond` / `sessions.prompt`。不抢 Web UI 的审批座位：网页卡片仍然会出现。

「打开页面」或点击通知本体：先找已有的 dsh 窗口或已安装的 PWA 并前置，找不到才打开 `webUrl`，同时让前端切到对应会话。不要把 Toast 按钮做成 `http://` 链接，Windows 会强制新开标签（包括 PWA 安装提示）。

dsh 标签页当前正在聚焦时不弹通知；只有切到别的窗口、别的标签，或页面隐藏时才会 Toast。

## 安装

Windows 上 profile 在 C:、源码在 D: 时，**不要**直接 `add D:\...`，也**不要**做跨盘 junction。pnpm 的 `file:` 用硬链接，跨盘会失败。先镜像到 C: 再 `file:` 安装：

```powershell
# 在仓库根目录
.\install-local.ps1
```

脚本会：

1. `robocopy /MIR` 到 `%USERPROFILE%\.dsh\profiles\web\dsh-attention-local`（排除 `.git` / `node_modules`）
2. 删掉旧的 `node_modules/dsh-attention`（避免 pnpm 因版本未变而漏拷新文件）
3. `dsh plugin --profile web add file:<上述 C 盘路径>`

改完 D: 源码后重新跑一遍脚本，再重启 `dsh web`。镜像不是实时软链。

GitHub 推上去之后也可以：

```bash
dsh plugin --profile web add github:Gaq152/dsh-attention
```

## 用法

1. 模型申请 `danger-full-access` 等提权：系统通知出现「允许一次 / 拒绝 / 打开页面」。
2. `ask_user_question`：右下角弹出选择窗，**点选项即提交**（单选不必再点提交）。多选 / 多题时先勾选再点提交。
3. 一轮对话结束：右下角窗口写下一步并发送；点通知本体或「打开页面」会切到该会话。
4. `focusAfterReply` 为 `false`（默认）时，点允许 / 拒绝 / 选项只后台提交；设为 `true` 时会切换到已有页面（没有则新开）并聚焦该会话。
5. 标签休眠后再回来：若隐藏超过约 8 秒，页面会自动刷新一次（等同 F5），把还挂着的审批卡片重放出来。正在输入时不会刷新。
6. 打开 **设置 → 提醒**（铃铛图标）：用卡片开关通知范围、回复后是否切页、休眠刷新。每张卡片改完后点 **保存**，写入 `%USERPROFILE%\.dsh\dsh-attention-ui.json`，重启仍在。

## 配置

`cordis.patch.yml` 或 profile 里覆盖 `dsh-attention` 的 `config`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `rootsOnly` | `true` | 只提醒根会话，子代理不刷屏 |
| `notifyApproval` | `true` | 提权审批 |
| `notifyQuestion` | `true` | 提问 / 选择 |
| `notifyIdle` | `true` | 一轮对话结束后的下一步输入 |
| `notifyTimeoutSec` | `30` | 通知停留秒数；`0` 一直留到关掉 |
| `focusAfterReply` | `false` | 点击允许 / 拒绝 / 选项后是否切换到已有页面 |
| `webUrl` | `http://127.0.0.1:3080` | 回环回调与找不到窗口时的打开地址 |
| `hiddenReloadMs` | `8000` | 标签隐藏多久后唤醒要刷新 |
| `cooldownMs` | `1500` | 同一会话通知去抖 |
| `sound` | 系统默认提示音 | 设为 `false` 静音 |

回调路由只接受本机回环。不要把 `webUrl` 指到公网后再把 `/dsh-attention/act` 暴露出去。

## 局限

- 选择 / 允许 / 下一步走右下角原生窗口，不依赖 Toast 按钮回调。系统通知本身做不到可靠的选项回传（没有 Windows 应用身份 / COM 激活器）。
- 自动刷新是对官方 mux 无心跳 / `resync` 丢掉 pending 的缓解，不是给 ConnectionController 打补丁。
- Windows 10 使用 PowerShell 5.1 的 WinRT Toast；首次加载插件时会在当前用户注册 `dsh-attention:` 协议。
- 非 Windows 宿主不弹通知，但客户端唤醒逻辑仍可用。
- 「打开页面」按窗口标题 / PWA 名称匹配；dsh 若在后台标签里，可能只能把整个浏览器前置，不会新开窗口。
