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
  'notifyApproval',
  'notifyQuestion',
  'notifyIdle',
  'notifySubagentIdle',
  'notifyStyle',
  'notifyTimeoutSec',
  'cardOpacity',
  'openSessionMode',
  'focusAfterReply',
  'sound',
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
  const next = {}
  const previous = readUiOverlay()
  for (const key of UI_KEYS) {
    if (Object.hasOwn(previous, key)) next[key] = previous[key]
  }
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

/** 只留下设置页能改的字段，丢掉 undefined，避免空 patch 把界面写回默认。 */
export function sanitizeUiPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {}
  const out = {}
  for (const key of UI_KEYS) {
    if (Object.hasOwn(patch, key) && patch[key] !== undefined) out[key] = patch[key]
  }
  if (Object.hasOwn(patch, 'soundEnabled') && patch.soundEnabled !== undefined) {
    out.soundEnabled = patch.soundEnabled
  }
  return out
}
