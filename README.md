# dsh-attention

DeepSeek Harness 插件：当会话需要你处理 **审批 / 提问 / 选择** 时，弹出可点击的 Windows 系统通知；浏览器标签休眠后唤醒时强制重连，避免提权卡片卡死。

和现成的 `dsh-notify`（任务结束提示）、`dsh-approval-notify`（仅提权提示、不能在卡片里点允许）不同：这里的 Toast **可以允许 / 拒绝 / 打开页面**，并且带休眠唤醒。

## 为什么能在网页休眠时还通知到

通知走 **dsh 宿主 Node 进程**，不是浏览器 `Notification`。标签被 Edge/Chrome 冻住时 JS 停了，但宿主还在跑，`events.mux` 上的 `approval/requested` / `question/requested` 照样能弹 Toast。

点 Toast 上的「允许一次 / 拒绝」会打回环地址 `http://127.0.0.1:3080/dsh-attention/act`，内部调用与网页相同的 `apiProxy.respond`。不抢 Web UI 的审批座位：网页卡片仍然会出现。

## 安装

Windows 上 profile 在 C:、源码在 D: 时，**不要**直接 `add D:\...`，也**不要**做跨盘 junction。pnpm 的 `file:` 用硬链接，跨盘会失败。先镜像到 C: 再 `file:` 安装：

```powershell
# 在仓库根目录
.\install-local.ps1
```

脚本会：

1. `robocopy /MIR` 到 `%USERPROFILE%\.dsh\profiles\web\dsh-attention-local`（排除 `.git` / `node_modules`）
2. `dsh plugin --profile web add file:<上述 C 盘路径>`

改完 D: 源码后重新跑一遍脚本，再重启 `dsh web`。镜像不是实时软链。

GitHub 推上去之后也可以：

```bash
dsh plugin --profile web add github:Gaq152/dsh-attention
```

## 用法

1. 模型申请 `danger-full-access` 等提权：系统通知出现「允许一次 / 拒绝 / 打开页面」。
2. `ask_user_question` 若是 **单题、单选、1–3 个选项**（含 plan review）：通知上直接出选项按钮；更复杂的提问请点「打开页面」在网页里答。
3. 点按钮后浏览器会跳到 dsh 页面，确认提交结果。
4. 标签休眠后再回来：若隐藏超过约 8 秒，页面会自动刷新一次（等同 F5），把还挂着的审批卡片重放出来。正在输入时不会刷新。

## 配置

`cordis.patch.yml` 或 profile 里覆盖 `dsh-attention` 的 `config`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `rootsOnly` | `true` | 只提醒根会话，子代理不刷屏 |
| `notifyApproval` | `true` | 提权审批 |
| `notifyQuestion` | `true` | 提问 / 选择 |
| `webUrl` | `http://127.0.0.1:3080` | 打开页面、Toast 回调的基址 |
| `hiddenReloadMs` | `8000` | 标签隐藏多久后唤醒要刷新 |
| `cooldownMs` | `1500` | 同一会话通知去抖 |
| `sound` | 系统默认提示音 | 设为 `false` 静音 |

回调路由只接受本机回环。不要把 `webUrl` 指到公网后再把 `/dsh-attention/act` 暴露出去。

## 局限

- Toast 直接回复目前覆盖审批，以及简单的单选提问。自由文本、多题、多选仍需打开网页。
- 自动刷新是对官方 mux 无心跳 / `resync` 丢掉 pending 的缓解，不是给 ConnectionController 打补丁。
- Windows 10 使用 PowerShell 5.1 的 WinRT Toast；非 Windows 宿主不弹通知，但客户端唤醒逻辑仍可用。
