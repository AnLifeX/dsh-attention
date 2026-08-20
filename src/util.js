/**
 * 纯函数：Toast XML 转义、文案截断、回环校验、提问按钮映射。
 * 不依赖 cordis，方便 node:test 直接测。
 */

export const DEFAULT_WEB_URL = 'http://127.0.0.1:3080'
export const DEFAULT_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

export function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[ch]))
}

export function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

export function powershell51() {
  const windir = process.env.windir || process.env.WINDIR || 'C:\\Windows'
  return `${windir}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

export function isLoopbackAddress(address) {
  const raw = String(address ?? '').trim().toLowerCase()
  if (raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1') return true
  if (raw.startsWith('::ffff:127.')) return true
  return false
}

export function isLoopbackHost(hostHeader) {
  const host = String(hostHeader ?? '').trim().toLowerCase()
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

export function trimSlash(url) {
  return String(url ?? DEFAULT_WEB_URL).replace(/\/+$/, '')
}

/**
 * 提问能否在 Toast 上直接点选：仅单题、单选、1–3 个选项。
 * 多题 / 多选 / 自由文本只能「打开页面」去网页里答。
 */
export function questionToastActions(questions) {
  if (!Array.isArray(questions) || questions.length !== 1) return []
  const item = questions[0]
  if (!item || item.multiSelect === true) return []
  const options = Array.isArray(item.options) ? item.options : []
  if (options.length < 1 || options.length > 3) return []
  return options.map((option, index) => ({
    id: `opt${index}`,
    label: clip(option?.label ?? `选项${index + 1}`, 16),
    selected: String(option?.label ?? ''),
    questionId: String(item.id ?? ''),
  }))
}

export function shortSessionId(sessionId) {
  const text = String(sessionId ?? '')
  if (text.startsWith('session-')) return text.slice(8, 16)
  return text.slice(0, 8)
}
