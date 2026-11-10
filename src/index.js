/**
 * dsh-attention — 宿主半边。
 *
 * 作为 `approval/request` / `user-questions/request` waterfall 的最外层观察者：
 * 一边调用 next() 保留 Web UI，一边等待原生提醒卡片，先回答的一方完成请求。
 *
 * 提问 / 审批 / 会话结束时按设置二选一：
 * 系统通知卡片只负责点回会话；自制卡片负责选择、回复、提权。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildToastXml, fireToast } from './toast.js'
import { protocolUri, registerProtocol } from './protocol.js'
import { pickUiFields, readUiOverlay, sanitizeUiPatch, writeUiOverlay } from './persist.js'
import { renderReplyHtml } from './ui-page.js'
import { choiceWindowPath, cleanupWorkFiles, drainInbox, pendingPath, removePending, writeFocusState, writePending } from './inbox.js'
import {
  DEFAULT_AUMID,
  DEFAULT_WEB_URL,
  asBool,
  clip,
  isLoopbackAddress,
  isLoopbackHost,
  DEFAULT_SOUND,
  notifyStyleOf,
  notifyTimeoutSecOf,
  openSessionModeOf,
  questionToastActions,
  soundOf,
  powershell51,
  findPwsh,
  buildQuestionAnswers,
  sessionFocusUrl,
} from './util.js'

export const name = 'dsh-attention'

const DEFAULT_CONFIG = {
  enabled: true,
  notifyApproval: true,
  notifyQuestion: true,
  notifyIdle: true,
  notifySubagentIdle: false,
  notifyStyle: 'custom',
  notifyTimeoutSec: 30,
  cardOpacity: 0.78,
  petScale: 1,
  openSessionMode: 'reuse',
  focusAfterReply: false,
  sound: DEFAULT_SOUND,
  aumid: DEFAULT_AUMID,
  powershellPath: undefined,
  choiceShellPath: undefined,
  hiddenReloadMs: 8000,
  settledMax: 50,
  presenceStaleMs: 5000,
  titlePrefix: 'dsh',
}

/** 毫秒类配置：0 = 关闭，-1 = 无限，正数取整；非法值回落默认。 */
export function limitMsOf(value, fallback, maxMs = 86400000) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n < 0) return -1
  return Math.max(0, Math.min(maxMs, Math.floor(n)))
}

/** 已答记录条数：-1 = 不限条数，0 = 不记录（等于关掉自动关闭），其余取整数；非法值回落默认。 */
export function settledMaxOf(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.settledMax
  return Math.max(-1, Math.min(1000000, Math.floor(n)))
}

export function normalizeConfig(config) {
  const cfg = { ...DEFAULT_CONFIG }
  if (config && typeof config === 'object') Object.assign(cfg, config)
  cfg.enabled = asBool(cfg.enabled, true)
  cfg.notifyApproval = asBool(cfg.notifyApproval, true)
  cfg.notifyQuestion = asBool(cfg.notifyQuestion, true)
  cfg.notifyIdle = asBool(cfg.notifyIdle, true)
  cfg.notifySubagentIdle = asBool(cfg.notifySubagentIdle, false)
  cfg.notifyStyle = notifyStyleOf(cfg.notifyStyle)
  cfg.notifyTimeoutSec = notifyTimeoutSecOf(cfg.notifyTimeoutSec)
  cfg.cardOpacity = Number.isFinite(Number(cfg.cardOpacity))
    ? Math.min(1, Math.max(0.1, Math.round(Number(cfg.cardOpacity) * 100) / 100))
    : DEFAULT_CONFIG.cardOpacity
  cfg.petScale = Number.isFinite(Number(cfg.petScale))
    ? Math.min(2, Math.max(0.5, Math.round(Number(cfg.petScale) * 100) / 100))
    : DEFAULT_CONFIG.petScale
  cfg.openSessionMode = openSessionModeOf(cfg.openSessionMode)
  cfg.focusAfterReply = asBool(cfg.focusAfterReply, false)
  cfg.hiddenReloadMs = limitMsOf(cfg.hiddenReloadMs, DEFAULT_CONFIG.hiddenReloadMs)
  cfg.settledMax = settledMaxOf(cfg.settledMax)
  cfg.presenceStaleMs = Math.max(1000, Math.floor(Number(cfg.presenceStaleMs) || DEFAULT_CONFIG.presenceStaleMs))
  cfg.sound = soundOf(cfg.sound, DEFAULT_CONFIG.sound)
  cfg.choiceShellPath = typeof cfg.choiceShellPath === 'string' && cfg.choiceShellPath.trim()
    ? cfg.choiceShellPath.trim()
    : undefined
  return cfg
}

export function publicConfig(cfg) {
  return {
    ok: true,
    enabled: cfg.enabled,
    ...pickUiFields(cfg),
    soundEnabled: Boolean(cfg.sound),
  }
}

async function readJsonBody(req, limit = 8192) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('payload-too-large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

function mintToken() {
  return randomBytes(18).toString('base64url')
}

function wantsJson(req) {
  const marker = String(req.headers['x-dsh-attention'] ?? '')
  if (marker === '1' || marker.toLowerCase() === 'true') return true
  return String(req.headers.accept ?? '').includes('application/json')
}

function htmlPage(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;padding:24px">${body}</body>`
}

/** Toast 的 http 回退。reuse 尽量关掉多余标签并切到已有窗口；new 就留在这次打开的标签里。 */
function htmlOpenSession(dest, sessionId, mode = 'reuse') {
  const reuse = mode !== 'new'
  return `<!doctype html><meta charset="utf-8"><title>dsh</title>
<body style="font-family:sans-serif;padding:24px">
<p>正在打开会话…</p>
<script>
(function(){
  var dest = ${JSON.stringify(dest)};
  var sid = ${JSON.stringify(String(sessionId ?? ''))};
  var reuse = ${reuse ? 'true' : 'false'};
  var name = "dsh-web";
  try {
    var ch = new BroadcastChannel("dsh-attention");
    ch.postMessage({ type: "focus", sessionId: sid });
    ch.close();
  } catch (e) {}
  if (!reuse) {
    location.replace(dest);
    return;
  }
  var w = null;
  try { w = window.open("", name); } catch (e) {}
			if (w && w !== window) {
    try {
      var href = String(w.location.href || "");
      if (href && href !== "about:blank") {
        try { w.location.hash = "dsh-attention=" + encodeURIComponent(sid); } catch (e) {}
        try { w.focus(); } catch (e) {}
        setTimeout(function(){ try { window.close(); } catch (e) {} }, 200);
        return;
      }
      w.location.replace(dest);
      try { w.focus(); } catch (e) {}
      setTimeout(function(){ try { window.close(); } catch (e) {} }, 200);
      return;
    } catch (e) {}
  }
  location.replace(dest);
})();
</script>
</body>`
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  send(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  }, body)
}

