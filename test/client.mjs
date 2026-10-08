import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const flush = () => new Promise((resolve) => setImmediate(resolve))

function boot({ desktop = false, legacy = false, settings = false, settled = [], interaction } = {}) {
  const timers = new Map()
  const calls = []
  const presence = []
  const listeners = new Map()
  const cache = new Map()
  const sections = []
  let current = 'original'
  let clock = 100000
  let reloads = 0
  let statusChanged
  let plugin
  let active = true
  const services = { uiWorkspace: legacy ? undefined : { openSession: (id) => select(id) } }
  const location = { protocol: desktop ? 'dsh-app:' : 'http:', hash: '', pathname: '/', search: '', reload: () => { reloads++ } }
  const document = {
    visibilityState: 'visible', title: 'DeepSeek Harness', hasFocus: () => false,
    getElementById: () => null, querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} },
    documentElement: { style: { colorScheme: '' } }, body: { hasAttribute: () => false },
    addEventListener() {}, removeEventListener() {},
  }
  const observable = {
    getSnapshot: () => new Map(interaction ? [['target', legacy ? interaction : { pendingInteraction: interaction }]] : []),
    subscribe: (callback) => { statusChanged = callback; return () => {} },
  }
  const sessions = { list: { getSnapshot: () => ({ current: legacy ? current : undefined }) } }
  const select = (id) => { calls.push(id); current = id }
  if (legacy) sessions.open = select
  const ctx = {
    sessions,
    uiSession: legacy ? { pendingInteractions: observable } : {
      sessionStatus: observable,
      adapter: { current: { getSnapshot: () => ({ key: current }) } },
    },
    inject: (keys, callback) => {
      if (keys.includes('uiWorkspace') && !services.uiWorkspace) return
      callback({ ...ctx, ...services })
      active = false
    }, effect: (callback) => callback(),
  }
  if (settings) {
    ctx.slots = { inject: (_name, callback) => callback(), register: (options) => { sections.push(options.id); return () => {} } }
    ctx.locale = { register: () => () => {}, bind: () => (key) => key }
  }
  Object.defineProperty(ctx, 'uiWorkspace', { get: () => { throw new Error('cannot get property "uiWorkspace" without inject') } })
  for (const key of ['sessions', 'uiSession', 'slots', 'locale']) {
    const value = ctx[key]
    Object.defineProperty(ctx, key, { enumerable: true, get: () => {
      if (!active) throw new Error(`cannot get required service "${key}" in inactive context`)
      return value
    } })
  }
  const window = {
    location,
    __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => {
      if (settings) return { createElement() {} }
      throw new Error('no React')
    }) } },
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener() {},
    matchMedia: () => ({ matches: false }),
  }
  runInNewContext(source, {
    window, document, location, console, navigator: {},
    Date: { now: () => clock },
    sessionStorage: { getItem: (key) => cache.get(key), setItem: (key, value) => cache.set(key, value) },
    setInterval: (callback, ms) => { timers.set(ms, callback); return ms }, clearInterval() {},
    fetch: async (path, options) => {
      if (path.endsWith('/presence')) presence.push(JSON.parse(options.body))
      const data = path.endsWith('/focus') ? { sessionId: 'target', settled } : { hiddenReloadMs: 8000 }
      return { ok: true, json: async () => data }
    },
  })
  plugin.apply(ctx)
  return {
    calls, presence, sections, tick: (ms) => timers.get(ms)(), statusChanged: () => statusChanged(),
    focus: () => listeners.get('focus')(),
    jump: () => { clock += 60000; timers.get(4000)() }, reloads: () => reloads,
  }
}

test('settings register when uiWorkspace is available only in its injected scope', async () => {
  const client = boot({ desktop: true, settings: true })
  await flush()
  assert.deepEqual(client.sections, ['dsh-attention'])
  assert.deepEqual(client.calls, ['target'])
})

test('polling, focus and interaction callbacks work after the root context becomes inactive', async () => {
  let answered = 0
  const client = boot({ desktop: true, settings: true, interaction: {
    kind: 'approval', callId: 'call', answer: () => { answered++ },
  }, settled: [{ id: 'record', sessionId: 'target', kind: 'approval', callId: 'call', value: 'allowed-once' }] })
  await flush()
  client.tick(800)
  client.tick(2000)
  client.focus()
  client.statusChanged()
  await flush()
  assert.equal(answered, 1)
  assert.deepEqual(client.calls, ['target'])
  assert.deepEqual(client.sections, ['dsh-attention'])
  assert.equal(client.presence.at(-1).sessionId, 'target')
})

for (const desktop of [false, true]) {
  test(`${desktop ? 'Desktop' : 'Web'} selects through uiWorkspace and reports the selected session`, async () => {
    const client = boot({ desktop })
    await flush()
    assert.deepEqual(client.calls, ['target'])
    client.tick(800)
    await flush()
    assert.deepEqual(client.calls, ['target'], 'polling must not repeatedly reset navigation')
    client.tick(2000)
    assert.equal(client.presence.at(-1).sessionId, 'target')
    client.jump()
    assert.equal(client.reloads(), desktop ? 0 : 1)
  })
}

test('legacy session navigation and interaction registry still work', async () => {
  let answered = 0
  const interaction = { kind: 'approval', callId: 'call', toolName: 'shell', answer: () => { answered++ } }
  const client = boot({ legacy: true, interaction, settled: [{ id: 'record', sessionId: 'target', kind: 'approval', callId: 'call', value: 'allowed-once' }] })
  await flush()
  assert.deepEqual(client.calls, ['target'])
  assert.equal(answered, 1)
})

test('sessionStatus answers the matching approval once, including synchronous answer errors', async () => {
  const answers = []
  const interaction = { kind: 'approval', callId: 'call', toolName: 'shell', answer: (value) => { answers.push(value); throw new Error('already settled') } }
  const client = boot({ interaction, settled: [{ id: 'record', sessionId: 'target', kind: 'approval', callId: 'call', value: 'allowed-once' }] })
  await flush()
  client.statusChanged()
  client.tick(800)
  await flush()
  assert.deepEqual(answers, ['allowed-once'])
})

test('question call identity prevents an old answer from settling a new question with reused ids', async () => {
  const answers = []
  const interaction = { kind: 'question', callId: 'new-call', questions: [{ id: 'q' }], answer: (value) => { answers.push(value) } }
  const value = { answers: [{ id: 'q', selected: ['yes'] }] }
  const client = boot({ interaction, settled: [
    { id: 'old', sessionId: 'target', kind: 'question', callId: 'old-call', questionIds: ['q'], value },
  ] })
  await flush()
  assert.equal(answers.length, 0)
  interaction.callId = 'old-call'
  client.statusChanged()
  assert.equal(answers.length, 1)
  assert.equal(answers[0].answers[0].selected[0], 'yes')
})

test('a published question is retried after its answer channel becomes ready', async () => {
  let ready = false
  let attempts = 0
  let closed = false
  const interaction = { kind: 'question', questions: [{ id: 'q' }], answer: () => {
    attempts++
    if (!ready) return Promise.reject(new Error('no channel accepts an answer yet'))
    closed = true
    return Promise.resolve()
  } }
  const client = boot({ desktop: true, interaction, settled: [{
    id: 'record', sessionId: 'target', kind: 'question', questionIds: ['q'], value: { answers: [{ id: 'q', selected: ['yes'] }] },
  }] })
  await flush()
  assert.equal(closed, false)
  ready = true
  client.tick(800)
  await flush()
  assert.equal(closed, true)
  client.statusChanged()
  assert.equal(attempts, 2)
})
