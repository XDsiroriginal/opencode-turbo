import type { Plugin } from "@opencode-ai/plugin"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type Budget = {
  maxLines: number
  maxBytes: number
  head: number
  tail: number
  priority: number
}

type TurboOptions = {
  enabled?: boolean
  smallModel?: string | false
  protectTools?: string[]
  priorityPattern?: string
  fresh?: Partial<Budget>
  old?: Partial<Budget>
  keepTurns?: number
  historyThresholdBytes?: number
  metrics?: boolean
}

type ToolPartLike = {
  type: string
  tool?: string
  state?: { status?: string; output?: string; time?: { compacted?: number } }
}

type MessageLike = {
  info?: { role?: string }
  parts?: ToolPartLike[]
}

const DEFAULT_FRESH: Budget = { maxLines: 250, maxBytes: 12000, head: 140, tail: 60, priority: 40 }
const DEFAULT_OLD: Budget = { maxLines: 70, maxBytes: 3000, head: 40, tail: 20, priority: 15 }
const DEFAULT_PROTECT = ["skill", "task"]
const DEFAULT_PRIORITY =
  "\\b(error|errors|failed|failure|fatal|exception|traceback|denied|refused|not found|cannot|could not|unable|warning|ENOENT|EACCES|ECONNREFUSED|exit code|exit status)\\b"
const DEFAULT_SMALL_MODEL = "ollama/qwen2.5:7b"
const DEFAULT_HISTORY_THRESHOLD = 3000

const xdg = (env: string, fallback: string) => process.env[env] || path.join(os.homedir(), fallback)
const OUTPUT_DIR = path.join(xdg("XDG_DATA_HOME", path.join(".local", "share")), "opencode", "tool-output")
const CONFIG_DIR = path.join(xdg("XDG_CONFIG_HOME", ".config"), "opencode")
const METRICS_FILE = path.join(CONFIG_DIR, "turbo-metrics.jsonl")
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SOURCE_BYTES = 12 * 1024 * 1024
const METRICS_CAP = 2 * 1024 * 1024

const byteLen = (value: string) => Buffer.byteLength(value, "utf8")
const kb = (value: number) => `${(value / 1024).toFixed(1)} KB`

const envBool = (name: string, fallback: boolean) => {
  const value = process.env[name]
  if (value === undefined || value === "") return fallback
  return !/^(0|false|no|off)$/i.test(value)
}

const envNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const envList = (name: string, fallback: string[]) => {
  const value = process.env[name]
  if (!value) return fallback
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function resolveBudget(override: Partial<Budget> | undefined, fallback: Budget): Budget {
  if (!override) return fallback
  return {
    maxLines: override.maxLines ?? fallback.maxLines,
    maxBytes: override.maxBytes ?? fallback.maxBytes,
    head: override.head ?? fallback.head,
    tail: override.tail ?? fallback.tail,
    priority: override.priority ?? fallback.priority,
  }
}

function fits(text: string, limit: Budget) {
  return text.split("\n").length <= limit.maxLines && byteLen(text) <= limit.maxBytes
}

function trustedPointer(text: string) {
  const raw = text.match(/Full output saved to: (.+)$/m)?.[1]?.trim()
  if (!raw) return undefined
  const resolved = path.resolve(raw)
  const root = path.resolve(OUTPUT_DIR)
  const norm = process.platform === "win32" ? (p: string) => p.toLowerCase() : (p: string) => p
  const f = norm(resolved)
  const r = norm(root)
  if (f !== r && !f.startsWith(r + path.sep)) return undefined
  return resolved
}

function isMetaLine(line: string) {
  return (
    line.includes("Full output saved to:") ||
    line.includes("output was truncated") ||
    line.includes("Use Grep to search") ||
    line.includes("Use the Task tool to have explore") ||
    line.includes("[turbo]")
  )
}

const savedFiles = new Map<string, string>()
let lastCleanup = 0

function cleanup() {
  const now = Date.now()
  if (now - lastCleanup < 10 * 60 * 1000) return
  lastCleanup = now
  let entries: string[]
  try {
    entries = fs.readdirSync(OUTPUT_DIR)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith("turbo_")) continue
    try {
      const file = path.join(OUTPUT_DIR, entry)
      if (now - fs.statSync(file).mtimeMs > RETENTION_MS) fs.rmSync(file, { force: true })
    } catch {
      continue
    }
  }
}

