import assert from 'node:assert/strict'
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
  notifyStyleOf,
  notifyTimeoutSecOf,
  openSessionModeOf,
  sessionFocusUrl,
  parseFocusHash,
  soundOf,
  xmlEscape,
} from '../src/util.js'
import { normalizeConfig, publicConfig } from '../src/index.js'
import { protocolUri, parseProtocolUri } from '../src/protocol.js'
import { pickUiFields, sanitizeUiPatch } from '../src/persist.js'

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
  const cfg = normalizeConfig({ sound: false, webUrl: 'http://127.0.0.1:3080/' })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.webUrl, 'http://127.0.0.1:3080')
  assert.equal(cfg.sound, '')
  assert.equal(cfg.hiddenReloadMs, 8000)
  assert.equal(cfg.focusAfterReply, false)
  assert.equal(cfg.notifyIdle, true)
  assert.equal(cfg.notifyStyle, 'custom')
  assert.equal(cfg.openSessionMode, 'reuse')
  assert.equal(cfg.notifyTimeoutSec, 30)
  assert.equal(cfg.cardOpacity, 0.78)
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
  assert.deepEqual(sanitizeUiPatch({ openSessionMode: 'new' }), { openSessionMode: 'new' })
  assert.deepEqual(sanitizeUiPatch({ cardOpacity: 0.5 }), { cardOpacity: 0.5 })
  assert.deepEqual(sanitizeUiPatch({ soundEnabled: false, enabled: undefined }), { soundEnabled: false })
})

test('publicConfig exposes UI fields and soundEnabled', () => {
  const cfg = normalizeConfig({ sound: false, focusAfterReply: true })
  const pub = publicConfig(cfg)
  assert.equal(pub.ok, true)
  assert.equal(pub.soundEnabled, false)
  assert.equal(pub.focusAfterReply, true)
  assert.deepEqual(Object.keys(pickUiFields(cfg)).sort(), [
    'cardOpacity',
    'cooldownMs',
    'enabled',
    'focusAfterReply',
    'hiddenReloadMs',
    'notifyApproval',
    'notifyIdle',
    'notifyQuestion',
    'notifyStyle',
    'notifyTimeoutSec',
    'openSessionMode',
    'rootsOnly',
    'sound',
    'webUrl',
  ])
})