function reply(req, res, status, data, html) {
  if (wantsJson(req)) sendJson(res, status, data)
  else send(res, status, { 'Content-Type': 'text/html; charset=utf-8' }, html)
}

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  res.end(body)
}

export function sessionKindOf(session) {
  const header = session?.header
  if (!header || typeof header !== 'object') return 'unknown'
  if (header.origin === 'subagent' || Number(header.delegationDepth) > 0) return 'subagent'
  return 'primary'
}

export function webServerUrl(webServer) {
  const port = Number(webServer?.port)
  return Number.isSafeInteger(port) && port > 0 && port <= 65535
    ? `http://127.0.0.1:${port}`
    : DEFAULT_WEB_URL
}

export function runtimePlatformOf(ctx) {
  return ctx.profileContext?.name === 'desktop' ? 'desktop' : 'web'
}

export function sessionOpenUrl(platform, webUrl, sessionId, connection) {
  if (platform === 'desktop') return 'dsh://open'
  const base = connection?.authenticatedUrl?.(webUrl) ?? webUrl
  return sessionFocusUrl(base, sessionId)
}

export function shouldNotifySession(cfg, sessionKind, eventKind) {
  if (sessionKind === 'subagent') {
    if (eventKind === 'idle') return cfg.notifySubagentIdle
    return false
  }
  if (sessionKind !== 'primary') return false
  if (eventKind === 'approval') return cfg.notifyApproval
  if (eventKind === 'question') return cfg.notifyQuestion
  if (eventKind === 'idle') return cfg.notifyIdle
  return false
}

/**
 * api-session/status 不携带会话来源，而且它可能晚于 session/disposed 被消费。
 * 因此来源必须在会话仍在线时记住，不能在结束时临时反查。
 */
export function createSessionKindTracker(sessionLookup = () => undefined) {
  const byId = new Map()

  const remember = (sessionId, kind) => {
    if (sessionId && kind !== 'unknown') byId.set(sessionId, kind)
    return kind
  }

  return {
    remember,
    rememberSession(session) {
      return remember(session?.id, sessionKindOf(session))
    },
    get(sessionId) {
      const cached = byId.get(sessionId)
      if (cached) return cached
      try {
        return remember(sessionId, sessionKindOf(sessionLookup(sessionId)))
      } catch {
        return 'unknown'
      }
    },
    clear() {
      byId.clear()
    },
  }
}

/** One native-card answer competing with the existing Web waterfall. */
export function createPendingDecision(signal) {
  let resolveDecision
  let settled = false
  let onAbort
  const decision = new Promise((resolve) => { resolveDecision = resolve })
  const settle = (result) => {
    if (settled) return false
    settled = true
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    resolveDecision(result)
    return true
  }
  if (signal) {
    onAbort = () => settle({ type: 'aborted', reason: signal.reason })
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return { decision, settle }
}

export async function racePendingDecision(pending, next) {
  const delegated = Promise.resolve().then(next)
  const native = pending.decision.then((result) => {
    if (result.type === 'answer') return result.value
    if (result.type === 'aborted') {
      const error = new Error('request aborted before dsh-attention answered')
      error.name = 'AbortError'
      throw error
    }
    return delegated
  })
  return Promise.race([delegated, native])
}

/**
 * 原生卡已答记录：客户端轮询 /dsh-attention/focus 时取走，据此替 DSH 官方卡调用
 * answer()。DSH 网关会把没被客户端结算的审批一直留着，并在事件流重连（标签页唤醒、
 * 刷新）时重放给页面，所以记录默认永久保留（靠条数上限控内存，见 settledMax 配置）：
 * 只要记录还在，隔多久回来卡片都能自动关上。
 */
export function createSettledLog({ ttlMs = Infinity, max = 50, now = Date.now } = {}) {
  const entries = []
  const limitOf = () => (typeof max === 'function' ? max() : max)
  const prune = () => {
    const cutoff = now() - ttlMs
    while (entries.length && Number(entries[0].at ?? 0) < cutoff) entries.shift()
    const limit = limitOf()
    // -1 / Infinity = 不限条数；0 = 一条不留
    if (Number.isFinite(limit) && limit >= 0 && entries.length > limit) {
      entries.splice(0, entries.length - limit)
    }
  }
  return {
    /** 同一条记录重复写入时覆盖，避免客户端对同一张卡答两次。 */
    push(entry) {
      const index = entries.findIndex((item) => item.id === entry.id)
      if (index >= 0) entries.splice(index, 1)
      entries.push(entry)
      prune()
    },
    list() {
      prune()
      return entries
    },
    get size() { return entries.length },
  }
}

/**
 * 空闲提醒里的「下一步」：把用户输入作为下一轮消息提交。
 * 宿主 sessionController.prompt(request, signal) 第一行就是 signal.throwIfAborted()，
 * 必须传 AbortSignal；漏传会抛 TypeError —— 卡片照样显示已提交，消息其实没发出去。
 */
export async function promptIdle(sessionController, record, text) {
  return sessionController.prompt({
    requestId: randomUUID(),
    sessionId: record.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }, new AbortController().signal)
}

export async function runPetSessionAction(controller, sessionId, action, text) {
  if (action === 'stop') return controller.cancel({ sessionId })
  if (action === 'reply') {
    const value = String(text ?? '').trim()
    if (!value) throw new Error('请输入回复内容')
    return promptIdle(controller, { sessionId }, value)
  }
  throw new Error('未知会话操作')
}

export function petEventPreview(event) {
  const data = event?.data
  if (event?.type === 'tool/call') return `正在执行 ${String(data?.name ?? '工具')}`
  if (event?.type === 'tool/result') return data?.message?.isError ? '工具执行失败' : '工具执行完成'
  if (event?.type !== 'assistant/message' && event?.type !== 'user/message') return ''
  const content = data?.message?.content ?? data?.content
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ') : ''
  return clip(String(text).replace(/\s+/g, ' ').trim(), 140)
}

export async function* observePetStream(options, next, onPreview) {
  let text = ''
  for await (const chunk of next()) {
    if (options.sessionId && !options.purpose) {
      let preview = ''
      if (chunk.type === 'text-delta') {
        text = (text + chunk.text).slice(0, 300)
        preview = clip(text.replace(/\s+/g, ' ').trim(), 140)
      } else if (chunk.type === 'reasoning-delta' && !text) preview = '正在思考'
      else if (chunk.type === 'tool-call-delta' && chunk.name) preview = `正在执行 ${chunk.name}`
      if (preview) onPreview(options.sessionId, preview)
    }
    yield chunk
  }
}

function toastInputText(url, extra = {}) {
  const keys = ['task', 'text', 'input.task', 'input_task']
  for (const key of keys) {
    const value = extra[key] ?? url.searchParams.get(key)
    if (value && String(value).trim()) return String(value).trim()
  }
  return ''
}

function receiptOk(receipt) {
  if (!receipt) return false
  if (receipt.accepted === true) return true
  const result = receipt.result
  if (result?.ok === true && result.value?.accepted === true) return true
  return false
}

function loadImagePng(file) {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', file))
  } catch {
    return null
  }
}

