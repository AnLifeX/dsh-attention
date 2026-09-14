import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildToastXml,
} from '../src/toast.js'
import {
  clip,
  isLoopbackAddress,
  isLoopbackHost,
  questionToastActions,
  questionToastMode,
  buildQuestionAnswers,
  findPwsh,
  notifyStyleOf,
  notifyTimeoutSecOf,
  openSessionModeOf,
  sessionFocusUrl,
  parseFocusHash,
  soundOf,
  xmlEscape,
} from '../src/util.js'
import {
  createSessionKindTracker,
  createPendingDecision,
  createSettledLog,
  normalizeConfig,
  promptIdle,
  publicConfig,
  sessionKindOf,
  shouldNotifySession,
  racePendingDecision,
  settledMaxOf,
  webServerUrl,
} from '../src/index.js'
import { protocolUri, parseProtocolUri } from '../src/protocol.js'
import { migrateUiOverlay, pickUiFields, sanitizeUiPatch, UI_SCHEMA_VERSION } from '../src/persist.js'

test('xmlEscape covers markup', () => {
  assert.equal(xmlEscape(`a&b<c>"'`), 'a&amp;b&lt;c&gt;&quot;&apos;')
})

test('clip truncates with ellipsis', () => {
  assert.equal(clip('  hello  ', 10), 'hello')
  assert.equal(clip('abcdefghijk', 5).endsWith('…'), true)
})

test('loopback checks', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.2'), false)
  assert.equal(isLoopbackHost('127.0.0.1:3080'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('192.168.1.2:3080'), false)
})

