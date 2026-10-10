/**
 * 本机测底：选择窗把答案写到 jsonl，插件轮询提交。
 * Toast 的自定义协议经常唤不起来；HTTP 也可能被系统代理拐走。
 * 文件在用户目录，只处理内存里还活着的 token。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const workDir = () => join(homedir(), '.dsh', 'dsh-attention-work')

export function inboxPath(port) {
  return join(workDir(), port ? `inbox-${port}.jsonl` : 'inbox.jsonl')
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
  writeFileSync(pendingPath(token), `${JSON.stringify({ ownerPid: process.pid, ...data })}\n`, 'utf8')
}

export function removePending(token) {
  try { unlinkSync(pendingPath(token)) } catch { /* 已不在 */ }
}

export function cleanupWorkFiles(directory = workDir(), now = Date.now()) {
  let entries
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return 0 }
  const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !/^(pending-.+\.json|inbox-taking-.+\.jsonl)$/.test(entry.name)) continue
    const path = join(directory, entry.name)
    try {
      if (now - statSync(path).mtimeMs < 24 * 60 * 60 * 1000) continue
      if (entry.name.startsWith('pending-')) {
        const marker = /^pending-pet-visible-(\d+)\.json$/.exec(entry.name)
        if (marker && alive(Number(marker[1]))) continue
        // Standalone bubble anchors belong to the adjacent pet heartbeat file.
        const ownerPath = path.endsWith('.json.anchor.json') ? path.slice(0, -'.anchor.json'.length) : path
        let owner
        try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')).ownerPid } catch { /* Old/corrupt orphan. */ }
        if (alive(owner)) continue
      }
      unlinkSync(path)
      removed += 1
    } catch { /* Another process may have removed or locked this file. */ }
  }
  return removed
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

export function drainInbox(port) {
  const path = inboxPath(port)
  const tmp = join(workDir(), `inbox-taking-${port || 'legacy'}-${Date.now()}.jsonl`)
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
  } finally {
    try { unlinkSync(tmp) } catch { /* 读完即可 */ }
  }
  return parseInboxText(text)
}
