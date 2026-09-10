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
import { choiceWindowPath, drainInbox, removePending, writeFocusState, writePending } from './inbox.js'
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
  shortSessionId,
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
  openSessionMode: 'reuse',
  focusAfterReply: false,
  sound: DEFAULT_SOUND,
  aumid: DEFAULT_AUMID,
  powershellPath: undefined,
  choiceShellPath: undefined,
  cooldownMs: 1500,
  hiddenReloadMs: 8000,
  presenceStaleMs: 5000,
  titlePrefix: 'dsh',
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
  cfg.openSessionMode = openSessionModeOf(cfg.openSessionMode)
  cfg.focusAfterReply = asBool(cfg.focusAfterReply, false)
  cfg.cooldownMs = Math.max(0, Math.floor(Number(cfg.cooldownMs) || 0))
  cfg.hiddenReloadMs = Math.max(0, Math.floor(Number(cfg.hiddenReloadMs) || 0))
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
function htmlOpenSession(webUrl, sessionId, mode = 'reuse') {
  const dest = sessionFocusUrl(webUrl, sessionId)
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

function loadLogoPng() {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'logo.png'))
  } catch {
    return null
  }
}

function resolveTitle(ctx, session) {
  try {
    const title = ctx.sessionTitle?.get?.(session)?.title
    if (typeof title === 'string' && title.trim()) return clip(title.trim(), 40)
  } catch {
    /* sessionTitle 不在 ctx 上时忽略 */
  }
  try {
    const events = session?.events
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
  return `#${shortSessionId(session?.id)}`
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig({ ...config, ...readUiOverlay() })
  const choiceShellPath = cfg.choiceShellPath || findPwsh() || powershell51()
  let runtimeWebUrl = DEFAULT_WEB_URL
  const runtimeConfig = () => ({ ...cfg, webUrl: runtimeWebUrl })

  /** token → 待处理项。审批 / 提问项持有 waterfall 的本地决议。 */
  const byToken = new Map()
  const lastToastAt = new Map()
  const runningBySession = new Map()
  const nativeSettled = []
  let lastUiFocusedAt = 0
  let lastUiTitle = ''
  let lastUiTheme = 'light'
  const pendingFocus = { sessionId: null, until: 0 }

  const rememberTheme = (value) => {
    const t = String(value || '').toLowerCase()
    if (t === 'dark' || t === 'light') lastUiTheme = t
  }

  const remember = (record) => {
    if (record.timeoutSec == null) record.timeoutSec = cfg.notifyTimeoutSec
    byToken.set(record.token, record)
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
    const cutoff = Date.now() - 30000
    while (nativeSettled.length && nativeSettled[0].at < cutoff) nativeSettled.shift()
    if (nativeSettled.length > 20) nativeSettled.splice(0, nativeSettled.length - 20)
  }

  const recentNativeSettled = () => {
    const cutoff = Date.now() - 30000
    while (nativeSettled.length && nativeSettled[0].at < cutoff) nativeSettled.shift()
    return nativeSettled
  }

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
      webUrl: runtimeWebUrl,
      openUrl: sessionFocusUrl(runtimeWebUrl, sessionId),
      openSessionMode: cfg.openSessionMode,
      reuseSession: cfg.openSessionMode !== 'new',
      playSound: Boolean(cfg.sound),
      windowTitle: lastUiTitle,
      appTitle: 'DeepSeek Harness',
      labels: choiceLabels(isSubagent),
      theme: lastUiTheme,
      ...extra,
    }
  }

  const openChoiceWindow = (token) => {
    if (process.platform !== 'win32') return false
    try {
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

  const fireSystemToast = (token, title, lines) => {
    const xml = buildToastXml({
      title,
      lines,
      launchUrl: openUrl(token),
      sound: cfg.sound,
      timeoutSec: cfg.notifyTimeoutSec,
      ...toastChrome(),
      actions: [
        { label: '打开会话', url: httpOpenUrl(token) },
      ],
    })
    fireToast(ctx, cfg, xml)
  }

  const sessionOf = (sessionId) => {
    try {
      return ctx.sessions?.get?.(sessionId)
    } catch {
      return undefined
    }
  }
  const sessionKinds = createSessionKindTracker(sessionOf)

  try {
    for (const session of ctx.sessions?.list?.() ?? []) {
      sessionKinds.rememberSession(session)
    }
  } catch {
    /* request.agent 和实时 session/status 仍会补齐；未知会话按不通知处理。 */
  }

  const cooled = (key) => {
    const now = Date.now()
    const last = lastToastAt.get(key) ?? 0
    if (now - last < cfg.cooldownMs) return true
    lastToastAt.set(key, now)
    return false
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
    if (cooled(`approval:${sessionId}`)) return next()

    const token = mintToken()
    const who = session ? resolveTitle(ctx, session) : `#${shortSessionId(sessionId)}`
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
      writePending(token, choicePending(token, sessionId, {
        kind: 'approval',
        session: clip(who, 22),
        heading: '需要审批',
        sub: why ? `${what}：${why}` : what,
      }))
      openChoiceWindow(token)
    }
    return awaitAnswer(record, next)
  }

  const answerQuestion = (request, next) => {
    const session = request?.agent?.session
    const sessionId = session?.id ?? request?.agent?.id
    const kind = sessionKinds.rememberSession(session)
    if (!sessionId || !cfg.enabled || uiFocused()) return next()
    if (!shouldNotifySession(cfg, kind, 'question')) return next()
    if (cooled(`question:${sessionId}`)) return next()

    const questions = Array.isArray(request.questions) ? request.questions : []
    const token = mintToken()
    const who = session ? resolveTitle(ctx, session) : `#${shortSessionId(sessionId)}`
    const first = questions[0]
    const prompt = clip(first?.question ?? '需要你做选择', 80)
    const optionActions = questionToastActions(questions)

    const record = decisionRecord({
      kind: 'question',
      token,
      sessionId,
      questions,
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
      writePending(token, choicePending(token, sessionId, {
        kind: 'question',
        session: clip(who, 22),
        heading: prompt,
        questions,
      }))
      openChoiceWindow(token)
    }
    return awaitAnswer(record, next)
  }

  const showIdleToast = (sessionId) => {
    if (!cfg.enabled || uiFocused()) return
    const kind = sessionKinds.get(sessionId)
    if (!shouldNotifySession(cfg, kind, 'idle')) return
    const isSubagent = kind === 'subagent'
    if (cooled(`idle:${sessionId}`)) return

    forgetIdleFor(sessionId)
    const token = mintToken()
    const session = sessionOf(sessionId)
    const who = session ? resolveTitle(ctx, session) : `#${shortSessionId(sessionId)}`

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
    writePending(token, choicePending(token, sessionId, {
      kind: 'idle',
      session: clip(who, 22),
      heading: isSubagent ? '子代理任务已完成' : '主会话本轮已完成',
      isSubagent,
    }))
    openChoiceWindow(token)
  }

  const onSessionStatus = (sessionId, running) => {
    sessionKinds.get(sessionId)
    running = running === true
    const prev = runningBySession.get(sessionId)
    runningBySession.set(sessionId, running)
    if (running) {
      forgetIdleFor(sessionId)
      return
    }
    if (prev === true && running === false) showIdleToast(sessionId)
  }

  const rejectUnlessLoopback = (req, res) => {
    const remote = req.socket?.remoteAddress
    if (!isLoopbackAddress(remote) || !isLoopbackHost(req.headers.host)) {
      send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden')
      return true
    }
    return false
  }

  async function promptIdle(sessionController, record, text) {
    return sessionController.prompt({
      requestId: randomUUID(),
      sessionId: record.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    })
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
      return { ok: true, action: 'open', focus: true, sessionId: record.sessionId, message: '请使用原来的 dsh 窗口继续' }
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

  ctx.inject(['sessionController', 'webServer'], (scope) => {
    const { sessionController, webServer } = scope
    runtimeWebUrl = webServerUrl(webServer)
    registerProtocol(runtimeConfig(), ctx.logger)
    inboxTimer = setInterval(() => {
      for (const job of drainInbox()) {
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
          sendJson(res, 200, publicConfig(cfg))
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error) })
        }
      },
    }), 'dsh-attention: config')

    const logoPng = loadLogoPng()
    if (logoPng) {
      scope.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-attention/logo.png',
        handler(req, res) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { Allow: 'GET, HEAD' })
            res.end()
            return
          }
          const headers = {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
            'Content-Length': logoPng.length,
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, headers)
            res.end()
            return
          }
          send(res, 200, headers, logoPng)
        },
      }), 'dsh-attention: logo')
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
          reply(req, res, 200, {
            ok: true,
            action: 'open',
            focus: true,
            sessionId: result.sessionId,
          }, htmlOpenSession(runtimeWebUrl, result.sessionId, cfg.openSessionMode))
          return
        }

        finishAct(req, res, record, action, result.message, result.focus)
      },
    }), 'dsh-attention: act')
  })

  ctx.effect(() => () => {
    if (inboxTimer) clearInterval(inboxTimer)
    for (const token of [...byToken.keys()]) forgetToken(token)
    lastToastAt.clear()
    runningBySession.clear()
    sessionKinds.clear()
  }, 'dsh-attention: dispose')
}

export default { name, apply, normalizeConfig }