export function resolveTitle(sessionTitle, session) {
  try {
    const title = sessionTitle?.get?.(session)?.title
    if (typeof title === 'string' && title.trim()) return clip(title.trim(), 40)
  } catch {
    /* sessionTitle 不在 ctx 上时忽略 */
  }
  try {
    const events = session?.snapshotEvents?.() ?? session?.events
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim()) {
          return clip(event.data.title.trim(), 40)
        }
      }
    }
  } catch {
    /* 会话已分离 */
  }
  return ''
}

export function acknowledgeCompletedPetSession(item, hiddenSessions) {
  if (!item || item.running || item.needsAnswer) return false
  hiddenSessions.set(item.sessionId, item.turnKey)
  return true
}

export function apply(ctx, config = {}) {
  cleanupWorkFiles()
  const overlay = readUiOverlay()
  if (!Object.hasOwn(config, 'petScale') && !Object.hasOwn(overlay, 'petScale')) {
    try {
      overlay.petScale = JSON.parse(readFileSync(join(dirname(pendingPath('')), 'pet-settings.json'), 'utf8')).scale
    } catch { /* Previous desktop scale is optional. */ }
  }
  const cfg = normalizeConfig({ ...config, ...overlay })
  const platform = runtimePlatformOf(ctx)
  const choiceShellPath = cfg.choiceShellPath || findPwsh() || powershell51()
  let runtimeWebUrl = DEFAULT_WEB_URL
  let connection = null
  const runtimeConfig = () => ({ ...cfg, webUrl: runtimeWebUrl, platform })
  ctx.inject(['connection'], (scope) => {
    connection = scope.connection
    scope.effect(() => () => { connection = null }, 'dsh-attention: authenticated links')
  })

  /** token → 待处理项。审批 / 提问项持有 waterfall 的本地决议。 */
  const byToken = new Map()
  const runningBySession = new Map()
  const hiddenPetSessions = new Map()
  const petTurns = new Map()
  const petActivityAt = new Map()
  const petPreviews = new Map()
  const petTitles = new Map()
  const petSessions = () => {
    const records = new Map()
    for (const [sessionId, running] of runningBySession) {
      const session = sessionOf(sessionId)
      if (session && !petPreviews.has(sessionId)) {
        const events = session.snapshotEvents?.() ?? session.events ?? []
        petPreviews.set(sessionId, [...events].reverse().map(petEventPreview).find(Boolean) || '')
      }
      records.set(sessionId, { sessionId, title: titleOf(sessionId, session), status: running ? '进行中' : '已完成', running, canReply: sessionKinds.get(sessionId) === 'primary' })
    }
    for (const record of byToken.values()) {
      const session = sessionOf(record.sessionId)
      const old = records.get(record.sessionId)
      records.set(record.sessionId, {
        ...old, sessionId: record.sessionId,
        title: titleOf(record.sessionId, session),
        status: record.kind === 'approval' ? '待审批' : record.kind === 'question' ? '待回答' : '已完成',
        running: old?.running === true, canReply: sessionKinds.get(record.sessionId) === 'primary',
        token: record.token, needsAnswer: record.kind !== 'idle',
      })
    }
    return [...records.values()].filter((item) => hiddenPetSessions.get(item.sessionId) !== (petTurns.get(item.sessionId) || 0)).map((item) => ({
      ...item,
      preview: petPreviews.get(item.sessionId) || item.status,
      turnKey: petTurns.get(item.sessionId) || 0,
      updatedAt: petActivityAt.get(item.sessionId) || 0,
    })).sort((a, b) => Number(b.needsAnswer === true) - Number(a.needsAnswer === true) || Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt)
  }
  let petWindow = null
  let petStateToken = null
  const petBubbles = new Set()
  let lastPetSync = 0
  let lastCompletedAt = 0
  let lastFailedAt = 0
  let disposed = false
  const nativeSettled = createSettledLog({ max: () => cfg.settledMax })
  let lastUiFocusedAt = 0
  let lastUiTitle = ''
  let lastUiSessionId = ''
  let lastUiTheme = 'light'
  const pendingFocus = { sessionId: null, until: 0 }

  const rememberTheme = (value) => {
    const t = String(value || '').toLowerCase()
    if ((t === 'dark' || t === 'light') && t !== lastUiTheme) {
      lastUiTheme = t
      lastPetSync = 0
      syncPet()
    }
  }

  const remember = (record) => {
    if (record.timeoutSec == null) record.timeoutSec = cfg.notifyTimeoutSec
    byToken.set(record.token, record)
    petActivityAt.set(record.sessionId, Date.now())
  }

  const forgetToken = (token) => {
    const record = byToken.get(token)
    byToken.delete(token)
    removePending(token)
    record?.settle?.({ type: 'expired' })
  }

  const forgetIdleFor = (sessionId) => {
    for (const record of [...byToken.values()]) {
      if (record.kind === 'idle' && record.sessionId === sessionId) forgetToken(record.token)
    }
  }

  /**
   * 原生卡先答完时，把结果记下来；客户端轮询 /dsh-attention/focus 时据此调用
   * DSH 官方审批 / 提问卡的 answer()，让官方卡自动关闭（不需要刷新页面）。
   */
  const markNativeSettled = (record, value) => {
    if (record.kind !== 'approval' && record.kind !== 'question') return
    nativeSettled.push({
      id: record.token,
      sessionId: record.sessionId,
      kind: record.kind,
      value,
      ...(record.callId !== undefined ? { callId: record.callId } : {}),
      ...(record.toolName !== undefined ? { toolName: record.toolName } : {}),
      ...(record.kind === 'question'
        ? { questionIds: (record.questions ?? []).map((question) => String(question?.id ?? '')) }
        : {}),
      at: Date.now(),
    })
  }

  const recentNativeSettled = () => nativeSettled.list()

  const runtimePort = () => {
    try { return Number(new URL(runtimeWebUrl).port) || 0 } catch { return 0 }
  }
  const openUrl = (token) => protocolUri(token, 'open', runtimePort())
  const httpOpenUrl = (token) => `${runtimeWebUrl}/dsh-attention/act?t=${encodeURIComponent(token)}&a=open`

  const toastChrome = () => ({
    imageUrl: `${runtimeWebUrl}/dsh-attention/logo.png`,
    attribution: '提醒',
  })

  const choiceLabels = (isSubagent = false) => ({
    primaryIdentity: '主会话',
    subagentIdentity: '子代理',
    title: '提醒',
    submit: '提交',
    close: '关闭',
    closeX: '×',
    send: '发送',
    allow: '允许',
    reject: '拒绝',
    placeholder: '下一步想让它做什么…',
    customLabel: '其他',
    customPlaceholder: '输入你的答案',
    openSession: '回到会话',
    subagentIdleNote: '子代理任务已完成，可回到会话查看结果。',
    empty: '先写一句再发送。',
    missing: '还有选项没选。',
    done: '已提交',
    expired: '这条已经失效。',
    focusMiss: '找不到已打开的 dsh 窗口。请先让浏览器停在 dsh 那个标签上。',
  })

  const choicePending = (token, sessionId, extra = {}) => {
    const isSubagent = extra.isSubagent === true
    return {
      token,
      timeoutSec: cfg.notifyTimeoutSec,
      cardOpacity: cfg.cardOpacity,
      notifyStyle: cfg.notifyStyle,
      petAnchorFile: `${pendingPath(`pet-${runtimePort()}`)}.anchor.json`,
      webUrl: runtimeWebUrl,
      platform,
      port: runtimePort(),
      openUrl: sessionOpenUrl(platform, runtimeWebUrl, sessionId, connection),
      openSessionMode: platform === 'desktop' ? 'reuse' : cfg.openSessionMode,
      reuseSession: platform === 'desktop' || cfg.openSessionMode !== 'new',
      playSound: Boolean(cfg.sound),
      windowTitle: lastUiTitle,
      appTitle: 'DeepSeek Harness',
      labels: choiceLabels(isSubagent),
      theme: lastUiTheme,
      ...extra,
    }
  }

  const openChoiceWindow = (token, data) => {
    if (process.platform !== 'win32') return false
    const record = byToken.get(token)
    if (!record) return false
    if (data) record.choiceData = data
    if (record.choiceWindow?.pid && record.choiceWindow.exitCode === null) return true
    try {
      // A timed-out card can be reopened from the pet while its decision is still pending.
      if (record.choiceData) writePending(token, record.choiceData)
      const child = spawn(
        choiceShellPath,
        [
          '-NoProfile',
          '-STA',
          '-WindowStyle', 'Hidden',
          '-ExecutionPolicy', 'Bypass',
          '-File', choiceWindowPath(),
          '-Token', token,
        ],
        { windowsHide: false, stdio: 'ignore' },
      )
      record.choiceWindow = child
      child.once('exit', () => { record.choiceWindow = null; removePending(token) })
      if (cfg.notifyStyle === 'pet') {
        petBubbles.add(child)
        child.once('exit', () => {
          petBubbles.delete(child)
          if (child.pid) removePending(`pet-visible-${child.pid}`)
        })
        child.once('error', () => petBubbles.delete(child))
      }
      child.on('error', (error) => {
        ctx.logger?.warn?.(`dsh-attention: 无法打开选择窗: ${String(error)}`)
        if (byToken.has(token)) forgetToken(token)
      })
      return true
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attention: 无法打开选择窗: ${String(error)}`)
      if (byToken.has(token)) forgetToken(token)
      return false
    }
  }

  /** 预热：提前编译/加载 C# 缓存并加载 WPF，让第一张卡片不用等冷启动。 */
  const prewarmChoiceWindow = () => {
    if (process.platform !== 'win32' || !cfg.enabled || cfg.notifyStyle === 'system') return
    try {
      const child = spawn(
        choiceShellPath,
        [
          '-NoProfile',
          '-STA',
          '-WindowStyle', 'Hidden',
          '-ExecutionPolicy', 'Bypass',
          '-File', choiceWindowPath(),
          '-Token', '__prewarm__',
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
      child.on('error', () => { /* 预热失败不影响正式路径 */ })
    } catch {
      /* 预热失败不影响正式路径 */
    }
  }
  prewarmChoiceWindow()

  const syncPet = () => {
    if (process.platform !== 'win32' || disposed) return
    const token = `pet-${runtimePort()}`
    if (!cfg.enabled || cfg.notifyStyle !== 'pet') {
      petWindow?.kill()
      petWindow = null
      for (const child of petBubbles) child.kill()
      petBubbles.clear()
      if (petStateToken) {
        removePending(petStateToken)
        removePending(`${petStateToken}.json.anchor`)
      }
      petStateToken = null
      return
    }
    const now = Date.now()
    if (now - lastPetSync < 1000) return
    lastPetSync = now
    try {
      writePending(token, {
        ownerPid: process.pid,
        platform,
        theme: lastUiTheme,
        petScale: cfg.petScale,
        webUrl: runtimeWebUrl,
        updatedAt: now,
        pose: [...byToken.values()].some((item) => item.kind !== 'idle') ? 'question'
          : now - lastFailedAt < 2500 ? 'failed'
            : [...runningBySession.values()].some(Boolean) ? 'work' : now - lastCompletedAt < 5000 ? 'done' : 'neutral',
        bubblePids: [...petBubbles].map((child) => child.pid).filter(Boolean),
        sessions: petSessions(),
      })
      petStateToken = token
      if (petWindow) return
      const child = spawn(choiceShellPath, [
        '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', join(dirname(choiceWindowPath()), 'pet-window.ps1'), '-StateFile', pendingPath(token),
      ], { windowsHide: true, stdio: 'ignore' })
      petWindow = child
      const clear = () => { if (petWindow === child) petWindow = null }
      child.once('exit', clear)
      child.once('error', (error) => {
        clear()
        ctx.logger?.warn?.(`dsh-attention: 无法启动常驻宠物: ${String(error)}`)
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attention: 无法同步宠物状态: ${String(error)}`)
    }
  }

  const fireSystemToast = (token, title, lines) => {
    const xml = buildToastXml({
      title,
      lines,
      launchUrl: openUrl(token),
      sound: cfg.sound,
      timeoutSec: cfg.notifyTimeoutSec,
      ...toastChrome(),
      actions: [
        { label: '打开会话', url: platform === 'desktop' ? openUrl(token) : httpOpenUrl(token) },
      ],
    })
    fireToast(ctx, cfg, xml)
  }

  let sessions = null
  let sessionTitle = null
  ctx.inject(['sessionTitle'], (scope) => {
    sessionTitle = scope.sessionTitle
    scope.effect(() => () => { sessionTitle = null }, 'dsh-attention: session titles')
  })
  const sessionOf = (sessionId) => {
    try {
      return sessions?.get?.(sessionId)
    } catch {
      return undefined
    }
  }
  const sessionKinds = createSessionKindTracker(sessionOf)

  ctx.inject(['sessions'], (scope) => {
    sessions = scope.sessions
    for (const session of sessions.list?.() ?? []) {
      sessionKinds.rememberSession(session)
    }
    scope.effect(() => () => { sessions = null }, 'dsh-attention: session store')
  })

  const titleOf = (sessionId, session = sessionOf(sessionId)) => {
    const title = session ? resolveTitle(sessionTitle, session) : ''
    return title || petTitles.get(sessionId) || '未命名会话'
  }

  const uiFocused = () => Date.now() - lastUiFocusedAt < cfg.presenceStaleMs

  const requestFocus = (sessionId) => {
    if (!sessionId) return
    pendingFocus.sessionId = sessionId
    pendingFocus.until = Date.now() + 20000
  }

  const currentFocus = () => {
    if (!pendingFocus.sessionId || Date.now() > pendingFocus.until) return null
    return pendingFocus.sessionId
  }

  const shouldFocusAfter = (action) => action === 'open'

  const decisionRecord = (record, signal) => {
    return { ...record, ...createPendingDecision(signal) }
  }

  const awaitAnswer = async (record, next) => {
    try {
      return await racePendingDecision(record, next)
    } finally {
      forgetToken(record.token)
    }
  }

  const answerApproval = (request, next) => {
    const session = request?.agent?.session
    const sessionId = session?.id ?? request?.agent?.id
    const kind = sessionKinds.rememberSession(session)
    if (!sessionId || !cfg.enabled || uiFocused()) return next()
    if (!shouldNotifySession(cfg, kind, 'approval')) return next()

    const token = mintToken()
    const who = titleOf(sessionId, session)
    const reason = String(request.reason ?? '')
    const escalation = /^escalate sandbox to (\S+):\s*(.*)$/.exec(reason)
    const what = escalation
      ? `${request.toolName ?? '工具'} 提权至 ${escalation[1]}`
      : `${request.toolName ?? '工具'} 请求审批`
    const why = clip(escalation ? escalation[2] : reason, 120)

    const record = decisionRecord({
      kind: 'approval',
      token,
      sessionId,
      callId: request.callId,
      toolName: request.toolName,
      createdAt: Date.now(),
    }, request.signal)
    remember(record)
    if (cfg.notifyStyle === 'system') {
      fireSystemToast(token, `${cfg.titlePrefix} · 需要审批`, [
        `会话 ${who}`,
        why ? `${what}：${why}` : what,
        '点击通知回到该会话，在页面里处理',
      ])
    } else {
      openChoiceWindow(token, choicePending(token, sessionId, {
        kind: 'approval',
        session: clip(who, 22),
        heading: '需要审批',
        sub: why ? `${what}：${why}` : what,
      }))
    }
    return awaitAnswer(record, next)
  }

  const answerQuestion = (request, next) => {
    const session = request?.agent?.session
    const sessionId = session?.id ?? request?.agent?.id
    const kind = sessionKinds.rememberSession(session)
    if (!sessionId || !cfg.enabled || uiFocused()) return next()
    if (!shouldNotifySession(cfg, kind, 'question')) return next()

    const questions = Array.isArray(request.questions) ? request.questions : []
    const token = mintToken()
    const who = titleOf(sessionId, session)
    const first = questions[0]
    const prompt = clip(first?.question ?? '需要你做选择', 80)
    const optionActions = questionToastActions(questions)
    const callId = request.wait?.callId ?? request.callId

    const record = decisionRecord({
      kind: 'question',
      token,
      sessionId,
      questions,
      ...(callId !== undefined ? { callId } : {}),
      optionActions,
      createdAt: Date.now(),
    }, request.signal)
    remember(record)
    if (cfg.notifyStyle === 'system') {
      fireSystemToast(token, `${cfg.titlePrefix} · 在等你选择`, [
        `会话 ${who}`,
        prompt,
        '点击通知回到该会话，在页面里选择',
      ])
    } else {
      openChoiceWindow(token, choicePending(token, sessionId, {
        kind: 'question',
        session: clip(who, 22),
        heading: prompt,
        questions,
      }))
    }
    return awaitAnswer(record, next)
  }

  const showIdleToast = (sessionId) => {
    if (!cfg.enabled || uiFocused()) return
    const kind = sessionKinds.get(sessionId)
    if (!shouldNotifySession(cfg, kind, 'idle')) return
    const isSubagent = kind === 'subagent'

    forgetIdleFor(sessionId)
    const token = mintToken()
    const session = sessionOf(sessionId)
    const who = titleOf(sessionId, session)

    remember({
      kind: 'idle',
      token,
      sessionId,
      isSubagent,
      createdAt: Date.now(),
    })
    if (cfg.notifyStyle === 'system') {
      fireSystemToast(token, `${cfg.titlePrefix} · ${isSubagent ? '子代理任务已完成' : '主会话本轮已完成'}`, [
        `${isSubagent ? '子代理' : '会话'} ${who}`,
        isSubagent ? '点击通知查看该子代理会话' : '点击通知回到该会话，在页面里写下一步',
      ])
      return
    }
    openChoiceWindow(token, choicePending(token, sessionId, {
      kind: 'idle',
      session: clip(who, 22),
      heading: isSubagent ? '子代理任务已完成' : '主会话本轮已完成',
      isSubagent,
    }))
  }

  const onSessionStatus = (sessionId, running) => {
    sessionKinds.get(sessionId)
    running = running === true
    const prev = runningBySession.get(sessionId)
    runningBySession.set(sessionId, running)
    if (running) {
      if (prev !== true) {
        petTurns.set(sessionId, (petTurns.get(sessionId) || 0) + 1)
        petPreviews.set(sessionId, '正在思考')
        petActivityAt.set(sessionId, Date.now())
      }
      forgetIdleFor(sessionId)
      return
    }
    if (prev === true && running === false) {
      lastCompletedAt = Date.now()
      showIdleToast(sessionId)
      if (uiFocused() && lastUiSessionId === sessionId) {
        acknowledgeCompletedPetSession(petSessions().find((item) => item.sessionId === sessionId), hiddenPetSessions)
      }
    }
  }

  const rejectUnlessLoopback = (req, res) => {
    const remote = req.socket?.remoteAddress
    if (!isLoopbackAddress(remote) || !isLoopbackHost(req.headers.host)) {
      send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden')
      return true
    }
    return false
  }

  function normalizeAnswers(raw) {
    if (!Array.isArray(raw) || !raw.length) return []
    return raw.map((item) => ({
      id: String(item?.id ?? ''),
      selected: Array.isArray(item?.selected) ? item.selected.map(String) : [],
      ...(typeof item?.custom === 'string' && item.custom.trim() ? { custom: item.custom.trim() } : {}),
    }))
  }

  async function runAct(sessionController, token, action, extra = {}) {
    const record = byToken.get(token)
    if (!record) return { ok: false, error: 'expired' }
    if (action === 'open') {
      requestFocus(record.sessionId)
      return { ok: true, action: 'open', focus: true, platform, openUrl: sessionOpenUrl(platform, runtimeWebUrl, record.sessionId, connection), sessionId: record.sessionId, message: '请使用原来的 dsh 窗口继续' }
    }
    if (action === 'compose') {
      openChoiceWindow(token)
      return { ok: true, action: 'compose', focus: false, sessionId: record.sessionId, message: '已打开选择窗' }
    }

    try {
      if (record.kind === 'idle' && action === 'send') {
        if (record.isSubagent === true) return { ok: false, error: 'bad-action' }
        const text = String(extra.text ?? '').trim()
        if (!text) return { ok: false, error: 'empty' }
        const receipt = await promptIdle(sessionController, record, text)
        if (!receiptOk(receipt)) return { ok: false, error: 'rejected' }
        forgetToken(record.token)
        const focus = shouldFocusAfter(action)
        if (focus) requestFocus(record.sessionId)
        return { ok: true, action, message: '已发送下一步', focus, sessionId: record.sessionId }
      }

      let settledValue
      if (record.kind === 'approval' && (action === 'allow' || action === 'reject')) {
        settledValue = action === 'allow' ? 'allowed-once' : 'rejected'
        if (!record.settle?.({ type: 'answer', value: settledValue })) {
          return { ok: false, error: 'not-pending' }
        }
      } else if (record.kind === 'question' && (action === 'answer' || action.startsWith('opt'))) {
        let answers = normalizeAnswers(extra.answers)
        if (!answers.length) {
          const option = (record.optionActions ?? []).find((item) => item.id === action)
          if (!option) return { ok: false, error: 'unknown-option' }
          answers = buildQuestionAnswers(record.questions, {
            questionId: option.questionId,
            selected: [option.selected],
          })
        }
        settledValue = { answers }
        if (!record.settle?.({ type: 'answer', value: settledValue })) {
          return { ok: false, error: 'not-pending' }
        }
      } else {
        return { ok: false, error: 'bad-action' }
      }
      markNativeSettled(record, settledValue)
      forgetToken(record.token)
      const done = action === 'allow' ? '已允许一次' : action === 'reject' ? '已拒绝' : '已提交选择'
      const focus = shouldFocusAfter(action)
      if (focus) requestFocus(record.sessionId)
      return { ok: true, action, message: done, focus, sessionId: record.sessionId }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attention: act failed ${String(error)}`)
      return { ok: false, error: String(error) }
    }
  }

  const finishAct = (req, res, record, action, message, focus) => {
    const data = { ok: true, action, message, focus, sessionId: record.sessionId }
    const extra = focus ? '正在切到对应会话。' : '可以继续待在当前窗口。'
    reply(req, res, 200, data, htmlPage('dsh-attention', `<p>${message}。${extra}</p>`))
  }

  let inboxTimer = null

  ctx.on('session/created', (session) => {
    sessionKinds.rememberSession(session)
  }, { global: true })
  ctx.on('approval/request', function (request, next) {
    return answerApproval(request, next)
  }, { prepend: true })
  ctx.on('user-questions/request', function (request, next) {
    return answerQuestion(request, next)
  }, { prepend: true })
  ctx.on('api-session/status', onSessionStatus)
  ctx.on('api-session/added', (summary) => {
    if (summary.running || runningBySession.has(summary.sessionId)) onSessionStatus(summary.sessionId, summary.running)
  })
  ctx.on('api-session/removed', (sessionId) => {
    runningBySession.delete(sessionId)
    hiddenPetSessions.delete(sessionId)
    petTurns.delete(sessionId)
    petActivityAt.delete(sessionId)
    petPreviews.delete(sessionId)
    petTitles.delete(sessionId)
    for (const record of [...byToken.values()]) if (record.sessionId === sessionId) forgetToken(record.token)
  })
  ctx.on('llm/stream', function (options, next) {
    return observePetStream(options, next, (sessionId, preview) => {
      if (cfg.enabled && cfg.notifyStyle === 'pet') {
        petPreviews.set(sessionId, preview)
        petActivityAt.set(sessionId, Date.now())
      }
    })
  })
  ctx.on('session/event', (session, event) => {
    if (!session?.id) return
    if (event.type === 'session/title' && event.data?.title) petTitles.set(session.id, String(event.data.title))
    const preview = petEventPreview(event)
    if (preview) {
      if (event.type === 'tool/result' && event.data?.message?.isError) lastFailedAt = Date.now()
      petPreviews.set(session.id, preview)
      petActivityAt.set(session.id, Date.now())
    }
  }, { global: true })

  ctx.inject(['sessionController', 'webServer'], (scope) => {
    const { sessionController, webServer } = scope
    runtimeWebUrl = webServerUrl(webServer)
    registerProtocol(runtimeConfig(), ctx.logger)
    syncPet()
    scope.effect(() => webServer.register({
      kind: 'exact', path: '/dsh-attention/pet-act',
      async handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return }
        try {
          const { sessionId, action, text } = await readJsonBody(req)
          if (cfg.notifyStyle !== 'pet' || !cfg.enabled) throw new Error('宠物模式未启用')
          const item = petSessions().find((entry) => entry.sessionId === sessionId)
          if (!item) throw new Error('会话已不可用')
          if (action === 'open') {
            requestFocus(sessionId)
            acknowledgeCompletedPetSession(item, hiddenPetSessions)
          } else if (action === 'dismiss') {
            hiddenPetSessions.set(sessionId, item.turnKey)
          } else if (action === 'compose' && item.token) {
            openChoiceWindow(item.token)
          } else {
            if (action === 'reply' && !item.canReply) throw new Error('子代理会话不能直接回复')
            if (action === 'stop' && !item.running) throw new Error('会话当前未运行')
            const receipt = await runPetSessionAction(sessionController, sessionId, action, text)
            if (!receiptOk(receipt)) throw new Error('宿主未接受操作')
          }
          sendJson(res, 200, { ok: true })
          lastPetSync = 0
          syncPet()
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }) }
      },
    }), 'dsh-attention: pet actions')
    inboxTimer = setInterval(() => {
      syncPet()
      for (const job of drainInbox(runtimePort())) {
        const token = String(job?.t ?? '')
        const action = String(job?.a ?? '')
        if (!token || !action) continue
        void runAct(sessionController, token, action, {
          answers: job.answers,
          text: job.text,
        }).then((result) => {
          if (!result?.ok) ctx.logger?.warn?.(`dsh-attention: inbox ${action} ${result?.error ?? 'failed'}`)
          else ctx.logger?.info?.(`dsh-attention: inbox ${action} ok`)
        }).catch((error) => {
          ctx.logger?.warn?.(`dsh-attention: inbox ${String(error)}`)
        })
      }
    }, 250)

    scope.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-attention/config',
      async handler(req, res) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const body = JSON.stringify(publicConfig(cfg))
          const headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': Buffer.byteLength(body),
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, headers)
            res.end()
            return
          }
          send(res, 200, headers, body)
          return
        }
        if (req.method !== 'POST' && req.method !== 'PATCH') {
          res.writeHead(405, { Allow: 'GET, HEAD, POST, PATCH' })
          res.end()
          return
        }
        if (rejectUnlessLoopback(req, res)) return
        try {
          const patch = sanitizeUiPatch(await readJsonBody(req))
          if (Object.keys(patch).length === 0) {
            sendJson(res, 400, { ok: false, error: 'empty-patch' })
            return
          }
          if (Object.hasOwn(patch, 'soundEnabled')) {
            patch.sound = patch.soundEnabled === false ? '' : (soundOf(cfg.sound, '') || DEFAULT_CONFIG.sound)
            delete patch.soundEnabled
          }
          const next = normalizeConfig({ ...cfg, ...patch })
          Object.assign(cfg, next)
          writeUiOverlay(pickUiFields(cfg))
          registerProtocol(runtimeConfig(), ctx.logger)
          lastPetSync = 0
          syncPet()
          sendJson(res, 200, publicConfig(cfg))
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error) })
        }
      },
    }), 'dsh-attention: config')

    for (const file of ['logo.png', 'pet/preview.png']) {
      const imagePng = loadImagePng(file)
      if (!imagePng) continue
      scope.effect(() => webServer.register({
        kind: 'exact',
        path: `/dsh-attention/${file}`,
        handler(req, res) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { Allow: 'GET, HEAD' })
            res.end()
            return
          }
          const headers = {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
            'Content-Length': imagePng.length,
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, headers)
            res.end()
            return
          }
          send(res, 200, headers, imagePng)
        },
      }), `dsh-attention: image ${file}`)
    }

    scope.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-attention/presence',
      async handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' })
          res.end()
          return
        }
        const chunks = []
        for await (const chunk of req) {
          chunks.push(chunk)
          if (Buffer.concat(chunks).length > 4096) break
        }
        let body = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          body = {}
        }
        if (body.focused === true) lastUiFocusedAt = Date.now()
        else lastUiFocusedAt = 0
        const focusedSession = typeof body.sessionId === 'string' ? body.sessionId : ''
        lastUiSessionId = focusedSession
        if (body.focused === true && focusedSession) {
          if (acknowledgeCompletedPetSession(petSessions().find((item) => item.sessionId === focusedSession), hiddenPetSessions)) {
            lastPetSync = 0
            syncPet()
          }
        }
        if (typeof body.title === 'string' && body.title.trim()) {
          lastUiTitle = body.title.trim()
        }
        rememberTheme(body.theme)
        writeFocusState({
          title: lastUiTitle,
          sessionId: focusedSession,
          at: Date.now(),
          theme: lastUiTheme,
        })
        if (focusedSession && focusedSession === currentFocus()) {
          pendingFocus.sessionId = null
          pendingFocus.until = 0
        }
        sendJson(res, 200, { ok: true })
      },
    }), 'dsh-attention: presence')

    scope.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-attention/focus',
      handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        sendJson(res, 200, { ok: true, sessionId: currentFocus(), settled: recentNativeSettled() })
      },
    }), 'dsh-attention: focus')

    scope.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-attention/pending',
      handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const record = byToken.get(url.searchParams.get('t') ?? '')
        if (!record) {
          sendJson(res, 404, { ok: false, error: 'expired' })
          return
        }
        sendJson(res, 200, {
          ok: true,
          kind: record.kind,
          sessionId: record.sessionId,
          questions: record.questions ?? [],
          isSubagent: record.isSubagent === true,
          theme: lastUiTheme,
          timeoutSec: record.timeoutSec ?? cfg.notifyTimeoutSec,
          cardOpacity: cfg.cardOpacity,
        })
      },
    }), 'dsh-attention: pending')

    scope.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-attention/ui',
      handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const html = renderReplyHtml()
        send(res, 200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(html),
        }, html)
      },
    }), 'dsh-attention: ui')

    scope.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-attention/act',
      async handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        let body = {}
        if (req.method === 'POST' || req.method === 'PATCH') {
          try { body = await readJsonBody(req) } catch { body = {} }
        } else if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD, POST, PATCH' })
          res.end()
          return
        }
        const token = String(body.t || url.searchParams.get('t') || '')
        const action = String(body.a || url.searchParams.get('a') || '')
        ctx.logger?.info?.(`dsh-attention: act ${action || '(none)'} token=${token ? 'yes' : 'no'}`)

        if (action === 'compose') {
          const record = byToken.get(token)
          if (record) openChoiceWindow(token)
          const loc = `/dsh-attention/ui?t=${encodeURIComponent(token)}`
          res.writeHead(302, { Location: loc })
          res.end()
          return
        }

        const result = await runAct(sessionController, token, action, {
          answers: body.answers,
          text: toastInputText(url, body),
        })
        const record = byToken.get(token) || { sessionId: result.sessionId }

        if (!result.ok) {
          const status = result.error === 'expired' ? 404
            : result.error === 'empty' || result.error === 'unknown-option' || result.error === 'bad-action' ? 400
              : result.error === 'rejected' || result.error === 'not-pending' || result.error === 'bad-response' ? 409
                : 500
          const messages = {
            expired: '这条通知已经失效（已处理、已过期，或页面已重连）。请回到原来的 dsh 窗口。',
            empty: '下一步任务是空的，没有发送。',
            'unknown-option': '未知选项。请到原来的 dsh 窗口里回答。',
            'bad-action': '这个按钮对当前请求不可用。请到原来的 dsh 窗口处理。',
            rejected: '发送未被接受。请到原来的 dsh 窗口里输入。',
          }
          const html = messages[result.error] || `提交失败：${result.error}`
          reply(req, res, status, { ok: false, error: result.error, focus: false }, htmlPage('提醒', `<p>${html}</p>`))
          return
        }

        if (action === 'open') {
          reply(req, res, 200, result, htmlOpenSession(result.openUrl, result.sessionId,
            platform === 'desktop' ? 'new' : cfg.openSessionMode))
          return
        }

        finishAct(req, res, record, action, result.message, result.focus)
      },
    }), 'dsh-attention: act')
  })

  ctx.effect(() => () => {
    disposed = true
    petWindow?.kill()
    petWindow = null
    for (const child of petBubbles) child.kill()
    petBubbles.clear()
    if (petStateToken) {
      removePending(petStateToken)
      removePending(`${petStateToken}.json.anchor`)
    }
    if (inboxTimer) clearInterval(inboxTimer)
    for (const token of [...byToken.keys()]) forgetToken(token)
    runningBySession.clear()
    hiddenPetSessions.clear()
    petTurns.clear()
    petActivityAt.clear()
    petPreviews.clear()
    petTitles.clear()
    sessionKinds.clear()
  }, 'dsh-attention: dispose')
}

export default { name, apply, normalizeConfig }
