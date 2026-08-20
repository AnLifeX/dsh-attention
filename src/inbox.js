/**
 * 本机测底：选择窗把答案写到 jsonl，插件轮询提交。
 * Toast 的自定义协议经常唤不起来；HTTP 也可能被系统代理拐走。
 * 文件在用户目录，只处理内存里还活着的 token。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const workDir = () => join(homedir(), '.dsh', 'dsh-attention-work')

export function inboxPath() {
  return join(workDir(), 'inbox.jsonl')
}

export function pendingPath(token) {
  return join(workDir(), `pending-${String(token)}.json`)
}

export function focusStatePath() {
  return join(workDir(), 'ui-focus.json')
}

export function writeFocusState(data) {
  ensureWorkDir()
  writeFileSync(focusStatePath(), `${JSON.stringify(data)}\n`, 'utf8')
}

export function choiceWindowPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'choice-window.ps1')
}

export function ensureWorkDir() {
  mkdirSync(workDir(), { recursive: true })
}

export function writePending(token, data) {
  ensureWorkDir()
  writeFileSync(pendingPath(token), `${JSON.stringify(data)}\n`, 'utf8')
}

export function removePending(token) {
  try { unlinkSync(pendingPath(token)) } catch { /* 已不在 */ }
}

export function parseInboxText(text) {
  const jobs = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const job = JSON.parse(trimmed)
      if (job && typeof job === 'object') jobs.push(job)
    } catch {
      /* 跳过坏行 */
    }
  }
  return jobs
}

export function drainInbox() {
  const path = inboxPath()
  const tmp = join(workDir(), `inbox-taking-${Date.now()}.jsonl`)
  try {
    renameSync(path, tmp)
  } catch {
    return []
  }
  let text = ''
  try {
    text = readFileSync(tmp, 'utf8')
  } catch {
    return []
  }
  try { unlinkSync(tmp) } catch { /* 读完即可 */ }
  return parseInboxText(text)
}
