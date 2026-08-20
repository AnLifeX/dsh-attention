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
  xmlEscape,
} from '../src/util.js'
import { normalizeConfig, publicConfig } from '../src/index.js'
import { protocolUri, parseProtocolUri } from '../src/protocol.js'
import { pickUiFields } from '../src/persist.js'

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

test('publicConfig exposes UI fields and soundEnabled', () => {
  const cfg = normalizeConfig({ sound: false, focusAfterReply: true })
  const pub = publicConfig(cfg)
  assert.equal(pub.ok, true)
  assert.equal(pub.soundEnabled, false)
  assert.equal(pub.focusAfterReply, true)
  assert.deepEqual(Object.keys(pickUiFields(cfg)).sort(), [
    'cooldownMs',
    'enabled',
    'focusAfterReply',
    'hiddenReloadMs',
    'notifyApproval',
    'notifyIdle',
    'notifyQuestion',
    'notifyStyle',
    'rootsOnly',
    'sound',
    'webUrl',
  ])
})
