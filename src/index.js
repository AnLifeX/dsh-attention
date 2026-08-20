/**
 * dsh-attention — 宿主半边。
 *
 * 不抢 `approval/request` waterfall（那个座位已经被 Web UI 的 apiproxy 占住）。
 * 改为订阅与浏览器同一条 `events.mux`：拿到 `approval/requested` /
 * `question/requested` 的稳定 rpcId，再弹 Windows Toast。
 *
 * Toast 按钮通过本机回环 HTTP 回调 `ctx.apiProxy.respond`，等价于在网页里点
 * 允许/拒绝；点「打开页面」则跳到 dsh Web。网页休眠时宿主仍在跑，所以通知
 * 发得出去——这是浏览器 Notification API 做不到的。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { buildToastXml, fireToast } from './toast.js'
import {
  DEFAULT_AUMID,
  DEFAULT_WEB_URL,
  clip,
  isLoopbackAddress,
  isLoopbackHost,
  questionToastActions,
  shortSessionId,
  trimSlash,
} from './util.js'

export const name = 'dsh-attention'

const DEFAULT_CONFIG = {
  enabled: true,
  rootsOnly: true,
  notifyApproval: true,
  notifyQuestion: true,
  sound: 'ms-winsoundevent:Notification.Default',
  webUrl: DEFAULT_WEB_URL,
  aumid: DEFAULT_AUMID,
  powershellPath: undefined,
  cooldownMs: 1500,
  hiddenReloadMs: 8000,
  titlePrefix: 'dsh',
}

export function normalizeConfig(config) {
  const cfg = { ...DEFAULT_CONFIG }
  if (config && typeof config === 'object') Object.assign(cfg, config)
  cfg.cooldownMs = Math.max(0, Math.floor(Number(cfg.cooldownMs) || 0))
  cfg.hiddenReloadMs = Math.max(0, Math.floor(Number(cfg.hiddenReloadMs) || 0))
  cfg.webUrl = trimSlash(cfg.webUrl || DEFAULT_WEB_URL)
  cfg.sound = cfg.sound === false || cfg.sound === null ? '' : (cfg.sound || DEFAULT_CONFIG.sound)
  return cfg
}

function mintToken() {
  return randomBytes(18).toString('base64url')
}

function htmlPage(title, body, redirect) {
  const jump = redirect
    ? `<meta http-equiv="refresh" content="0;url=${redirect}"><script>location.replace(${JSON.stringify(redirect)})</script>`
    : ''
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;padding:24px">${body}${jump}</body>`
}

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  res.end(body)
}

function isRootSession(session) {
  const depth = session?.header?.delegationDepth
  return depth == null || depth === 0
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
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) return

  /** token → 待处理项；rpcId → token，方便 resolved 时清掉。 */
  const byToken = new Map()
  const byRpcId = new Map()
  const toastedRpc = new Set()
  const lastToastAt = new Map()
  const muxAbort = new AbortController()

  const remember = (record) => {
    byToken.set(record.token, record)
    if (record.rpcId) byRpcId.set(record.rpcId, record.token)
  }

  const forgetRpc = (rpcId) => {
    const token = byRpcId.get(rpcId)
    if (token) byToken.delete(token)
    byRpcId.delete(rpcId)
    toastedRpc.delete(rpcId)
  }

  const actUrl = (token, action) => `${cfg.webUrl}/dsh-attention/act?t=${encodeURIComponent(token)}&a=${encodeURIComponent(action)}`
  const openUrl = (token) => actUrl(token, 'open')

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

  const showApprovalToast = (envelope) => {
    if (!cfg.notifyApproval) return
    const rpcId = envelope.rpcId
    const payload = envelope.payload ?? {}
    if (!rpcId || toastedRpc.has(rpcId)) return
    if (!allowSession(payload.sessionId)) return
    if (cooled(`approval:${payload.sessionId}`)) return

    const token = mintToken()
    const session = sessionOf(payload.sessionId)
    const heading = `${cfg.titlePrefix} · 需要审批`
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

    const xml = buildToastXml({
      title: heading,
      lines: [`会话 ${who}`, why ? `${what} — ${why}` : what],
      launchUrl: openUrl(token),
      sound: cfg.sound,
      actions: [
        { label: '允许一次', url: actUrl(token, 'allow') },
        { label: '拒绝', url: actUrl(token, 'reject') },
        { label: '打开页面', url: openUrl(token) },
      ],
    })
    fireToast(ctx, cfg, xml)
  }

  const showQuestionToast = (envelope) => {
    if (!cfg.notifyQuestion) return
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

    const actions = [
      ...optionActions.map((action) => ({ label: action.label, url: actUrl(token, action.id) })),
      { label: '打开页面', url: openUrl(token) },
    ]

    const xml = buildToastXml({
      title: `${cfg.titlePrefix} · 在等你选择`,
      lines: [`会话 ${who}`, prompt],
      launchUrl: openUrl(token),
      sound: cfg.sound,
      actions,
    })
    fireToast(ctx, cfg, xml)
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

  async function pumpMux(apiProxy) {
    const request = { rpcId: randomUUID(), payload: {} }
    try {
      for await (const envelope of apiProxy.events.mux(request, muxAbort.signal)) {
        try {
          onMuxEnvelope(envelope)
        } catch (error) {
          ctx.logger?.warn?.(`dsh-attention: 处理 mux 帧失败: ${String(error)}`)
        }
      }
    } catch (error) {
      if (muxAbort.signal.aborted) return
      ctx.logger?.warn?.(`dsh-attention: mux 订阅结束: ${String(error)}`)
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

  async function respondQuestion(apiProxy, record, option) {
    return apiProxy.respond({
      type: 'client-response',
      rpcId: record.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: record.sessionId,
          answer: {
            answers: [{
              id: String(option.questionId || record.questions?.[0]?.id || ''),
              selected: [option.selected],
            }],
          },
        },
      },
    })
  }

  ctx.inject(['apiProxy', 'webServer'], (scope) => {
    const { apiProxy, webServer } = scope
    void pumpMux(apiProxy)

    scope.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-attention/config',
      handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const body = JSON.stringify({
          ok: true,
          hiddenReloadMs: cfg.hiddenReloadMs,
          webUrl: cfg.webUrl,
        })
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
      },
    }), 'dsh-attention: config')

    scope.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-attention/act',
      async handler(req, res) {
        if (rejectUnlessLoopback(req, res)) return
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const token = url.searchParams.get('t') ?? ''
        const action = url.searchParams.get('a') ?? ''
        const record = byToken.get(token)
        const redirect = cfg.webUrl

        if (!record) {
          send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' }, htmlPage(
            'dsh-attention',
            '<p>这条通知已经失效（已处理、已过期，或页面已重连）。正在打开 dsh。</p>',
            redirect,
          ))
          return
        }

        if (action === 'open') {
          send(res, 302, { Location: redirect }, '')
          return
        }

        try {
          let receipt
          if (record.kind === 'approval' && (action === 'allow' || action === 'reject')) {
            receipt = await respondApproval(apiProxy, record, action === 'allow' ? 'allowed-once' : 'rejected')
          } else if (record.kind === 'question' && action.startsWith('opt')) {
            const option = (record.optionActions ?? []).find((item) => item.id === action)
            if (!option) {
              send(res, 400, { 'Content-Type': 'text/html; charset=utf-8' }, htmlPage(
                'dsh-attention',
                '<p>未知选项。请到网页里回答。</p>',
                redirect,
              ))
              return
            }
            receipt = await respondQuestion(apiProxy, record, option)
          } else {
            send(res, 400, { 'Content-Type': 'text/html; charset=utf-8' }, htmlPage(
              'dsh-attention',
              '<p>这个按钮对当前请求不可用。请打开网页处理。</p>',
              redirect,
            ))
            return
          }

          if (receipt?.accepted !== true) {
            send(res, 409, { 'Content-Type': 'text/html; charset=utf-8' }, htmlPage(
              'dsh-attention',
              `<p>提交未被接受（${receipt?.reason ?? 'unknown'}）。可能网页里已经点过了。正在打开 dsh。</p>`,
              redirect,
            ))
            return
          }

          forgetRpc(record.rpcId)
          const done = action === 'allow' ? '已允许一次' : action === 'reject' ? '已拒绝' : '已提交选择'
          send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, htmlPage(
            'dsh-attention',
            `<p>${done}。正在打开 dsh。</p>`,
            redirect,
          ))
        } catch (error) {
          send(res, 500, { 'Content-Type': 'text/html; charset=utf-8' }, htmlPage(
            'dsh-attention',
            `<p>提交失败：${String(error)}</p>`,
            redirect,
          ))
        }
      },
    }), 'dsh-attention: act')
  })

  ctx.effect(() => () => {
    muxAbort.abort()
    byToken.clear()
    byRpcId.clear()
    toastedRpc.clear()
    lastToastAt.clear()
  }, 'dsh-attention: dispose')
}

export default { name, apply, normalizeConfig }
