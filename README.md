<p align="center">
  <img src="assets/logo.png" width="128" height="128" alt="dsh-attention">
</p>

# dsh-attention

[![npm version](https://img.shields.io/npm/v/dsh-attention.svg)](https://www.npmjs.com/package/dsh-attention)
![Windows](https://img.shields.io/badge/Windows-10%2B-0078D6?logo=windows&logoColor=white)

DeepSeek Harness 插件：会话需要 **审批 / 提问 / 选择**，或一轮对话结束时，在屏幕右下角弹出可操作的提醒；浏览器标签休眠后再回来时自动刷新，避免审批卡片卡住。

## 功能

- **网页休眠也能提醒。** 通知由 dsh 宿主发出，不走浏览器 `Notification`。标签被冻住时 JavaScript 停了，审批、提问、会话结束照样能弹窗。
- **卡片上直接处理。** 允许 / 拒绝、单选 / 多选、自定义输入（标题为「其他」）、写下一步，点完即提交，会话继续。不抢网页上的审批卡片。
- **跟着 dsh 主题。** 自制卡片亮色 / 暗色与当前页面一致，毛玻璃圆角；底部倒计时条从绿变到红。
- **两种卡片样式，二选一。** 默认自制卡片可在窗口里操作；系统通知卡片只负责点回会话。
- **回到已有会话。** 「回到会话」优先前置已经打开的 dsh 窗口或 Edge 应用，并切到对应会话；也可每次新开。
- **当前窗口不打扰。** dsh 标签正在聚焦时不弹；切到别的窗口、标签，或页面隐藏时才提醒。
- **设置页可调。** 打开 **设置 → 提醒**（铃铛），改完点 **保存**，写入 `%USERPROFILE%\.dsh\dsh-attention-ui.json`，重启仍在。

## 安装

```bash
dsh plugin --profile web add dsh-attention
```

装完后重启 `dsh web`。更新到最新版用 `dsh-attention@latest`。

## 用法

1. 模型申请提权：右下角出现允许 / 拒绝；点「回到会话」切回该会话。
2. 提问 / 选择：单选点选项即提交；多选或多题先勾选再点提交；也可在「其他」里自己写答案。
3. 一轮对话结束：在窗口里写下一步并发送。
4. 标签休眠后再回来：隐藏超过约 8 秒会自动刷新一次（等同 F5），把还挂着的审批卡片重放出来。正在输入时不会刷新。
5. 在 **设置 → 提醒** 里开关通知范围、卡片样式、停留时间、回到会话方式、休眠刷新。

## 配置

`cordis.patch.yml` 或 profile 里覆盖 `dsh-attention` 的 `config`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `rootsOnly` | `true` | 只提醒根会话，子代理不刷屏 |
| `notifyApproval` | `true` | 提权审批 |
| `notifyQuestion` | `true` | 提问 / 选择 |
| `notifyIdle` | `true` | 一轮对话结束后的下一步输入 |
| `notifyStyle` | `custom` | `custom` 自制卡片；`system` 系统通知 |
| `notifyTimeoutSec` | `30` | 停留秒数；`0` 一直留到关掉。系统通知实际只有约 7 秒 / 25 秒两档 |
| `openSessionMode` | `reuse` | `reuse` 复用已有窗口；`new` 每次新开 |
| `webUrl` | `http://127.0.0.1:3080` | 回环回调与找不到窗口时的打开地址 |
| `hiddenReloadMs` | `8000` | 标签隐藏多久后唤醒要刷新（毫秒；设置页按秒填写） |
| `cooldownMs` | `1500` | 同一会话通知去抖 |
| `sound` | 系统默认提示音 | 设为 `false` 静音 |

回调路由只接受本机回环。不要把 `webUrl` 指到公网后再把 `/dsh-attention/act` 暴露出去。

## 局限

- 选择 / 允许 / 下一步走右下角自制窗口，不依赖系统通知按钮回调。
- 自动刷新是对标签休眠后 pending 卡片丢失的缓解，不是给连接层打补丁。
- Windows 10 使用 PowerShell 5.1 的 WinRT Toast；首次加载插件时会在当前用户注册 `dsh-attention:` 协议。
- 非 Windows 宿主不弹通知，但客户端唤醒逻辑仍可用。
- 「回到会话」按窗口标题 / PWA 名称匹配；dsh 若在后台标签里，可能只能把整个浏览器前置。普通浏览器标签建议选「新开」。