function saveFull(text: string) {
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 16)
  const cached = savedFiles.get(hash)
  if (cached) return cached
  const file = path.join(OUTPUT_DIR, `turbo_${hash}.txt`)
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
    if (!fs.existsSync(file)) fs.writeFileSync(file, text, "utf8")
    cleanup()
  } catch {
    return file
  }
  savedFiles.set(hash, file)
  return file
}

function readFull(file: string) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return undefined
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function clamp(head: string[], middle: string[], tail: string[], limit: Budget) {
  let h = head
  let m = middle
  let t = tail
  const join = () => [...h, ...m, ...t].join("\n")
  while (join().split("\n").length > limit.maxLines || byteLen(join()) > limit.maxBytes) {
    if (m.length > 0) {
      m = m.slice(1)
      continue
    }
    if (t.length > 0) {
      t = t.slice(1)
      continue
    }
    if (h.length > 1) {
      h = h.slice(0, -1)
      continue
    }
    break
  }
  return join()
}

function compress(text: string, limit: Budget, priorityRe: RegExp) {
  const hinted = trustedPointer(text)
  const recovered = hinted ? readFull(hinted) : undefined
  const rebuild = recovered !== undefined
  const full = recovered ?? text

  if (!rebuild && fits(text, limit)) return text

  const lines = full.split("\n").filter((line) => !isMetaLine(line))

  if (fits(lines.join("\n"), limit)) return lines.join("\n")

  const file = hinted ?? saveFull(text)
  const headEnd = Math.min(limit.head, lines.length)
  const tailStart = Math.max(headEnd, lines.length - limit.tail)
  const head = lines.slice(0, headEnd)
  const tail = lines.slice(tailStart)
  const middle = lines.slice(headEnd, tailStart)

  const seen = new Set([...head, ...tail])
  const priority: string[] = []
  for (const line of middle) {
    if (priority.length >= limit.priority) break
    if (!priorityRe.test(line) || seen.has(line)) continue
    seen.add(line)
    priority.push(line)
  }

  const omitted = Math.max(0, lines.length - head.length - priority.length - tail.length)
  const note = `[turbo] ${omitted} of ${lines.length} lines omitted (${kb(byteLen(full))}). Full output saved to: ${file}`
  return clamp(head, [...priority, note], tail, limit)
}

function completedOutput(part: ToolPartLike, protect: Set<string>) {
  if (part.type !== "tool") return undefined
  if (part.state?.status !== "completed") return undefined
  if (part.state.time?.compacted) return undefined
  if (!part.tool || protect.has(part.tool)) return undefined
  const value = part.state.output
  return typeof value === "string" && value.length > 0 ? value : undefined
}

let metricsBytes = 0

function metric(record: Record<string, unknown>) {
  const line = JSON.stringify({ t: Date.now(), ...record }) + "\n"
  try {
    if (metricsBytes === 0) {
      try {
        metricsBytes = fs.statSync(METRICS_FILE).size
      } catch {
        metricsBytes = 0
      }
    }
    if (metricsBytes > METRICS_CAP) {
      fs.rmSync(METRICS_FILE + ".1", { force: true })
      fs.renameSync(METRICS_FILE, METRICS_FILE + ".1")
      metricsBytes = 0
    }
    fs.mkdirSync(path.dirname(METRICS_FILE), { recursive: true })
    fs.appendFileSync(METRICS_FILE, line, "utf8")
    metricsBytes += byteLen(line)
  } catch {
    return
  }
}

