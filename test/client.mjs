import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const flush = () => new Promise((resolve) => setImmediate(resolve))

function boot({ desktop = false, legacy = false, settings = false, settled = [], interaction, react, config } = {}) {
  const timers = new Map()
  const calls = []
  const presence = []
  const listeners = new Map()
  const cache = new Map()
  const sections = []
  const settingsComponents = []
  const configWrites = []
  let current = 'original'
  let clock = 100000
  let reloads = 0
  let statusChanged
  let plugin
  let active = true
  let darkTheme = false
  let themeChanged
  let sessionChanged
  let focused = false
  const services = { uiWorkspace: legacy ? undefined : { openSession: (id) => select(id) } }
  const location = { protocol: desktop ? 'dsh-app:' : 'http:', hash: '', pathname: '/', search: '', reload: () => { reloads++ } }
  const document = {
    visibilityState: 'visible', title: 'DeepSeek Harness', hasFocus: () => focused,
    getElementById: () => null, querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} },
    documentElement: { style: { colorScheme: 'light' } }, body: { hasAttribute: () => darkTheme },
    addEventListener() {}, removeEventListener() {},
  }
  const observable = {
    getSnapshot: () => new Map(interaction ? [['target', legacy ? interaction : { pendingInteraction: interaction }]] : []),
    subscribe: (callback) => { statusChanged = callback; return () => {} },
  }
  const sessions = { list: { getSnapshot: () => ({ current: legacy ? current : undefined }), subscribe: (callback) => { sessionChanged = callback; return () => {} } } }
  const select = (id) => { calls.push(id); current = id; sessionChanged?.() }
  if (legacy) sessions.open = select
  const ctx = {
    sessions,
    uiSession: legacy ? { pendingInteractions: observable } : {
      sessionStatus: observable,
      adapter: { current: { getSnapshot: () => ({ key: current }), subscribe: (callback) => { sessionChanged = callback; return () => {} } } },
    },
    inject: (keys, callback) => {
      if (keys.includes('uiWorkspace') && !services.uiWorkspace) return
      callback({ ...ctx, ...services })
      active = false
    }, effect: (callback) => callback(),
  }
  if (settings) {
    ctx.slots = { inject: (_name, callback) => callback(), register: (options, component) => { sections.push(options.id); settingsComponents.push(component); return () => {} } }
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
      if (settings) return react || { createElement() {} }
      throw new Error('no React')
    }) } },
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    setTimeout() {}, dispatchEvent() {},
  }
  runInNewContext(source, {
    MutationObserver: class { constructor(callback) { themeChanged = callback } observe() {} disconnect() {} },
    window, document, location, console, navigator: {},
    Date: { now: () => clock },
    sessionStorage: { getItem: (key) => cache.get(key), setItem: (key, value) => cache.set(key, value) },
    setInterval: (callback, ms) => { timers.set(ms, callback); return ms }, clearInterval() {},
    fetch: async (path, options) => {
      if (path.endsWith('/presence')) presence.push(JSON.parse(options.body))
      if (path.endsWith('/config') && options?.body) configWrites.push(JSON.parse(options.body))
      const data = path.endsWith('/focus') ? { sessionId: 'target', settled } : { ok: true, hiddenReloadMs: 8000, ...config }
      return { ok: true, json: async () => data }
    },
  })
  plugin.apply(ctx)
  return {
    calls, presence, sections, settingsComponents, configWrites, tick: (ms) => timers.get(ms)(), statusChanged: () => statusChanged(),
    focus: () => listeners.get('focus')(),
    enterSession: (id) => { focused = true; select(id) },
    setTheme: (dark) => { darkTheme = dark; themeChanged() },
    jump: () => { clock += 60000; timers.get(4000)() }, reloads: () => reloads,
  }
}

test('Desktop and Web report resolved theme changes without waiting for the presence interval', async () => {
  for (const desktop of [true, false]) {
    const client = boot({ desktop })
    await flush()
    assert.equal(client.presence.at(-1).theme, 'light')
    client.setTheme(true)
    await flush()
    assert.equal(client.presence.at(-1).theme, 'dark')
    client.setTheme(false)
    await flush()
    assert.equal(client.presence.at(-1).theme, 'light')
  }
})

test('entering a session reports focused presence immediately for Desktop, Web and legacy clients', async () => {
  for (const options of [{ desktop: true }, { desktop: false }, { legacy: true }]) {
    const client = boot(options)
    await flush()
    client.enterSession('completed')
    await flush()
    assert.equal(client.presence.at(-1).sessionId, 'completed')
    assert.equal(client.presence.at(-1).focused, true)
  }
})

test('pet size is shown only for pet mode, previews drafts live, and saves with appearance', async () => {
  const saved = { notifyStyle: 'custom', notifyTimeoutSec: 30, cardOpacity: 0.78, petScale: 1 }
  const states = [saved]
  let hook = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const index = hook++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useRef: (value) => ({ current: value }), useEffect() {},
  }
  const client = boot({ settings: true, react, config: saved })
  const component = client.settingsComponents[0]().type
  const render = () => { hook = 0; return component({ t: (key) => key }) }
  const find = (tree, predicate) => {
    if (!tree) return undefined
    if (Array.isArray(tree)) return tree.map((node) => find(node, predicate)).find(Boolean)
    if (predicate(tree)) return tree
    return find(tree.children, predicate)
  }
  let tree = render()
  assert.equal(find(tree, (node) => node.props?.labelKey === 'petScale'), undefined)
  find(tree, (node) => node.props?.name?.startsWith('dshatt-notify-style')).props.onChange('pet')
  tree = render()
  const slider = find(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'petScale')
  assert.equal(slider.props.min, '50')
  assert.equal(slider.props.max, '200')
  slider.props.onChange({ target: { value: '150' } })
  tree = render()
  find(tree, (node) => node.props?.labelKey === 'cardPreview').props.onChange(true)
  tree = render()
  const preview = find(tree, (node) => node.type === 'img' && node.props.className === 'dshatt_pet_preview')
  assert.equal(preview.props.style.width, 228)
  assert.equal(preview.props.style.height, 228)
  assert.equal(client.configWrites.length, 0, 'changing the preview must not silently save a draft')
  find(tree, (node) => node.props?.key === 'appearance').props.onSave()
  await flush()
  assert.equal(client.configWrites[0].petScale, 1.5)
  assert.equal(client.configWrites[0].notifyStyle, 'pet')
  tree = render()
  assert.equal(find(tree, (node) => node.props?.key === 'appearance').props.dirty, false)
})

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
