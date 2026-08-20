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
  xmlEscape,
} from '../src/util.js'
import { normalizeConfig } from '../src/index.js'

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

test('toast xml contains protocol actions', () => {
  const xml = buildToastXml({
    title: 'dsh · 需要审批',
    lines: ['会话 demo', 'pwsh 提权至 danger-full-access'],
    launchUrl: 'http://127.0.0.1:3080/dsh-attention/act?t=abc&a=open',
    sound: 'ms-winsoundevent:Notification.Default',
    actions: [
      { label: '允许一次', url: 'http://127.0.0.1:3080/dsh-attention/act?t=abc&a=allow' },
      { label: '拒绝', url: 'http://127.0.0.1:3080/dsh-attention/act?t=abc&a=reject' },
    ],
  })
  assert.match(xml, /<toast /)
  assert.match(xml, /activationType="protocol"/)
  assert.match(xml, /允许一次/)
  assert.match(xml, /a=allow/)
  assert.match(xml, /ToastGeneric/)
})

test('normalizeConfig fills defaults', () => {
  const cfg = normalizeConfig({ sound: false, webUrl: 'http://127.0.0.1:3080/' })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.webUrl, 'http://127.0.0.1:3080')
  assert.equal(cfg.sound, '')
  assert.equal(cfg.hiddenReloadMs, 8000)
})
