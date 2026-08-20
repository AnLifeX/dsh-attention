/**
 * Windows 10 原生 Toast：PowerShell 5.1 + WinRT ToastNotificationManager。
 * 标题/XML 走环境变量，脚本走 -EncodedCommand，避开代码页和引号转义。
 */
import { spawn } from 'node:child_process'
import { notifyTimeoutSecOf, powershell51, xmlEscape } from './util.js'

/** 读 $env:DSH_ATTENTION_XML 并弹出 Toast。 */
const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xmlText = [string]$env:DSH_ATTENTION_XML
$aumid = [string]$env:DSH_ATTENTION_AUMID
$expireSec = 0
try { $expireSec = [int]$env:DSH_ATTENTION_EXPIRE_SEC } catch { $expireSec = 0 }
if ($expireSec -lt 0) { $expireSec = 0 }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
if ($expireSec -gt 0) {
  $toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds($expireSec)
}
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
`.trim()

export function buildToastXml({ title, lines, launchUrl, actions, sound, imageUrl, attribution, timeoutSec }) {
  const image = imageUrl
    ? `<image placement="appLogoOverride" hint-crop="circle" src="${xmlEscape(imageUrl)}"/>`
    : ''
  const attr = attribution
    ? `<text placement="attribution">${xmlEscape(attribution)}</text>`
    : ''
  const textNodes = [title, ...(lines ?? [])]
    .filter((line) => String(line ?? '').trim() !== '')
    .slice(0, 3)
    .map((line, index) => (index === 0
      ? `<text hint-maxLines="2">${xmlEscape(line)}</text>`
      : `<text hint-maxLines="3">${xmlEscape(line)}</text>`))
    .join('')

  const actionNodes = (actions ?? []).slice(0, 5).map((action) => {
    const style = action.style === 'success' || action.style === 'critical'
      ? ` hint-buttonStyle="${action.style === 'success' ? 'Success' : 'Critical'}"`
      : ''
    return `<action content="${xmlEscape(action.label)}" activationType="protocol" arguments="${xmlEscape(action.url)}"${style}/>`
  }).join('')

  const actionsBlock = actionNodes ? `<actions>${actionNodes}</actions>` : ''
  const audio = sound
    ? `<audio src="${xmlEscape(sound)}"/>`
    : '<audio silent="true"/>'
  const launch = launchUrl
    ? ` activationType="protocol" launch="${xmlEscape(launchUrl)}"`
    : ''
  const timeout = timeoutSec == null ? 0 : notifyTimeoutSecOf(timeoutSec)
  const sticky = timeoutSec == null || timeout <= 0
  const duration = sticky || timeout > 10 ? 'long' : 'short'
  const scenario = sticky ? ' scenario="reminder"' : ''

  return `<toast${launch} duration="${duration}"${scenario}><visual><binding template="ToastGeneric">${image}${textNodes}${attr}</binding></visual>${actionsBlock}${audio}</toast>`
}

export function fireToast(ctx, cfg, xml) {
  if (process.platform !== 'win32') return
  const ps = cfg.powershellPath || powershell51()
  const encoded = Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64')
  const expireSec = notifyTimeoutSecOf(cfg?.notifyTimeoutSec)
  let child
  try {
    child = spawn(
      ps,
      ['-NoProfile', '-STA', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      {
        env: {
          ...process.env,
          DSH_ATTENTION_XML: xml,
          DSH_ATTENTION_AUMID: cfg.aumid,
          DSH_ATTENTION_EXPIRE_SEC: String(expireSec > 0 ? expireSec : 0),
        },
        windowsHide: true,
        stdio: 'ignore',
      },
    )
  } catch (error) {
    ctx.logger?.warn?.(`dsh-attention: 无法启动通知进程: ${String(error)}`)
    return
  }
  child.on('error', (error) => {
    ctx.logger?.warn?.(`dsh-attention: 通知进程错误: ${String(error)}`)
  })
}
