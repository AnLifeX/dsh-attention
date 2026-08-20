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

export function asBool(value, fallback) {
  if (value === false || value === 0 || value === 'false' || value === '0') return false
  if (value === true || value === 1 || value === 'true' || value === '1') return true
  return fallback
}

export function notifyStyleOf(value) {
  return value === 'system' ? 'system' : 'custom'
}

/** 回到会话：reuse=前置已有窗口，new=新开。 */
export function openSessionModeOf(value) {
  return value === 'new' ? 'new' : 'reuse'
}

export const DEFAULT_SOUND = 'ms-winsoundevent:Notification.Default'

/** 空字符串表示关掉提示音，不能再当成缺省写回默认铃声。 */
export function soundOf(value, fallback = DEFAULT_SOUND) {
  if (value === false || value === null || value === '') return ''
  if (typeof value === 'string' && value.trim()) return value.trim()
  return fallback
}

/** 通知停留秒数。0 = 一直留到关掉；上限一天。 */
export function notifyTimeoutSecOf(value) {
  if (value === false || value === null) return 0
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 0) return 30
  return Math.min(n, 86400)
}

/**
 * 提问能否在 Toast 上直接点选：仅单题、单选、1–3 个选项。
 * 多题 / 多选 / 更多选项走独立回复小窗。
 */
export function questionToastMode(questions) {
  if (!Array.isArray(questions) || questions.length !== 1) return 'compose'
  const item = questions[0]
  if (!item || item.multiSelect === true) return 'compose'
  const options = Array.isArray(item.options) ? item.options : []
  if (options.length < 1 || options.length > 3) return 'compose'
  return 'buttons'
}

export function questionToastActions(questions) {
  if (questionToastMode(questions) !== 'buttons') return []
  const item = questions[0]
  const options = Array.isArray(item.options) ? item.options : []
  return options.map((option, index) => ({
    id: `opt${index}`,
    label: clip(option?.label ?? `选项${index + 1}`, 16),
    selected: String(option?.label ?? ''),
    questionId: String(item.id ?? ''),
  }))
}

/** 按 host matchesQuestions 规则拼一整批答案。 */
export function buildQuestionAnswers(questions, picked) {
  const list = Array.isArray(questions) ? questions : []
  const selected = Array.isArray(picked?.selected) ? picked.selected.map((item) => String(item)) : []
  const custom = typeof picked?.custom === 'string' && picked.custom.trim() ? picked.custom.trim() : undefined
  return list.map((question, index) => {
    const id = String(question?.id ?? '')
    const match = picked?.questionId ? id === String(picked.questionId) : index === 0
    if (!match) return { id, selected: [] }
    if (custom && question?.multiSelect !== true) return { id, selected: [], custom }
    return { id, selected, ...(custom ? { custom } : {}) }
  })
}

export function shortSessionId(sessionId) {
  const text = String(sessionId ?? '')
  if (text.startsWith('session-')) return text.slice(8, 16)
  return text.slice(0, 8)
}

export const FOCUS_WINDOW_NAME = 'dsh-web'
export const FOCUS_HASH_PREFIX = 'dsh-attention='

/** 系统通知打开会话时落到已有 SPA，并用 hash 带上 sessionId。 */
export function sessionFocusUrl(webUrl, sessionId) {
  const base = trimSlash(webUrl || DEFAULT_WEB_URL)
  const id = String(sessionId ?? '').trim()
  if (!id) return `${base}/`
  return `${base}/#${FOCUS_HASH_PREFIX}${encodeURIComponent(id)}`
}

export function parseFocusHash(hash) {
  const raw = String(hash ?? '')
  const body = raw.startsWith('#') ? raw.slice(1) : raw
  if (!body.startsWith(FOCUS_HASH_PREFIX)) return ''
  try {
    return decodeURIComponent(body.slice(FOCUS_HASH_PREFIX.length).split('&')[0] || '')
  } catch {
    return ''
  }
}
