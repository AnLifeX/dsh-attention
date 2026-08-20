/**
 * dsh-attention — 宿主半边。
 *
 * 不抢 `approval/request` waterfall（那个座位已经被 Web UI 的 apiproxy 占住）。
 * 改为订阅与浏览器同一条 `events.mux`：拿到 `approval/requested` /
 * `question/requested` 的稳定 rpcId，再弹 Windows Toast。
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
import { focusExistingArgs, handlerScriptPath, protocolUri, registerProtocol } from './protocol.js'
import { pickUiFields, readUiOverlay, sanitizeUiPatch, writeUiOverlay } from './persist.js'
import { renderReplyHtml } from './ui-page.js'
import { choiceWindowPath, drainInbox, removePending, writePending } from './inbox.js'
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
  questionToastActions,
  soundOf,
  powershell51,
  buildQuestionAnswers,
  sessionFocusUrl,
  shortSessionId,
  trimSlash,
} from './util.js'

export const name = 'dsh-attention'

const DEFAULT_CONFIG = {
  enabled: true,
  rootsOnly: true,
  notifyApproval: true,
  notifyQuestion: true,
  notifyIdle: true,
  notifyStyle: 'custom',
  notifyTimeoutSec: 30,
  focusAfterReply: false,
  sound: DEFAULT_SOUND,
  webUrl: DEFAULT_WEB_URL,
  aumid: DEFAULT_AUMID,
  powershellPath: undefined,
  cooldownMs: 1500,
  hiddenReloadMs: 8000,
  presenceStaleMs: 5000,
  titlePrefix: 'dsh',
}

export function normalizeConfig(config) {
  const cfg = { ...DEFAULT_CONFIG }
  if (config && typeof config === 'object') Object.assign(cfg, config)
  cfg.enabled = asBool(cfg.enabled, true)
  cfg.rootsOnly = asBool(cfg.rootsOnly, true)
  cfg.notifyApproval = asBool(cfg.notifyApproval, true)
  cfg.notifyQuestion = asBool(cfg.notifyQuestion, true)
  cfg.notifyIdle = asBool(cfg.notifyIdle, true)
  cfg.notifyStyle = notifyStyleOf(cfg.notifyStyle)
  cfg.notifyTimeoutSec = notifyTimeoutSecOf(cfg.notifyTimeoutSec)
  cfg.focusAfterReply = asBool(cfg.focusAfterReply, false)
  cfg.cooldownMs = Math.max(0, Math.floor(Number(cfg.cooldownMs) || 0))
  cfg.hiddenReloadMs = Math.max(0, Math.floor(Number(cfg.hiddenReloadMs) || 0))
  cfg.presenceStaleMs = Math.max(1000, Math.floor(Number(cfg.presenceStaleMs) || DEFAULT_CONFIG.presenceStaleMs))
  cfg.webUrl = trimSlash(cfg.webUrl || DEFAULT_WEB_URL)
  cfg.sound = soundOf(cfg.sound, DEFAULT_CONFIG.sound)
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

/** Toast 的 http 回退：不要 window.close() 把人送回错标签，把这个标签变成 dsh。 */
function htmlOpenSession(webUrl, sessionId) {
  const dest = sessionFocusUrl(webUrl, sessionId)
  return `<!doctype html><meta charset="utf-8"><title>dsh</title>
<body style="font-family:sans-serif;padding:24px">
<p>正在打开会话…</p>
<script>
(function(){
  var dest = ${JSON.stringify(dest)};
  var sid = ${JSON.stringify(String(sessionId ?? ''))};
  var name = "dsh-web";
  try {
    var ch = new BroadcastChannel("dsh-attention");
    ch.postMessage({ type: "focus", sessionId: sid });
    ch.close();
  } catch (e) {}
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

function isRootSession(session) {
  const depth = session?.header?.delegationDepth
  return depth == null || depth === 0
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
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'logo-a-bell.png'))
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
  registerProtocol(cfg, ctx.logger)

  /** token → 待处理项；rpcId → token，方便 resolved 时清掉。 */
  const byToken = new Map()
  const byRpcId = new Map()
  const toastedRpc = new Set()
  const lastToastAt = new Map()
  const runningBySession = new Map()
  const muxAbort = new AbortController()
  let lastUiFocusedAt = 0
  const pendingFocus = { sessionId: null, until: 0 }

  const remember = (record) => {
    byToken.set(record.token, record)
    if (record.rpcId) byRpcId.set(record.rpcId, record.token)
  }

  const forgetToken = (token) => {
    const record = byToken.get(token)
    byToken.delete(token)
    removePending(token)
    if (record?.rpcId) {
      byRpcId.delete(record.rpcId)
      toastedRpc.delete(record.rpcId)
    }
  }

  const forgetRpc = (rpcId) => {
    const token = byRpcId.get(rpcId)
    if (token) {
      byToken.delete(token)
      removePending(token)
    }
    byRpcId.delete(rpcId)
    toastedRpc.delete(rpcId)
  }

  const forgetIdleFor = (sessionId) => {
    for (const record of [...byToken.values()]) {
      if (record.kind === 'idle' && record.sessionId === sessionId) forgetToken(record.token)
    }
  }

  const openUrl = (token) => protocolUri(token, 'open')
  const httpOpenUrl = (token) => `${cfg.webUrl}/dsh-attention/act?t=${encodeURIComponent(token)}&a=open`

  const toastChrome = () => ({
    imageUrl: `${cfg.webUrl}/dsh-attention/logo.png`,
    attribution: '提醒',
  })

  const choiceLabels = () => ({
    kicker: '提醒',
    title: '提醒',
    submit: '提交',
    close: '关闭',
    closeX: '×',
    send: '发送',
    allow: '允许',
    reject: '拒绝',
    placeholder: '下一步想让它做什么…',
    customPlaceholder: '输入你的答案',
    openSession: '回到会话',
    empty: '先写一句再发送。',
    missing: '还有选项没选。',
    done: '已提交',
    expired: '这条已经失效。',
  })

  const openChoiceWindow = (token) => {
    if (process.platform !== 'win32') return
    const ps = cfg.powershellPath || powershell51()
    try {
      spawn(
        ps,
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
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attention: 无法打开选择窗: ${String(error)}`)
    }
  }

  const focusExistingWindow = (sessionId) => {
    if (process.platform !== 'win32') return
    const ps = cfg.powershellPath || powershell51()
    try {
      spawn(
        ps,
        [
          '-NoProfile',
          '-STA',
          '-WindowStyle', 'Hidden',
          '-ExecutionPolicy', 'Bypass',
          '-File', handlerScriptPath(),
          ...focusExistingArgs(cfg.webUrl, sessionId),
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attention: 无法前置已有窗口: ${String(error)}`)
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

  const allowSession = (sessionId) => {
    if (!cfg.rootsOnly) return true
    const session = sessionOf(sessionId)
    if (!session) return true
    return isRootSession(session)
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

  const showApprovalToast = (envelope) => {
    if (!cfg.enabled || !cfg.notifyApproval || uiFocused()) return
    const rpcId = envelope.rpcId
    const payload = envelope.payload ?? {}
    if (!rpcId || toastedRpc.has(rpcId)) return
    if (!allowSession(payload.sessionId)) return
    if (cooled(`approval:${payload.sessionId}`)) return

    const token = mintToken()
    const session = sessionOf(payload.sessionId)
    const who = session ? resolveTitle(ctx, session) : `#${shortSessionId(payload.sessionId)}`
    const reason = String(payload.reason ?? '')
    const escalation = /^escalate sandbox to (\S+):\s*(.*)$/.exec(reason)
    const what = escalation
      ? `${payload.toolName ?? '工具'} 提权至 ${escalation[1]}`
      : `${payload.toolName ?? '工具'} 请求审批`
    const why = clip(escalation ? escalation[2] : reason, 120)

    remember({
      kind: 'approval',
      token,
      rpcId,
      sessionId: payload.sessionId,
      approvalId: payload.approvalId,
      createdAt: Date.now(),
    })
    toastedRpc.add(rpcId)
    if (cfg.notifyStyle === 'system') {
      fireSystemToast(token, `${cfg.titlePrefix} · 需要审批`, [
        `会话 ${who}`,
        why ? `${what} — ${why}` : what,
        '点击通知回到该会话，在页面里处理',
      ])
      return
    }
    writePending(token, {
      token,
      kind: 'approval',
      session: clip(who, 22),
      heading: '需要审批',
      sub: why ? `${what} — ${why}` : what,
      timeoutSec: cfg.notifyTimeoutSec,
      webUrl: cfg.webUrl,
      playSound: Boolean(cfg.sound),
      labels: choiceLabels(),
    })
    openChoiceWindow(token)
  }

  const showQuestionToast = (envelope) => {
    if (!cfg.enabled || !cfg.notifyQuestion || uiFocused()) return
    const rpcId = envelope.rpcId
    const payload = envelope.payload ?? {}
    if (!rpcId || toastedRpc.has(rpcId)) return
    if (!allowSession(payload.sessionId)) return
    if (cooled(`question:${payload.sessionId}`)) return

    const questions = Array.isArray(payload.questions) ? payload.questions : []
    const token = mintToken()
    const session = sessionOf(payload.sessionId)
    const who = session ? resolveTitle(ctx, session) : `#${shortSessionId(payload.sessionId)}`
    const first = questions[0]
    const prompt = clip(first?.question ?? '需要你做选择', 80)
    const optionActions = questionToastActions(questions)

    remember({
      kind: 'question',
      token,
      rpcId,
      sessionId: payload.sessionId,
      questions,
      optionActions,
      createdAt: Date.now(),
    })
    toastedRpc.add(rpcId)
    if (cfg.notifyStyle === 'system') {
      fireSystemToast(token, `${cfg.titlePrefix} · 在等你选择`, [
        `会话 ${who}`,
        prompt,
        '点击通知回到该会话，在页面里选择',
      ])
      return
    }
    writePending(token, {
      token,
      kind: 'question',
      session: clip(who, 22),
      heading: prompt,
      questions,
      timeoutSec: cfg.notifyTimeoutSec,
      webUrl: cfg.webUrl,
      playSound: Boolean(cfg.sound),
      labels: choiceLabels(),
    })
    openChoiceWindow(token)
  }

  const showIdleToast = (sessionId) => {
    if (!cfg.enabled || !cfg.notifyIdle || uiFocused()) return
    if (!allowSession(sessionId)) return
    if (cooled(`idle:${sessionId}`)) return

    forgetIdleFor(sessionId)
    const token = mintToken()
    const session = sessionOf(sessionId)
    const who = session ? resolveTitle(ctx, session) : `#${shortSessionId(sessionId)}`

    remember({
      kind: 'idle',
      token,
      sessionId,
      createdAt: Date.now(),
    })
    if (cfg.notifyStyle === 'system') {
      fireSystemToast(token, `${cfg.titlePrefix} · 会话已结束`, [
        `会话 ${who}`,
        '点击通知回到该会话，在页面里写下一步',
      ])
      return
    }
    writePending(token, {
      token,
      kind: 'idle',
      session: clip(who, 22),
      heading: '会话已结束',
      timeoutSec: cfg.notifyTimeoutSec,
      webUrl: cfg.webUrl,
      playSound: Boolean(cfg.sound),
      labels: choiceLabels(),
    })
    openChoiceWindow(token)
  }

  const onMuxEnvelope = (envelope) => {
    const payload = envelope?.payload
    const type = payload?.type
    if (type === 'approval/requested') {
      showApprovalToast(envelope)
      return
    }
    if (type === 'question/requested') {
      showQuestionToast(envelope)
      return
    }
    if (type === 'approval/resolved') {
      for (const record of byToken.values()) {
        if (record.kind === 'approval' && record.approvalId === payload.approvalId) {
          forgetRpc(record.rpcId)
          break
        }
      }
      return
    }
    if (type === 'question/resolved') {
      forgetRpc(payload.questionRpcId ?? envelope.rpcId)
    }
  }

  const onHostEnvelope = (envelope) => {
    const payload = envelope?.payload
    if (payload?.type !== 'host/session-status') return
    const sessionId = payload.sessionId
    const running = payload.running === true
    const prev = runningBySession.get(sessionId)
    runningBySession.set(sessionId, running)
    if (running) {
      forgetIdleFor(sessionId)
      return
    }
    if (prev === true && running === false) showIdleToast(sessionId)
  }

  async function pumpStream(label, iterator) {
    try {
      for await (const envelope of iterator) {
        try {
          if (label === 'mux') onMuxEnvelope(envelope)
          else onHostEnvelope(envelope)
        } catch (error) {
          ctx.logger?.warn?.(`dsh-attention: 处理 ${label} 帧失败: ${String(error)}`)
        }
      }
    } catch (error) {
      if (muxAbort.signal.aborted) return
      ctx.logger?.warn?.(`dsh-attention: ${label} 订阅结束: ${String(error)}`)
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

  async function respondApproval(apiProxy, record, outcome) {
    return apiProxy.respond({
      type: 'client-response',
      rpcId: record.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: record.sessionId,
          approvalId: record.approvalId,
          outcome,
        },
      },
    })
  }

  async function respondQuestion(apiProxy, record, answers) {
    return apiProxy.respond({
      type: 'client-response',
      rpcId: record.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: record.sessionId,
          answer: { answers },
        },
      },
    })
  }

  async function promptIdle(apiProxy, record, text) {
    return apiProxy.sessions.prompt({
      rpcId: randomUUID(),
      payload: {
        sessionId: record.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
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

  async function runAct(apiProxy, token, action, extra = {}) {
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
        const text = String(extra.text ?? '').trim()
        if (!text) return { ok: false, error: 'empty' }
        const receipt = await promptIdle(apiProxy, record, text)
        if (!receiptOk(receipt)) return { ok: false, error: 'rejected' }
        forgetToken(record.token)
        const focus = shouldFocusAfter(action)
        if (focus) requestFocus(record.sessionId)
        return { ok: true, action, message: '已发送下一步', focus, sessionId: record.sessionId }
      }

      let receipt
      if (record.kind === 'approval' && (action === 'allow' || action === 'reject')) {
        receipt = await respondApproval(apiProxy, record, action === 'allow' ? 'allowed-once' : 'rejected')
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
        receipt = await respondQuestion(apiProxy, record, answers)
      } else {
        return { ok: false, error: 'bad-action' }
      }

      if (receipt?.accepted !== true) {
        ctx.logger?.warn?.(`dsh-attention: respond rejected ${receipt?.reason ?? 'unknown'} action=${action}`)
        return { ok: false, error: receipt?.reason ?? 'unknown' }
      }

      forgetRpc(record.rpcId)
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

  ctx.inject(['apiProxy', 'webServer'], (scope) => {
    const { apiProxy, webServer } = scope
    void pumpStream('mux', apiProxy.events.mux({ rpcId: randomUUID(), payload: {} }, muxAbort.signal))
    void pumpStream('host', apiProxy.events.host({ rpcId: randomUUID(), payload: {} }, muxAbort.signal))
    inboxTimer = setInterval(() => {
      for (const job of drainInbox()) {
        const token = String(job?.t ?? '')
        const action = String(job?.a ?? '')
        if (!token || !action) continue
        void runAct(apiProxy, token, action, {
          answers: job.answers,
          text: job.text,
        }).then((result) => {
          if (!result?.ok) ctx.logger?.warn?.(`dsh-attention: inbox ${action} ${result?.error ?? 'failed'}`)
          else {
            ctx.logger?.info?.(`dsh-attention: inbox ${action} ok`)
            if (result.focus && result.sessionId) focusExistingWindow(result.sessionId)
          }
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
          registerProtocol(cfg, ctx.logger)
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
        sendJson(res, 200, { ok: true, sessionId: currentFocus() })
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

        const result = await runAct(apiProxy, token, action, {
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
          }, htmlOpenSession(cfg.webUrl, result.sessionId))
          return
        }

        finishAct(req, res, record, action, result.message, result.focus)
      },
    }), 'dsh-attention: act')
  })

  ctx.effect(() => () => {
    muxAbort.abort()
    if (inboxTimer) clearInterval(inboxTimer)
    byToken.clear()
    byRpcId.clear()
    toastedRpc.clear()
    lastToastAt.clear()
    runningBySession.clear()
  }, 'dsh-attention: dispose')
}

export default { name, apply, normalizeConfig }