const plugin: Plugin = async (_input, options) => {
  const opts = (options ?? {}) as TurboOptions
  const enabled = opts.enabled ?? envBool("OPENCODE_TURBO", true)
  const protect = new Set(opts.protectTools ?? envList("OPENCODE_TURBO_PROTECT_TOOLS", DEFAULT_PROTECT))
  const priorityRe = new RegExp(opts.priorityPattern ?? DEFAULT_PRIORITY, "i")
  const fresh = resolveBudget(opts.fresh, DEFAULT_FRESH)
  const old = resolveBudget(opts.old, DEFAULT_OLD)
  const keepTurns = Math.max(1, opts.keepTurns ?? envNumber("OPENCODE_TURBO_KEEP_TURNS", 2))
  const historyThreshold = opts.historyThresholdBytes ?? envNumber("OPENCODE_TURBO_HISTORY_THRESHOLD", DEFAULT_HISTORY_THRESHOLD)
  const metricsOn = opts.metrics ?? envBool("OPENCODE_TURBO_METRICS", true)
  const envSmallModel = process.env.OPENCODE_TURBO_SMALL_MODEL
  const smallModel = opts.smallModel ?? (envSmallModel === undefined ? undefined : envSmallModel || false)
  const started = new Map<string, number>()
  let savedBytes = 0

  return {
    config: async (cfg) => {
      if (!enabled) return
      const main = typeof cfg.model === "string" ? cfg.model : ""
      const explicit = smallModel !== undefined && smallModel !== false
      if (!main && !explicit) return
      if (!explicit && cfg.small_model && cfg.small_model !== main) return
      const target = smallModel === undefined ? DEFAULT_SMALL_MODEL : smallModel
      if (!target) return
      const providers = (cfg.provider ?? {}) as Record<string, { options?: Record<string, unknown> }>
      if (!explicit) {
        const baseURL = String(providers[main.split("/")[0] ?? ""]?.options?.baseURL ?? "")
        if (!/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(baseURL)) return
        if (!providers[target.split("/")[0] ?? ""]) return
      }
      cfg.small_model = target
      if (metricsOn) metric({ type: "config", small_model: target, from: cfg.model })
    },

    "tool.execute.after": async (input, output) => {
      if (!enabled) return
      if (typeof output?.output !== "string") return
      if (!input.tool || protect.has(input.tool)) return
      const before = output.output
      const next = compress(before, fresh, priorityRe)
      if (next === before) return
      output.output = next
      savedBytes += byteLen(before) - byteLen(next)
      if (metricsOn) metric({ type: "fresh", tool: input.tool, from: byteLen(before), to: byteLen(next) })
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!enabled) return
      const messages = (output.messages ?? []) as MessageLike[]
      const users: number[] = []
      for (let i = 0; i < messages.length; i++) {
        if (messages[i]?.info?.role === "user") users.push(i)
      }
      if (users.length <= keepTurns) return
      const boundary = users[users.length - keepTurns] ?? 0

      let savings = 0
      for (let i = 0; i < boundary; i++) {
        for (const part of messages[i]?.parts ?? []) {
          const text = completedOutput(part, protect)
          if (text) savings += Math.max(0, byteLen(text) - old.maxBytes)
        }
      }
      if (savings < historyThreshold) return

      let before = 0
      let after = 0
      for (let i = 0; i < boundary; i++) {
        const parts = messages[i]?.parts
        if (!parts) continue
        let changed = false
        const next = parts.map((part) => {
          const text = completedOutput(part, protect)
          if (!text || fits(text, old)) return part
          const compressed = compress(text, old, priorityRe)
          if (compressed === text) return part
          changed = true
          before += byteLen(text)
          after += byteLen(compressed)
          return { ...part, state: { ...part.state, output: compressed } } as ToolPartLike
        })
        if (changed) messages[i] = { ...(messages[i] as MessageLike), parts: next }
      }

      savedBytes += before - after
      if (metricsOn && before > after) metric({ type: "history", from: before, to: after })
    },

    "chat.params": async (input) => {
      if (!enabled || !metricsOn) return
      started.set(input.sessionID, Date.now())
    },

    event: async ({ event }) => {
      if (!enabled || !metricsOn) return
      if (event.type !== "message.updated") return
      const info = (event as { properties?: { info?: Record<string, unknown> } }).properties?.info
      if (!info || info.role !== "assistant") return
      const time = info.time as { completed?: number } | undefined
      if (!time?.completed) return
      const sessionID = String(info.sessionID ?? "")
      const from = started.get(sessionID)
      started.delete(sessionID)
      metric({
        type: "turn",
        session: sessionID,
        ms: from ? time.completed - from : undefined,
        tokens: info.tokens,
        saved: savedBytes,
      })
      savedBytes = 0
    },

    dispose: async () => {
      started.clear()
      savedFiles.clear()
    },
  }
}

export const TurboPlugin = plugin

export default plugin
