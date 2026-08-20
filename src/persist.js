/**
 * 用户在设置页改过的项，写到 ~/.dsh/dsh-attention-ui.json。
 * 启动时盖在 cordis.patch.yml 的 config 上面，这样 UI 改动能活过重启。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const UI_CONFIG_PATH = () => join(homedir(), '.dsh', 'dsh-attention-ui.json')

export const UI_KEYS = [
  'enabled',
  'rootsOnly',
  'notifyApproval',
  'notifyQuestion',
  'notifyIdle',
  'notifyStyle',
  'focusAfterReply',
  'sound',
  'webUrl',
  'hiddenReloadMs',
  'cooldownMs',
]

export function readUiOverlay() {
  try {
    const raw = JSON.parse(readFileSync(UI_CONFIG_PATH(), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const key of UI_KEYS) {
      if (Object.hasOwn(raw, key)) out[key] = raw[key]
    }
    return out
  } catch {
    return {}
  }
}

export function writeUiOverlay(partial) {
  const next = { ...readUiOverlay() }
  if (partial && typeof partial === 'object') {
    for (const key of UI_KEYS) {
      if (Object.hasOwn(partial, key)) next[key] = partial[key]
    }
  }
  const path = UI_CONFIG_PATH()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export function pickUiFields(cfg) {
  const out = {}
  for (const key of UI_KEYS) out[key] = cfg[key]
  return out
}
