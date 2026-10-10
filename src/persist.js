/**
 * 用户在设置页改过的项，写到 ~/.dsh/dsh-attention-ui.json。
 * 启动时盖在 cordis.patch.yml 的 config 上面，这样 UI 改动能活过重启。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const UI_CONFIG_PATH = () => join(homedir(), '.dsh', 'dsh-attention-ui.json')

/**
 * 配置文件的版本号。
 * v1：0 表示「不限制 / 永久」（如停留时长 0 = 不自动消失）。
 * v2：0 统一表示「关闭」，-1 表示「无限」；老配置里的 0 需要一次性迁移成 -1，
 *     靠这个版本号保证只迁移一次——用户升级后自己再填 0 不会被改掉。
 */
export const UI_SCHEMA_VERSION = 2

/** v1 里 0 表示「无限/不限制」的字段，v2 改写成 -1。 */
const LEGACY_ZERO_LIMITS = ['notifyTimeoutSec', 'hiddenReloadMs']

/**
 * 把 v1 的配置迁移到当前版本。纯函数，方便测试。
 * @param raw - 文件里读到的原始对象
 * @returns overlay = 迁移后的对象；migrated = 这次是否真的迁移了
 */
export function migrateUiOverlay(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { overlay: {}, migrated: false }
  const schema = Number(raw.schemaVersion)
  if (Number.isFinite(schema) && schema >= UI_SCHEMA_VERSION) return { overlay: raw, migrated: false }
  const overlay = { ...raw, schemaVersion: UI_SCHEMA_VERSION }
  for (const key of LEGACY_ZERO_LIMITS) {
    if (Object.hasOwn(raw, key) && Number(raw[key]) === 0) overlay[key] = -1
  }
  return { overlay, migrated: true }
}

export const UI_KEYS = [
  'notifyApproval',
  'notifyQuestion',
  'notifyIdle',
  'notifySubagentIdle',
  'notifyStyle',
  'notifyTimeoutSec',
  'cardOpacity',
  'petScale',
  'openSessionMode',
  'focusAfterReply',
  'sound',
  'hiddenReloadMs',
  'settledMax',
]

/** 只保留设置页认识的字段，并带上当前版本号。 */
function serializeOverlay(overlay) {
  const out = {}
  for (const key of UI_KEYS) {
    if (overlay && Object.hasOwn(overlay, key)) out[key] = overlay[key]
  }
  out.schemaVersion = UI_SCHEMA_VERSION
  return out
}

export function readUiOverlay() {
  let raw
  try {
    raw = JSON.parse(readFileSync(UI_CONFIG_PATH(), 'utf8'))
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const { overlay, migrated } = migrateUiOverlay(raw)
  if (migrated) {
    try {
      const path = UI_CONFIG_PATH()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(serializeOverlay(overlay), null, 2)}\n`)
    } catch {
      /* 文件只读时跳过写回，迁移后的值本次仍然生效 */
    }
  }
  const out = {}
  for (const key of UI_KEYS) {
    if (Object.hasOwn(overlay, key)) out[key] = overlay[key]
  }
  return out
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
  writeFileSync(path, `${JSON.stringify(serializeOverlay(next), null, 2)}\n`)
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