test('question toast actions only for simple single-select', () => {
  assert.deepEqual(questionToastActions([]), [])
  assert.deepEqual(questionToastActions([
    { id: 'q1', question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ]).map((a) => a.id), ['opt0', 'opt1'])
  assert.deepEqual(questionToastActions([
    { id: 'q1', question: 'Go?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
  ]), [])
  assert.deepEqual(questionToastActions([
    { id: 'q1', question: 'Go?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'More?' },
  ]), [])
})

test('protocolUri is path-based so cmd cannot split on &', () => {
  const uri = protocolUri('abc', 'allow')
  assert.equal(uri, 'dsh-attention://do/abc/allow')
  assert.equal(uri.includes('?'), false)
  assert.equal(uri.includes('&'), false)
  assert.equal(uri.includes('http'), false)
  assert.deepEqual(parseProtocolUri(uri), { t: 'abc', a: 'allow' })
  const instanceUri = protocolUri('abc', 'open', 43123)
  assert.equal(instanceUri, 'dsh-attention://do/abc/open/43123')
  assert.deepEqual(parseProtocolUri(instanceUri), { t: 'abc', a: 'open', p: '43123' })
  assert.equal(parseProtocolUri('dsh-attention://act?t=abc&a=opt0').a, 'opt0')
})

test('toast xml contains protocol actions', () => {
  const xml = buildToastXml({
    title: 'dsh · 需要审批',
    lines: ['会话 demo', 'pwsh 提权至 danger-full-access'],
    launchUrl: protocolUri('abc', 'open'),
    sound: 'ms-winsoundevent:Notification.Default',
    actions: [
      { label: '允许一次', url: protocolUri('abc', 'allow'), style: 'success' },
      { label: '拒绝', url: protocolUri('abc', 'reject'), style: 'critical' },
    ],
  })
  assert.match(xml, /<toast /)
  assert.match(xml, /activationType="protocol"/)
  assert.match(xml, /允许一次/)
  assert.match(xml, /dsh-attention:\/\/do\/abc\/allow/)
  assert.match(xml, /hint-buttonStyle="Success"/)
  assert.match(xml, /ToastGeneric/)
  assert.equal(xml.includes('http://'), false)
})

test('timed toast drops reminder so it can auto-hide', () => {
  const timed = buildToastXml({ title: 'dsh', timeoutSec: 30 })
  assert.equal(timed.includes('scenario="reminder"'), false)
  assert.match(timed, /duration="long"/)
  const brief = buildToastXml({ title: 'dsh', timeoutSec: 5 })
  assert.match(brief, /duration="short"/)
  const sticky = buildToastXml({ title: 'dsh', timeoutSec: 0 })
  assert.match(sticky, /scenario="reminder"/)
})

test('sessionFocusUrl puts the session id in the hash', () => {
  assert.equal(sessionFocusUrl('http://127.0.0.1:3080/', 'abc'), 'http://127.0.0.1:3080/#dsh-attention=abc')
  assert.equal(parseFocusHash('#dsh-attention=abc'), 'abc')
  assert.equal(parseFocusHash(''), '')
})

test('system toast may use http only as the open-session fallback', () => {
  const xml = buildToastXml({
    title: 'dsh · 需要审批',
    lines: ['会话 demo'],
    launchUrl: protocolUri('abc', 'open'),
    actions: [
      { label: '打开会话', url: 'http://127.0.0.1:3080/dsh-attention/act?t=abc&a=open' },
    ],
  })
  assert.match(xml, /dsh-attention:\/\/do\/abc\/open/)
  assert.match(xml, /打开会话/)
  assert.match(xml, /http:\/\/127\.0\.0\.1:3080\/dsh-attention\/act\?t=abc&amp;a=open/)
})

test('question toast falls back to compose for multi-select', () => {
  assert.equal(questionToastMode([
    { id: 'q1', question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
  ]), 'compose')
  assert.deepEqual(questionToastActions([
    { id: 'q1', question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
  ]), [])
  assert.deepEqual(buildQuestionAnswers(
    [{ id: 'q1', question: 'Pick', options: [{ label: 'Yes' }, { label: 'No' }] }],
    { questionId: 'q1', selected: ['Yes'] },
  ), [{ id: 'q1', selected: ['Yes'] }])
})

test('buildQuestionAnswers keeps custom on multi-select', () => {
  assert.deepEqual(buildQuestionAnswers(
    [{ id: 'q1', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
    { questionId: 'q1', selected: ['A'], custom: '  extra  ' },
  ), [{ id: 'q1', selected: ['A'], custom: 'extra' }])
  assert.deepEqual(buildQuestionAnswers(
    [{ id: 'q1', options: [{ label: 'A' }] }],
    { questionId: 'q1', selected: ['A'], custom: 'other' },
  ), [{ id: 'q1', selected: [], custom: 'other' }])
})

test('focusExistingArgs never opens a browser url', async () => {
  const { focusExistingArgs } = await import('../src/protocol.js')
  const args = focusExistingArgs('http://127.0.0.1:3080', 'session-abc')
  assert.ok(args.includes('-FocusExisting'))
  assert.ok(args.includes('-ReuseOnly'))
  assert.ok(args.includes('-WebUrl'))
  assert.equal(args.includes('-Uri'), false)
  assert.equal(args.some((item) => /act\?/.test(String(item))), false)
})

test('normalizeConfig keeps enabled false', () => {
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(publicConfig(normalizeConfig({ enabled: false })).enabled, false)
})

test('normalizeConfig fills defaults', () => {
  const cfg = normalizeConfig({ sound: false })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.sound, '')
  assert.equal(cfg.hiddenReloadMs, 8000)
  assert.equal(cfg.focusAfterReply, false)
  assert.equal(cfg.notifyIdle, true)
  assert.equal(cfg.notifySubagentIdle, false)
  assert.equal(cfg.notifyStyle, 'custom')
  assert.equal(cfg.openSessionMode, 'reuse')
  assert.equal(cfg.notifyTimeoutSec, 30)
  assert.equal(cfg.cardOpacity, 0.78)
})

test('webServerUrl follows the current dsh instance port', () => {
  assert.equal(webServerUrl({ port: 43123 }), 'http://127.0.0.1:43123')
  assert.equal(webServerUrl({ port: '43124' }), 'http://127.0.0.1:43124')
  assert.equal(webServerUrl({ port: 0 }), 'http://127.0.0.1:3080')
  assert.equal(webServerUrl({ port: 70000 }), 'http://127.0.0.1:3080')
})

test('legacy rootsOnly does not enable subagent idle notifications', () => {
  assert.equal(normalizeConfig({ rootsOnly: true }).notifySubagentIdle, false)
  assert.equal(normalizeConfig({ rootsOnly: false }).notifySubagentIdle, false)
})

test('session kind uses durable subagent lineage', () => {
  assert.equal(sessionKindOf(undefined), 'unknown')
  assert.equal(sessionKindOf({ header: { origin: 'subagent', delegationDepth: 1 } }), 'subagent')
  assert.equal(sessionKindOf({ header: { delegationDepth: 2 } }), 'subagent')
  assert.equal(sessionKindOf({ header: { delegationDepth: 0 } }), 'primary')
})

test('session kind cache survives subagent disposal before the stopped frame', () => {
  let live = { id: 'child', header: { origin: 'subagent', delegationDepth: 1 } }
  const tracker = createSessionKindTracker(() => live)
  assert.equal(tracker.get('child'), 'subagent')
  live = undefined
  assert.equal(tracker.get('child'), 'subagent')

})

test('immediate mode starts the web answerer and the native decision can still win', async () => {
  const pending = createPendingDecision()
  let delegated = false
  const raced = racePendingDecision(pending, async () => {
    delegated = true
    return new Promise(() => {})
  })
  await Promise.resolve()
  assert.equal(delegated, true)
  assert.equal(pending.settle({ type: 'answer', value: 'allowed-once' }), true)
  assert.equal(await raced, 'allowed-once')
  assert.equal(pending.settle({ type: 'answer', value: 'rejected' }), false)
})

test('immediate mode lets the existing web answerer win the decision race', async () => {
  const pending = createPendingDecision()
  assert.deepEqual(await racePendingDecision(pending, async () => ({ answers: [{ id: 'q1', selected: ['A'] }] })), {
    answers: [{ id: 'q1', selected: ['A'] }],
  })
})

test('settled log keeps a native decision long enough for a sleeping tab', () => {
  let now = 1_000_000
  const log = createSettledLog({ ttlMs: 30_000, max: 10, now: () => now })
  log.push({ id: 't1', sessionId: 's1', at: now })
  now += 25_000
  assert.equal(log.list().length, 1)
  now += 10_000
  assert.equal(log.list().length, 0)
})

test('settled log dedupes by id and caps its size', () => {
  const now = 5_000
  const log = createSettledLog({ ttlMs: 60_000, max: 2, now: () => now })
  log.push({ id: 'a', at: now })
  log.push({ id: 'a', at: now })
  assert.equal(log.list().length, 1)
  log.push({ id: 'b', at: now })
  log.push({ id: 'c', at: now })
  assert.deepEqual(log.list().map((item) => item.id), ['b', 'c'])
})

test('aborting a pending native decision rejects as AbortError', async () => {
  const controller = new AbortController()
  const pending = createPendingDecision(controller.signal)
  const raced = racePendingDecision(pending, () => new Promise(() => {}))
  controller.abort('cancelled')
  await assert.rejects(raced, { name: 'AbortError' })
})

test('findPwsh ignores missing candidates', () => {
  assert.equal(findPwsh({
    PATH: 'D:\\dsh-attention-missing-bin',
    ProgramFiles: 'D:\\dsh-attention-missing-pf',
    'ProgramFiles(x86)': 'D:\\dsh-attention-missing-pf86',
    LOCALAPPDATA: '',
  }), '')
})

if (process.platform === 'win32') {
  test('findPwsh finds pwsh on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-attention-pwsh-'))
    try {
      const fake = join(dir, 'pwsh.exe')
      writeFileSync(fake, '')
      assert.equal(findPwsh({
        PATH: dir,
        ProgramFiles: 'D:\\dsh-attention-missing-pf',
        'ProgramFiles(x86)': 'D:\\dsh-attention-missing-pf86',
        LOCALAPPDATA: '',
      }), fake)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('subagents can only emit the independently controlled idle notification', () => {
  const defaults = normalizeConfig({})
  assert.equal(shouldNotifySession(defaults, 'primary', 'approval'), true)
  assert.equal(shouldNotifySession(defaults, 'primary', 'question'), true)
  assert.equal(shouldNotifySession(defaults, 'primary', 'idle'), true)
  assert.equal(shouldNotifySession(defaults, 'subagent', 'approval'), false)
  assert.equal(shouldNotifySession(defaults, 'subagent', 'question'), false)
  assert.equal(shouldNotifySession(defaults, 'subagent', 'idle'), false)
  assert.equal(shouldNotifySession(normalizeConfig({ notifySubagentIdle: true }), 'subagent', 'idle'), true)
  assert.equal(shouldNotifySession(defaults, 'unknown', 'idle'), false)
})

test('normalizeConfig preserves a zero wake reload value', () => {
  assert.equal(normalizeConfig({ hiddenReloadMs: 0 }).hiddenReloadMs, 0)
})

test('normalizeConfig parses notifyTimeoutSec', () => {
  assert.equal(notifyTimeoutSecOf(undefined), 30)
  assert.equal(notifyTimeoutSecOf(0), 0)
  assert.equal(notifyTimeoutSecOf(12.9), 12)
  assert.equal(notifyTimeoutSecOf(999999), 86400)
  assert.equal(normalizeConfig({}).notifyTimeoutSec, 30)
  assert.equal(normalizeConfig({ notifyTimeoutSec: 0 }).notifyTimeoutSec, 0)
  assert.equal(normalizeConfig({ notifyTimeoutSec: '45' }).notifyTimeoutSec, 45)
})

test('normalizeConfig parses and clamps cardOpacity', () => {
  assert.equal(normalizeConfig({}).cardOpacity, 0.78)
  assert.equal(normalizeConfig({ cardOpacity: 0.5 }).cardOpacity, 0.5)
  assert.equal(normalizeConfig({ cardOpacity: '0.65' }).cardOpacity, 0.65)
  assert.equal(normalizeConfig({ cardOpacity: 2 }).cardOpacity, 1)
  assert.equal(normalizeConfig({ cardOpacity: 0 }).cardOpacity, 0.1)
  assert.equal(publicConfig(normalizeConfig({ cardOpacity: 0.5 })).cardOpacity, 0.5)
})

test('normalizeConfig keeps sound off as empty string', () => {
  assert.equal(soundOf(''), '')
  assert.equal(soundOf(false), '')
  assert.equal(soundOf(null), '')
  assert.equal(normalizeConfig({ sound: '' }).sound, '')
  assert.equal(normalizeConfig({ sound: false }).sound, '')
  assert.equal(publicConfig(normalizeConfig({ sound: '' })).soundEnabled, false)
  assert.equal(normalizeConfig({}).sound, 'ms-winsoundevent:Notification.Default')
  assert.equal(publicConfig(normalizeConfig({})).soundEnabled, true)
})

test('normalizeConfig parses openSessionMode', () => {
  assert.equal(openSessionModeOf('new'), 'new')
  assert.equal(openSessionModeOf('reuse'), 'reuse')
  assert.equal(openSessionModeOf('other'), 'reuse')
  assert.equal(normalizeConfig({}).openSessionMode, 'reuse')
  assert.equal(normalizeConfig({ openSessionMode: 'new' }).openSessionMode, 'new')
})

test('normalizeConfig parses notifyStyle', () => {
  assert.equal(notifyStyleOf('system'), 'system')
  assert.equal(notifyStyleOf('custom'), 'custom')
  assert.equal(notifyStyleOf('other'), 'custom')
  assert.equal(normalizeConfig({}).notifyStyle, 'custom')
  assert.equal(normalizeConfig({ notifyStyle: 'system' }).notifyStyle, 'system')
})

test('normalizeConfig parses focusAfterReply', () => {
  assert.equal(normalizeConfig({ focusAfterReply: true }).focusAfterReply, true)
  assert.equal(normalizeConfig({ focusAfterReply: 'false' }).focusAfterReply, false)
})

test('inbox parser skips blank and bad lines', async () => {
  const { parseInboxText } = await import('../src/inbox.js')
  assert.deepEqual(parseInboxText(''), [])
  assert.deepEqual(parseInboxText('{"t":"abc","a":"allow"}\nnot-json\n'), [
    { t: 'abc', a: 'allow' },
  ])
})

test('inbox parser keeps custom answers', async () => {
  const { parseInboxText } = await import('../src/inbox.js')
  assert.deepEqual(parseInboxText('{"t":"abc","a":"answer","answers":[{"id":"q1","selected":["A"],"custom":"extra"}]}'), [
    { t: 'abc', a: 'answer', answers: [{ id: 'q1', selected: ['A'], custom: 'extra' }] },
  ])
})

test('sanitizeUiPatch drops empty and unknown fields', () => {
  assert.deepEqual(sanitizeUiPatch({}), {})
  assert.deepEqual(sanitizeUiPatch({ notifyStyle: 'system', ignored: 1 }), { notifyStyle: 'system' })
  assert.deepEqual(sanitizeUiPatch({ webUrl: 'http://127.0.0.1:9999' }), {})
  assert.deepEqual(sanitizeUiPatch({ openSessionMode: 'new' }), { openSessionMode: 'new' })
  assert.deepEqual(sanitizeUiPatch({ cardOpacity: 0.5 }), { cardOpacity: 0.5 })
  assert.deepEqual(sanitizeUiPatch({ rootsOnly: true }), {})
  assert.deepEqual(sanitizeUiPatch({ notifySubagents: false, notifySubagentQuestion: true, notifySubagentIdle: true }), {
    notifySubagentIdle: true,
  })
  assert.deepEqual(sanitizeUiPatch({ soundEnabled: false, enabled: undefined }), { soundEnabled: false })
})

test('settled log keeps records forever by default', () => {
  const log = createSettledLog({ now: () => 5_000 })
  log.push({ id: 'old', at: 0 })
  assert.equal(log.list().length, 1)
})

test('settled log honours 0 and -1 limits', () => {
  const now = 1_000
  const unlimited = createSettledLog({ max: -1, now: () => now })
  for (let i = 0; i < 80; i += 1) unlimited.push({ id: `k${i}`, at: now })
  assert.equal(unlimited.list().length, 80)

  const none = createSettledLog({ max: 0, now: () => now })
  none.push({ id: 'a', at: now })
  assert.equal(none.list().length, 0)
})

test('settled log can read a live limit', () => {
  let limit = 2
  const now = 1_000
  const log = createSettledLog({ max: () => limit, now: () => now })
  log.push({ id: 'a', at: now })
  log.push({ id: 'b', at: now })
  log.push({ id: 'c', at: now })
  assert.deepEqual(log.list().map((item) => item.id), ['b', 'c'])
  limit = -1
  log.push({ id: 'd', at: now })
  assert.equal(log.list().length, 3)
})

test('legacy zero limits migrate to -1 exactly once', () => {
  const legacy = { notifyTimeoutSec: 0, hiddenReloadMs: 0, cardOpacity: 0.5 }
  const first = migrateUiOverlay(legacy)
  assert.equal(first.migrated, true)
  assert.equal(first.overlay.notifyTimeoutSec, -1)
  assert.equal(first.overlay.hiddenReloadMs, -1)
  assert.equal(first.overlay.cardOpacity, 0.5)
  assert.equal(first.overlay.schemaVersion, UI_SCHEMA_VERSION)

  const second = migrateUiOverlay(first.overlay)
  assert.equal(second.migrated, false)
  assert.equal(second.overlay.notifyTimeoutSec, -1)
})

test('a zero written after the upgrade stays zero', () => {
  const fresh = migrateUiOverlay({ schemaVersion: UI_SCHEMA_VERSION, hiddenReloadMs: 0, notifyTimeoutSec: 0 })
  assert.equal(fresh.migrated, false)
  assert.equal(fresh.overlay.hiddenReloadMs, 0)
  assert.equal(fresh.overlay.notifyTimeoutSec, 0)
})

test('normalizeConfig accepts -1 as unlimited', () => {
  assert.equal(normalizeConfig({ notifyTimeoutSec: -1 }).notifyTimeoutSec, -1)
  assert.equal(normalizeConfig({ hiddenReloadMs: -1 }).hiddenReloadMs, -1)
  assert.equal(normalizeConfig({ hiddenReloadMs: -5 }).hiddenReloadMs, -1)
  assert.equal(notifyTimeoutSecOf(-1), -1)
  assert.equal(notifyTimeoutSecOf(-100), -1)
})

test('normalizeConfig clamps the settled record limit', () => {
  assert.equal(normalizeConfig({}).settledMax, 50)
  assert.equal(normalizeConfig({ settledMax: 0 }).settledMax, 0)
  assert.equal(normalizeConfig({ settledMax: -1 }).settledMax, -1)
  assert.equal(normalizeConfig({ settledMax: '12' }).settledMax, 12)
  assert.equal(normalizeConfig({ settledMax: 'nope' }).settledMax, 50)
  assert.equal(settledMaxOf(-5), -1)
  assert.equal(settledMaxOf(1e9), 1000000)
})

test('promptIdle hands the session controller an AbortSignal', async () => {
  const calls = []
  const controller = {
    prompt(request, signal) {
      // 宿主实现第一行就是 signal.throwIfAborted()：漏传 signal 会直接抛 TypeError
      signal.throwIfAborted()
      calls.push({ request, signal })
      return { accepted: true }
    },
  }
  const receipt = await promptIdle(controller, { sessionId: 's1' }, '下一步')
  assert.equal(receipt.accepted, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].request.sessionId, 's1')
  assert.equal(calls[0].request.mode, 'queue')
  assert.equal(calls[0].request.content[0].text, '下一步')
  assert.equal(typeof calls[0].signal?.throwIfAborted, 'function')
  assert.equal(calls[0].signal.aborted, false)
})

test('publicConfig exposes UI fields and soundEnabled', () => {
  const cfg = normalizeConfig({ sound: false, focusAfterReply: true })
  const pub = publicConfig(cfg)
  assert.equal(pub.ok, true)
  assert.equal(pub.soundEnabled, false)
  assert.equal(pub.focusAfterReply, true)
  assert.equal(Object.hasOwn(pub, 'webUrl'), false)
  assert.deepEqual(Object.keys(pickUiFields(cfg)).sort(), [
    'cardOpacity',
    'enabled',
    'focusAfterReply',
    'hiddenReloadMs',
    'notifyApproval',
    'notifyIdle',
    'notifyQuestion',
    'notifyStyle',
    'notifySubagentIdle',
    'notifyTimeoutSec',
    'openSessionMode',
    'settledMax',
    'sound',
  ])
})
