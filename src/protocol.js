/**
 * Toast 不能用 http:// 当协议激活：Windows 会交给默认浏览器，必然新开标签。
 * 改走 HKCU 里的 dsh-attention: 自定义协议，由隐藏 PowerShell 回环请求 /act。
 *
 * URI 必须走路径、不能带 ?a=&t=：协议启动会经过 cmd，`&` 会把动作截断，
 * 点了选择/允许等于没提交。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROTOCOL = 'dsh-attention'
export const HANDLER_CONFIG_PATH = () => join(homedir(), '.dsh', 'dsh-attention-handler.json')

export function protocolUri(token, action, port) {
  const endpoint = Number.isSafeInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535
    ? `/${Number(port)}`
    : ''
  return `${PROTOCOL}://do/${encodeURIComponent(token)}/${encodeURIComponent(action)}${endpoint}`
}

/** 只前置已有 dsh 窗口，不走浏览器、不新开标签。 */
export function focusExistingArgs(webUrl, sessionId) {
  const args = ['-FocusExisting', '-ReuseOnly', '-WebUrl', String(webUrl || 'http://127.0.0.1:3080')]
  if (sessionId) args.push('-SessionId', String(sessionId))
  return args
}

export function parseProtocolUri(raw) {
  const text = String(raw ?? '').trim().replace(/^"+|"+$/g, '')
  const stripped = text.replace(/^dsh-attention:(\/\/)?/i, '')
  let path = stripped
  let query = ''
  const q = stripped.indexOf('?')
  if (q >= 0) {
    path = stripped.slice(0, q)
    query = stripped.slice(q + 1)
  }
  const out = {}
  const parts = path.split('/').filter(Boolean)
  if (parts.length >= 3 && (parts[0] === 'do' || parts[0] === 'act')) {
    out.t = decodeURIComponent(parts[1])
    out.a = decodeURIComponent(parts[2])
    if (/^\d+$/.test(parts[3] ?? '')) out.p = parts[3]
  }
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair)
    const value = decodeURIComponent(eq >= 0 ? pair.slice(eq + 1) : '')
    if (key) out[key] = value
  }
  return out
}

export function handlerScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'protocol-handler.ps1')
}

export function handlerCmdPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dsh-attention-open.cmd')
}

export function handlerVbsPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dsh-attention-open.vbs')
}

function wscriptPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return join(root, 'System32', 'wscript.exe')
}

export function writeHandlerConfig(cfg) {
  const path = HANDLER_CONFIG_PATH()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({
    webUrl: cfg.webUrl,
    openSessionMode: cfg.openSessionMode === 'new' ? 'new' : 'reuse',
  }, null, 2)}\n`)
  return path
}

export function registerProtocol(cfg, logger) {
  if (process.platform !== 'win32') return
  writeHandlerConfig(cfg)
  const vbs = handlerVbsPath()
  const key = `HKCU\\Software\\Classes\\${PROTOCOL}`
  const command = `"${wscriptPath()}" //nologo //B "${vbs}" "%1"`
  const runs = [
    ['add', key, '/ve', '/d', 'URL:dsh-attention Protocol', '/f'],
    ['add', key, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
    ['add', `${key}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'],
  ]
  for (const args of runs) {
    const result = spawnSync('reg', args, { windowsHide: true, encoding: 'utf8' })
    if (result.status !== 0) {
      logger?.warn?.(`dsh-attention: 注册协议失败 (${args.join(' ')}): ${result.stderr || result.stdout || result.status}`)
      return
    }
  }
  logger?.debug?.(`dsh-attention: 已注册 ${PROTOCOL}: → ${vbs}`)
}
