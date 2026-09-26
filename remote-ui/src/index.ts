import { attentionClient } from "./attention-client"
import { tool, type Plugin } from "@opencode-ai/plugin"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { execFile } from "node:child_process"
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { networkInterfaces, tmpdir } from "node:os"
import { basename, dirname, extname, join, resolve } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import {
  computeCost,
  parsePriceTable,
  KNOWN_RATES,
  usageFromMessage,
  type Rates,
  type Usage,
} from "../../session-cost/src/accounting"

const here = dirname(fileURLToPath(import.meta.url))

export type RemoteUIOptions = {
  /** Port to listen on (default 4409) */
  port?: number
  /**
   * "tailscale" (default) auto-detects the Tailscale IPv4 and binds only to it,
   * so the UI is reachable from your tailnet but not the public internet.
   * "localhost" binds 127.0.0.1. Or pass an explicit IP/host string.
   */
  host?: "tailscale" | "localhost" | (string & {})
  /**
   * Shared secret. When set, every request must include it via
   * `?token=` query param or `x-opencode-token` header. Recommended if you
   * bind to 0.0.0.0 or a LAN IP.
   */
  token?: string
  /** Agent used when sending prompts (default "build") */
  agent?: string
  /** Start the web server as soon as opencode loads (default false — start via the `remote` tool or /remote command) */
  autoStart?: boolean
  /** Other project directories to expose in the UI (absolute paths); the plugin's own directory is always included */
  projects?: string[]
  /**
   * Auto-discover sibling project directories of the plugin's own directory
   * and expose them in the UI (default true). When false, `projects` is an
   * allowlist: requests for unlisted directories are rejected.
   */
  discoverProjects?: boolean
  /** Rate overrides, keyed by "providerID/modelID" or "modelID". USD per 1M tokens. */
  rates?: Record<string, Rates>
  /** Prefer opencode's recorded per-message cost over a recomputed estimate (default false) */
  useReportedCost?: boolean
}

type SerializedMessage = {
  id: string
  role: string
  segments: Array<
    | { id?: string; type: "text" | "thinking"; text: string; streaming?: boolean; durationMs?: number }
    | { id?: string; type: "tool"; name: string; title: string; status: string; detail?: string }
  >
  attachments: Array<{ name: string; mime: string; url: string }>
  time: number
  running: boolean
  durationMs: number | null
  cost: number | null
  recordedCost: number | null
  model: string
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
}

type PendingRequest = {
  id: string
  sessionID: string
  dir: string
  kind: "permission" | "question"
  protocol: "v1" | "v2" | "unknown"
  type: string
  title: string
  patterns: string[]
  options: string[]
  questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiple?: boolean; custom?: boolean }>
  metadata: unknown
  time: number
}

type SessionInfo = { dir: string; title?: string }

const ATTACH_DIR = join(tmpdir(), "opencode-remote-ui-attachments")
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

function safeName(name: string): string {
  return basename(name).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file"
}

async function cleanOldAttachments(): Promise<void> {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const f of await readdir(ATTACH_DIR)) {
      const p = join(ATTACH_DIR, f)
      try {
        if (statSync(p).mtimeMs < cutoff) await unlink(p)
      } catch {
        // File already gone.
      }
    }
  } catch {
    // Directory may not exist yet.
  }
}

function detectTailscaleIPv4(): Promise<string | undefined> {
  const fromOutput = (stdout: string): string | undefined =>
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^100\.\d+\.\d+\.\d+$/.test(line))
  const viaCli = (cmd: string): Promise<string | undefined> =>
    new Promise((resolve) => {
      try {
        execFile(cmd, ["ip", "-4"], { timeout: 4000 }, (err, stdout) => {
          if (err || !stdout) return resolve(undefined)
          resolve(fromOutput(String(stdout)))
        })
      } catch {
        resolve(undefined)
      }
    })
  return (async () => {
    // PATH may predate the Tailscale install — try common Windows locations
    // before giving up on the CLI.
    for (const cmd of ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"]) {
      const ip = await viaCli(cmd)
      if (ip) return ip
    }
    // Last resort: Tailscale always uses a 100.x CGNAT address; find it on
    // any local interface.
    try {
      for (const addrs of Object.values(networkInterfaces())) {
        for (const a of addrs ?? []) {
          if (a.family === "IPv4" && /^100\.\d+\.\d+\.\d+$/.test(a.address)) return a.address
        }
      }
    } catch {
      // Fall through to localhost.
    }
    return undefined
  })()
}

function toolDetail(state: Record<string, any>): string {
  const chunks: string[] = []
  if (state.input && Object.keys(state.input).length) {
    try {
      chunks.push("input: " + JSON.stringify(state.input, null, 2))
    } catch {
      // Non-serializable input — skip it.
    }
  }
  const output = state.output ?? state.result ?? state.content
  if (typeof output === "string" && output.trim()) {
    chunks.push(output.length > 4000 ? output.slice(0, 4000) + "\n… (truncated)" : output)
  }
  if (state.error) chunks.push("error: " + String(state.error))
  return chunks.join("\n\n").slice(0, 6000)
}

function serializeMessages(
  rows: Array<{ info: any; parts: Array<any> }>,
  resolveCost?: (info: any) => number | null,
): SerializedMessage[] {
  return rows
    .map(({ info, parts }) => {
      const segments: SerializedMessage["segments"] = []
      const attachments: SerializedMessage["attachments"] = []
      for (const part of parts) {
        if (part.type === "text" && !part.synthetic && !part.ignored && part.text) {
          segments.push({ id: part.id, type: "text", text: part.text })
        } else if (part.type === "reasoning" && part.text) {
          segments.push({
            type: "thinking",
            id: part.id,
            text: part.text,
            streaming: !part.time?.end,
            durationMs:
              part.time?.start && part.time?.end ? Math.max(0, part.time.end - part.time.start) : undefined,
          })
        } else if (part.type === "file") {
          const isRemote = /^https?:/i.test(part.url ?? "")
          const isData = /^data:/i.test(part.url ?? "")
          attachments.push({
            name: part.filename ?? "attachment",
            mime: part.mime ?? "application/octet-stream",
            // Remote/data URLs render directly in the browser; local files go
            // through the authenticated, project-scoped attachment endpoint.
            url: isRemote || isData
              ? part.url
              : `/api/attachment?sessionID=${encodeURIComponent(info.sessionID)}&messageID=${encodeURIComponent(info.id)}&partID=${encodeURIComponent(part.id)}`,
          })
        } else if (part.type === "tool") {
          const state = (part.state ?? {}) as Record<string, any>
          const title =
            state.title || state.input?.description || state.input?.command || state.input?.filePath || ""
          segments.push({
            type: "tool",
            id: part.id,
            name: String(part.tool),
            title: String(title).slice(0, 400),
            status: String(state.status ?? "unknown"),
            detail: toolDetail(state) || undefined,
          })
        }
      }
      const created = info.time?.created ?? 0
      const completed = info.time?.completed ?? 0
      const running = info.role === "assistant" && !completed
      const reportedCost = info.role === "assistant" && typeof info.cost === "number" ? info.cost : null
      return {
        id: info.id,
        role: info.role,
        segments,
        attachments,
        time: created,
        running,
        durationMs: created > 0 && completed > 0 ? Math.max(0, completed - created) : null,
        cost: info.role === "assistant" ? (resolveCost?.(info) ?? reportedCost) : null,
        recordedCost: reportedCost,
        model: info.role === "assistant" ? `${info.providerID ?? ""}/${info.modelID ?? ""}` : "",
        tokens: {
          input: info.tokens?.input ?? 0,
          output: info.tokens?.output ?? 0,
          reasoning: info.tokens?.reasoning ?? 0,
          cacheRead: info.tokens?.cache?.read ?? 0,
          cacheWrite: info.tokens?.cache?.write ?? 0,
        },
      }
    })
    .filter((m) => m.segments.length > 0 || m.attachments.length > 0)
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

const PAGE = "<!doctype html><html><body>Embedded UI missing - ui.html not found on disk.</body></html>"

export const RemoteUIPlugin: Plugin = async ({ client, directory }, options?: RemoteUIOptions) => {
  const runtime = attentionClient(client)
  const port = options?.port ?? 4409
  const defaultAgent = options?.agent ?? "build"
  const token = options?.token ?? ""
  const autoStart = options?.autoStart ?? false
  const discoverProjects = options?.discoverProjects ?? true
  const useReportedCost = options?.useReportedCost ?? false

  // kind+id keyed cache of blocking requests. Events keep it fresh; the
  // reconciliation pass below is the authority (events can be missed when a
  // request belongs to another directory than this plugin instance's hook).
  const pending = new Map<string, PendingRequest>()
  // sessionID -> owning project directory + last known title, so replies and
  // aborts reach the right project even after the UI navigated elsewhere.
  const sessionInfo = new Map<string, SessionInfo>()
  // SSE subscribers (the web UI) — pushed live opencode events.
  const sseClients = new Set<ServerResponse>()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let reconcileTimer: ReturnType<typeof setInterval> | null = null

  // ---- Shared pricing policy (same helpers as the session-cost plugin) ----
  let priceTable: Map<string, Rates> = new Map()
  let priceFetchedAt = 0
  const fetchPricing = async (): Promise<void> => {
    try {
      const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return
      priceTable = parsePriceTable(await res.json())
      priceFetchedAt = Date.now()
    } catch {
      // Offline — recorded costs remain the fallback.
    }
  }
  void fetchPricing()
  const resolveRates = (providerID: string, modelID: string): Rates | undefined => {
    const user = options?.rates
    if (user) {
      const exact = user[`${providerID}/${modelID}`]
      if (exact) return exact
      const modelOnly = user[modelID]
      if (modelOnly) return modelOnly
    }
    const known = KNOWN_RATES[`${providerID}/${modelID}`] ?? KNOWN_RATES[modelID]
    if (known) return known
    return priceTable.get(`${providerID}/${modelID}`) ?? priceTable.get(modelID)
  }
  const messageCost = (info: any): number | null => {
    const reported = typeof info.cost === "number" ? info.cost : null
    if (useReportedCost || !info.providerID) return reported
    const rates = resolveRates(info.providerID, info.modelID)
    if (!rates) return reported
    return computeCost(
      {
        input: info.tokens?.input ?? 0,
        output: info.tokens?.output ?? 0,
        cacheRead: info.tokens?.cache?.read ?? 0,
        cacheWrite: info.tokens?.cache?.write ?? 0,
      },
      rates,
    )
  }
  const sessionUsage = (rows: Array<{ info: any }>): Usage & { unknownCost: number; lastDurationMs: number } => {
    const total: Usage = {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      cost: 0, reportedCost: 0, messages: 0, durationMs: 0,
    }
    let lastCreated = 0
    let lastCompleted = 0
    let unknownCost = 0
    for (const { info } of rows) {
      if (info.role !== "assistant") continue
      const resolvedCost = messageCost(info)
      if (resolvedCost === null) unknownCost++
      const u = usageFromMessage(info, resolvedCost ?? 0)
      total.input += u.input
      total.output += u.output
      total.reasoning += u.reasoning
      total.cacheRead += u.cacheRead
      total.cacheWrite += u.cacheWrite
      total.cost += u.cost
      total.reportedCost += u.reportedCost
      total.messages += u.messages
      total.durationMs += u.durationMs
      if ((info.time?.created ?? 0) > lastCreated) {
        lastCreated = info.time.created
        lastCompleted = info.time?.completed ?? 0
      }
    }
    // Total durationMs is summed per message; also expose turn wall-clock via
    // the last assistant message lifetime as `lastDurationMs`.
    return {
      ...total,
      unknownCost,
      lastDurationMs: lastCreated > 0 && lastCompleted > 0 ? Math.max(0, lastCompleted - lastCreated) : 0,
    }
  }

  const broadcast = (payload: string): void => {
    for (const clientRes of sseClients) {
      try {
        clientRes.write(`data: ${payload}\n\n`)
      } catch {
        sseClients.delete(clientRes)
      }
    }
  }
  const forwardedEvents = new Set([
    "message.updated",
    "message.part.updated",
    "message.part.removed",
    "session.created",
    "session.updated",
    "session.deleted",
    "session.status",
    "session.idle",
    "permission.updated",
    "permission.replied",
    "permission.v2.replied",
    "question.asked",
    "question.replied",
  ])

  // ---- Pending-request normalization (v1 + v2 + questions) ----
  const pendingKey = (kind: string, id: string): string => `${kind}:${id}`
  const upsertPending = (
    kind: PendingRequest["kind"],
    protocol: PendingRequest["protocol"],
    props: Record<string, any>,
    dir: string,
  ): void => {
    const id = String(props.id ?? props.requestID ?? props.callID ?? props.permissionID ?? "")
    const sessionID = String(props.sessionID ?? "")
    if (!id || !sessionID) return
    const patterns = Array.isArray(props.patterns)
      ? props.patterns.map(String)
      : Array.isArray(props.resources)
        ? props.resources.map((r: unknown) => (typeof r === "string" ? r : JSON.stringify(r)))
        : []
    const permName = String(props.permission ?? props.action ?? props.tool ?? "permission")
    const metadata = props.metadata ?? {}
    const metaTitle =
      metadata?.title ?? metadata?.description ?? props.title ?? props.question ?? props.text ?? ""
    const options = Array.isArray(props.options)
      ? props.options.map((o: unknown) => (typeof o === "string" ? o : JSON.stringify(o)))
      : Array.isArray(props.choices)
        ? props.choices.map((o: unknown) => (typeof o === "string" ? o : JSON.stringify(o)))
        : []
    const key = pendingKey(kind, id)
    const existing = pending.get(key)
    pending.set(key, {
      id,
      sessionID,
      dir: existing?.dir ?? dir,
      kind,
      protocol,
      type: kind === "question" ? "question" : permName,
      title: String(metaTitle || patterns.join("  ") || permName),
      patterns,
      options,
      metadata,
      questions: Array.isArray(props.questions) ? props.questions : [],
      time: existing?.time ?? Date.now(),
    })
    if (!existing) notifyTUI(
      kind === "question"
        ? `question → ${sessionID.slice(-6)}: ${String(metaTitle).slice(0, 80)}`
        : `permission [${permName}] → ${sessionID.slice(-6)}: ${patterns.join(" ").slice(0, 80)}`,
    )
    if (!existing) broadcast(JSON.stringify({ type: `${kind}.updated`, sessionID }))
  }
  const removePending = (kind: string, props: Record<string, any>): void => {
    const id = String(props.requestID ?? props.id ?? props.callID ?? props.permissionID ?? "")
    if (id) {
      pending.delete(pendingKey(kind, id))
      pending.delete(pendingKey("permission", id)) // v1/v2 replied events cross kinds
      pending.delete(pendingKey("question", id))
    }
    broadcast(JSON.stringify({ type: `${kind}.replied` }))
  }

  /**
   * Pull authoritative pending requests from the runtime. Event hooks only
   * see this instance's directory, so a request raised in another exposed
   * project (or before the hook existed) is invisible without this pass.
   */
  const reconciliations = new Map<string, Promise<void>>()
  const attentionErrors = new Map<string, string>()
  const reconcilePending = (dir: string): Promise<void> => {
    const existing = reconciliations.get(dir)
    if (existing) return existing
    const initial = new Map([...pending.entries()].filter(([, p]) => sameDir(p.dir, dir)))
    const apply = (kind: PendingRequest["kind"], protocol: "v1" | "v2", items: Array<any>) => {
      const present = new Set(items.map(item => pendingKey(kind, item.id)))
      for (const [key, record] of pending) {
        if (initial.get(key) === record && record.kind === kind && record.protocol === protocol && sameDir(record.dir, dir) && !present.has(key)) pending.delete(key)
      }
      for (const item of items) upsertPending(kind, protocol, item, dir)
    }
    const task = (async () => {
      // An unsupported endpoint cannot invalidate another protocol's snapshot.
      const requestOptions = { throwOnError: true as const, signal: AbortSignal.timeout(8000) }
      const results = await Promise.allSettled([
        runtime.permission.list({ directory: dir }, requestOptions).then(r => apply("permission", "v1", r.data)),
        runtime.question.list({ directory: dir }, requestOptions).then(r => apply("question", "v1", r.data)),
        runtime.v2.permission.request.list({ location: { directory: dir } }, requestOptions).then(r => apply("permission", "v2", r.data.data)),
        runtime.v2.question.request.list({ location: { directory: dir } }, requestOptions).then(r => apply("question", "v2", r.data.data)),
      ])
      if (results.some(result => result.status === "rejected")) attentionErrors.set(dir, "Some permission/question lists are unavailable; requests may be missing. Retrying…")
      else attentionErrors.delete(dir)
    })().finally(() => reconciliations.delete(dir))
    reconciliations.set(dir, task)
    return task
  }

  void mkdir(ATTACH_DIR, { recursive: true }).then(cleanOldAttachments)

  // Windows paths can arrive with backslashes or forward slashes and mixed
  // case — canonicalize before deduping so projects never show twice.
  const canonical = (d: string): string => d.replace(/\\/g, "/").replace(/\/+$/, "")
  const sameDir = (a: string, b: string): boolean => canonical(a).toLowerCase() === canonical(b).toLowerCase()
  const projectDirs = (): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const d of [directory, ...(options?.projects ?? [])]) {
      const key = canonical(d).toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(d.replace(/[\\/]+$/, ""))
    }
    return out
  }
  const projectName = (dir: string): string => basename(dir) || dir
  const knownDir = (input: string): string | null => {
    if (!input || sameDir(input, directory)) return directory
    for (const p of options?.projects ?? []) if (sameDir(input, p)) return p.replace(/[\\/]+$/, "")
    return null
  }
  const realDir = (input: string): string => {
    try {
      return realpathSync.native(input)
    } catch {
      return resolve(input)
    }
  }
  const discoverableSibling = (input: string): string | null => {
    if (!discoverProjects || !input) return null
    const candidate = realDir(input)
    const parent = realDir(dirname(directory))
    if (!sameDir(dirname(candidate), parent)) return null
    const name = basename(candidate)
    if (!name || name.startsWith(".") || name.toLowerCase() === "node_modules") return null
    try {
      return statSync(candidate).isDirectory() ? candidate : null
    } catch {
      return null
    }
  }
  // Resolve a requested directory to its native form. The host project must
  // resolve to the plugin's exact `directory` — otherwise we'd scope events to
  // a different instance and the TUI would stop mirroring remote prompts.
  // When `discoverProjects` is false, `projects` is an allowlist and unknown
  // directories are rejected.
  const dirFor = (url: URL): string | null => {
    const input = url.searchParams.get("directory")?.replace(/[\\/]+$/, "") ?? ""
    const known = knownDir(input)
    if (known) return known
    if (input) return discoverableSibling(input)
    if (!input) return directory
    return null
  }
  // Own project: omit the param entirely (server default instance = the one
  // the TUI listens to). Other projects: pass explicitly.
  const qDir = (dir: string): { directory?: string } => (sameDir(dir, directory) ? {} : { directory: dir })
  const dirForSession = (sessionID: string): string => sessionInfo.get(sessionID)?.dir ?? directory

  /**
   * Surface remote activity in the TUI (toast) and serve console (log).
   * Note: this is a notification only — it is NOT a transcript-sync mechanism.
   * The TUI updates its transcript from backend `message.updated`/part events
   * on the shared backend, so API-originated prompts appear there when both
   * clients point at the same server instance and session.
   */
  const notifyTUI = (message: string): void => {
    void client.tui
      .showToast({ body: { title: "remote UI", message, variant: "info", duration: 5000 } })
      .catch(() => {})
    void client.app.log({ body: { service: "remote-ui", level: "info", message } }).catch(() => {})
  }

  let server: ReturnType<typeof createServer> | null = null
  let startPromise: Promise<string> | null = null

  const authorized = (url: URL, req: IncomingMessage): boolean => {
    if (!token) return true
    if (url.searchParams.get("token") === token) return true
    return req.headers["x-opencode-token"] === token
  }

  const serializePending = (sessionID?: string) =>
    [...pending.values()]
      .filter((p) => !sessionID || p.sessionID === sessionID)
      .sort((a, b) => a.time - b.time)
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        protocol: p.protocol,
        sessionID: p.sessionID,
        dir: p.dir,
        session: sessionInfo.get(p.sessionID)?.title || p.sessionID.slice(-6),
        type: p.type,
        title: p.title,
        patterns: p.patterns,
        options: p.options,
        questions: p.questions,
        time: p.time,
      }))

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    try {
      const dir = dirFor(url)
      if (dir === null) {
        return sendJSON(res, 403, { error: "directory not in the exposed project scope" })
      }
      if (!authorized(url, req)) {
        return sendJSON(res, 401, { error: "unauthorized" })
      }

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        })
        // Read per-request so UI edits apply with a browser refresh (no opencode restart).
        let html = PAGE
        try {
          html = readFileSync(join(here, "ui.html"), "utf8")
        } catch {
          // Fall back to the embedded copy if the file is missing.
        }
        return res.end(html.replace("__TOKEN__", JSON.stringify(token)))
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        })
        res.write("retry: 3000\n\n")
        sseClients.add(res)
        req.on("close", () => sseClients.delete(res))
        return
      }

      if (req.method === "GET" && url.pathname === "/api/projects") {
        // Configured projects + own directory (+ auto-discovered siblings of
        // the own directory when discovery is enabled). Only projects that
        // actually have sessions are exposed, most recently active first.
        const candidates = new Map<string, string>()
        const add = (d: string): void => {
          if (!d) return
          const key = canonical(d).toLowerCase()
          if (!key || candidates.has(key)) return
          candidates.set(key, d.replace(/[\\/]+$/, ""))
        }
        add(directory)
        for (const p of options?.projects ?? []) add(p)
        if (discoverProjects) {
          try {
            const parent = dirname(directory)
            const entries = await readdir(parent, { withFileTypes: true })
            let scanned = 0
            for (const e of entries) {
              if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue
              if (scanned >= 40) break
              scanned++
              add(join(parent, e.name))
            }
          } catch {
            // Parent not readable - configured projects still work.
          }
        }
        const out: Array<{ directory: string; name: string; sessions: number; updated: number }> = []
        for (const d of candidates.values()) {
          try {
            const r = await client.session.list({ query: qDir(d) })
            const sessions = (r.data ?? []).filter((s) => !s.parentID)
            for (const s of sessions) sessionInfo.set(s.id, { dir: d, title: s.title })
            if (sessions.length > 0) {
              out.push({
                directory: d,
                name: projectName(d),
                sessions: sessions.length,
                updated: Math.max(...sessions.map((s) => s.time?.updated ?? 0)),
              })
            }
          } catch {
            // Directory unreachable - skip it rather than showing a dead pill.
          }
        }
        out.sort((a, b) => b.updated - a.updated)
        if (out.length === 0) {
          out.push({ directory, name: projectName(directory), sessions: 0, updated: 0 })
        }
        return sendJSON(res, 200, out)
      }

      if (req.method === "GET" && url.pathname === "/api/meta") {
        const [agentsRes, providersRes] = await Promise.all([
          client.app.agents({ query: qDir(dir) }).catch(() => ({ data: [] })),
          client.config.providers({ query: qDir(dir) }).catch(() => ({ data: undefined })),
        ])
        const agents = (agentsRes.data ?? []).map((a) => ({
          name: a.name,
          mode: a.mode,
          description: a.description ?? "",
        }))
        const providerList = providersRes.data?.providers ?? []
        const models = providerList.map((p) => ({
          provider: p.name || p.id,
          models: Object.values(p.models).map((m) => ({
            value: `${p.id}/${m.id}`,
            label: m.name || m.id,
          })),
        }))
        const defaultProvider = providerList[0]?.id
        const configDefault =
          defaultProvider && providersRes.data?.default?.[defaultProvider]
            ? `${defaultProvider}/${providersRes.data.default[defaultProvider]}`
            : models[0]?.models[0]?.value
        // Prefer the model the most recent session actually used — config
        // defaults can point at a different model than what the user runs.
        let recentModel: string | undefined
        const recent = await client.session
          .list({ query: qDir(dir) })
          .catch(() => ({ data: [] as Array<any> }))
        for (const s of (recent.data ?? []).filter((s) => !s.parentID).slice(0, 3)) {
          const msgs = await client.session
            .messages({ path: { id: s.id }, query: qDir(dir) })
            .catch(() => ({ data: [] as Array<any> }))
          const rows = msgs.data ?? []
          for (let i = rows.length - 1; i >= 0; i--) {
            const info = rows[i].info
            if (info.role === "assistant" && info.modelID) {
              recentModel = `${info.providerID}/${info.modelID}`
              break
            }
          }
          if (recentModel) break
        }
        const defaultModel = recentModel ?? configDefault
        return sendJSON(res, 200, {
          agents,
          models,
          defaultModel,
          defaultAgent: agents.find((a) => a.mode !== "subagent")?.name ?? defaultAgent,
        })
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const result = await client.session.list({ query: qDir(dir) })
        for (const s of result.data ?? []) {
          sessionInfo.set(s.id, { dir, title: s.title })
        }
        // Include child sessions (flagged) so subagent conversations stay
        // reachable; the picker renders them as children.
        const sessions = (result.data ?? [])
          .sort((a, b) => b.time.updated - a.time.updated)
          .slice(0, 150)
          .map((s) => ({ id: s.id, title: s.title, updated: s.time.updated, parentID: s.parentID ?? null }))
        return sendJSON(res, 200, sessions)
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const sessionID = url.searchParams.get("sessionID")
        if (!sessionID) return sendJSON(res, 400, { error: "sessionID required" })
        sessionInfo.set(sessionID, { dir, title: sessionInfo.get(sessionID)?.title })
        await reconcilePending(dir)
        const [messagesRes, statusRead] = await Promise.all([
          client.session.messages({ path: { id: sessionID }, query: qDir(dir) }),
          client.session.status({ query: qDir(dir) }).catch(() => undefined),
        ])
        const rows = (messagesRes.data ?? []) as Array<{ info: any; parts: Array<any> }>
        // A successful status read with no entry for this session means the
        // runtime is not running anything for it → idle. Only a failed read
        // is "unknown" (the UI shows a reconnecting state for that).
        const rawStatus: string =
          statusRead === undefined ? "unknown" : (statusRead.data?.[sessionID]?.type ?? "idle")
        for (const row of rows) {
          if (row.info?.id) {
            sessionInfo.set(row.info.sessionID ?? sessionID, {
              dir,
              title: row.info.role === "user" ? undefined : sessionInfo.get(row.info.id)?.title,
            })
          }
        }
        const usage = sessionUsage(rows)
        return sendJSON(res, 200, {
          status: rawStatus,
          permissions: serializePending(sessionID).filter((p) => p.kind === "permission"),
          questions: serializePending(sessionID).filter((p) => p.kind === "question"),
          attention: serializePending(),
          attentionError: attentionErrors.get(dir) ?? null,
          messages: serializeMessages(rows, messageCost),
          usage,
        })
      }

      if (req.method === "GET" && url.pathname === "/api/attention") {
        await reconcilePending(dir)
        return sendJSON(res, 200, serializePending())
      }

      if (req.method === "GET" && url.pathname === "/api/attachment") {
        const sessionID = url.searchParams.get("sessionID") ?? ""
        const messageID = url.searchParams.get("messageID") ?? ""
        const partID = url.searchParams.get("partID") ?? ""
        if (!sessionID || !messageID || !partID) return sendJSON(res, 400, { error: "missing params" })
        const result = await client.session.messages({ path: { id: sessionID }, query: qDir(dir) })
        for (const row of result.data ?? []) {
          if (row.info.id !== messageID) continue
          for (const part of row.parts) {
            if (part.type !== "file" || part.id !== partID) continue
            if (!part.url) return sendJSON(res, 404, { error: "attachment not locally available" })
            if (/^data:/i.test(part.url)) {
              // data: URLs are handled client-side; never proxy them here.
              return sendJSON(res, 404, { error: "attachment not locally available" })
            }
            if (!/^file:\/\//i.test(part.url)) {
              return sendJSON(res, 404, { error: `unsupported attachment scheme: ${part.url.split(":")[0]}` })
            }
            const filePath = fileURLToPath(part.url)
            if (!existsSync(filePath)) return sendJSON(res, 404, { error: "file gone" })
            const mime = part.mime || "application/octet-stream"
            // Active content must download, never execute inline on this origin.
            const unsafe = /^(text\/html|image\/svg\+xml|application\/xhtml\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript)/i.test(mime)
            const ext = extname(filePath).toLowerCase()
            const headers: Record<string, string> = {
              "content-type": mime,
              "cache-control": "private, max-age=3600",
              "x-content-type-options": "nosniff",
            }
            if (unsafe || url.searchParams.get("dl") === "1" || ext === ".html" || ext === ".svg") {
              const dlName = safeName(part.filename ?? "attachment").replace(/"/g, "")
              headers["content-disposition"] = `attachment; filename="${dlName}"`
              headers["content-type"] = "application/octet-stream"
            }
            res.writeHead(200, headers)
            return createReadStream(filePath).pipe(res)
          }
        }
        return sendJSON(res, 404, { error: "attachment not found" })
      }

      if (req.method === "POST" && url.pathname === "/api/send") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          sessionID?: string
          text?: string
          agent?: string
          model?: string
          attachments?: Array<{ name?: string; mime?: string; data?: string }>
        }
        const text = (body.text ?? "").trim()
        const attachments = (body.attachments ?? []).filter((a) => a.data)
        if (!text && attachments.length === 0) return sendJSON(res, 400, { error: "nothing to send" })
        for (const a of attachments) {
          const rawBytes = Math.floor((a.data!.length * 3) / 4)
          if (rawBytes > MAX_ATTACHMENT_BYTES) {
            return sendJSON(res, 413, {
              error: `attachment too large (max ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB): ${safeName(a.name ?? "file")}`,
            })
          }
        }

        let sessionID = body.sessionID
        if (sessionID && sessionID !== "null") {
          const status = await client.session
            .status({ query: qDir(dir) })
            .catch(() => ({ data: undefined }))
          if (status.data?.[sessionID]?.type === "busy") {
            return sendJSON(res, 409, { error: "session is busy — wait or press Stop" })
          }
        }
        if (!sessionID || sessionID === "null") {
          const created = await client.session.create({
            body: { title: (text || safeName(attachments[0]?.name ?? "session")).slice(0, 80) },
            query: qDir(dir),
          })
          if (!created.data?.id) return sendJSON(res, 502, { error: "session creation failed" })
          sessionID = created.data.id
        }

        sessionInfo.set(sessionID, { dir, title: sessionInfo.get(sessionID)?.title })
        // Slash command → run as an opencode command; "!cmd" → run in shell.
        if (text.startsWith("/") && attachments.length === 0) {
          const space = text.indexOf(" ")
          const command = space > 0 ? text.slice(1, space) : text.slice(1)
          const args = space > 0 ? text.slice(space + 1) : ""
          try {
            await client.session.command({
              path: { id: sessionID },
              query: qDir(dir),
              body: { command, arguments: args, agent: body.agent || defaultAgent },
            })
          } catch (err) {
            return sendJSON(res, 502, { error: `command failed: ${err instanceof Error ? err.message : String(err)}` })
          }
          notifyTUI(`command → ${sessionID.slice(-6)}: ${command}`)
          return sendJSON(res, 202, { sessionID, mode: "command" })
        }
        if (text.startsWith("!") && attachments.length === 0) {
          try {
            await client.session.shell({
              path: { id: sessionID },
              query: qDir(dir),
              body: { command: text.slice(1).trim(), agent: body.agent || defaultAgent },
            })
          } catch (err) {
            return sendJSON(res, 502, { error: `shell failed: ${err instanceof Error ? err.message : String(err)}` })
          }
          notifyTUI(`shell → ${sessionID.slice(-6)}: ${text.slice(1, 61)}`)
          return sendJSON(res, 202, { sessionID, mode: "shell" })
        }

        const model = body.model?.includes("/")
          ? {
              providerID: body.model.split("/")[0],
              modelID: body.model.split("/").slice(1).join("/"),
            }
          : undefined

        const parts: Array<Record<string, unknown>> = []
        if (text) parts.push({ type: "text", text })
        for (const a of attachments) {
          const name = safeName(a.name ?? "file")
          // Collision-resistant: timestamp + random suffix + sanitized name.
          const filePath = join(ATTACH_DIR, `${Date.now()}-${randomBytes(4).toString("hex")}-${name}`)
          try {
            await writeFile(filePath, Buffer.from(a.data!, "base64"), { flag: "wx" })
          } catch (err) {
            return sendJSON(res, 500, { error: `attachment write failed: ${err instanceof Error ? err.message : String(err)}` })
          }
          parts.push({
            type: "file",
            mime: a.mime || "application/octet-stream",
            filename: name,
            url: pathToFileURL(filePath).href,
          })
        }

        // Await acceptance so failures surface as HTTP errors instead of
        // silently dropped prompts. promptAsync resolves once the backend
        // accepted the prompt — the run itself continues in the background.
        try {
          await client.session.promptAsync({
            path: { id: sessionID },
            query: qDir(dir),
            body: { parts: parts as any, agent: body.agent || defaultAgent, model },
          })
        } catch (err) {
          return sendJSON(res, 502, {
            error: `prompt rejected: ${err instanceof Error ? err.message : String(err)}`,
            sessionID,
          })
        }
        notifyTUI(
          `prompt → ${sessionID.slice(-6)}: ${(text || attachments.map((a) => a.name).join(", ")).slice(0, 80)}`,
        )
        return sendJSON(res, 202, { sessionID, mode: "prompt" })
      }

      if (req.method === "POST" && url.pathname === "/api/abort") {
        const body = JSON.parse((await readBody(req)) || "{}") as { sessionID?: string }
        if (!body.sessionID) return sendJSON(res, 400, { error: "sessionID required" })
        const sessionID = body.sessionID
        try {
          await client.session.abort({ path: { id: sessionID }, query: qDir(dir) })
        } catch (err) {
          // Abort on an already-idle session is fine; a real failure must
          // surface instead of masquerading as success.
          const status = await client.session.status({ query: qDir(dir) }).catch(() => ({ data: undefined }))
          if (status.data?.[sessionID]?.type === "busy") {
            return sendJSON(res, 502, { error: `abort failed: ${err instanceof Error ? err.message : String(err)}` })
          }
        }
        notifyTUI(`abort → ${sessionID.slice(-6)}`)
        return sendJSON(res, 200, { ok: true })
      }

      if (req.method === "POST" && url.pathname === "/api/permissions") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          sessionID?: string
          permissionID?: string
          response?: string
        }
        if (!body.sessionID || !body.permissionID) {
          return sendJSON(res, 400, { error: "sessionID and permissionID required" })
        }
        if (body.response !== "once" && body.response !== "always" && body.response !== "reject") {
          return sendJSON(res, 400, { error: "response must be once, always, or reject" })
        }
        const response = body.response
        const sessionID = body.sessionID
        const permissionID = body.permissionID
        const rec = pending.get(pendingKey("permission", permissionID))
        if (!rec || rec.sessionID !== sessionID) return sendJSON(res, 409, { error: "Request no longer pending; refresh and retry" })
        try {
          if (rec.protocol === "v2") {
            await runtime.v2.session.permission.reply({ sessionID, requestID: permissionID, reply: response }, { throwOnError: true })
          } else {
            await runtime.permission.reply({ requestID: permissionID, directory: rec.dir, reply: response }, { throwOnError: true })
          }
        } catch {
          return sendJSON(res, 502, { error: "Permission reply failed — request is still pending" })
        }
        pending.delete(pendingKey("permission", permissionID))
        notifyTUI(`permission ${response} → ${sessionID.slice(-6)}`)
        broadcast(JSON.stringify({ type: "permission.replied", sessionID }))
        return sendJSON(res, 200, { ok: true })
      }

      if (req.method === "POST" && url.pathname === "/api/questions") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          sessionID?: string
          questionID?: string
          answer?: string
          answers?: string[][]
          reject?: boolean
        }
        if (!body.sessionID || !body.questionID) {
          return sendJSON(res, 400, { error: "sessionID and questionID required" })
        }
        const rec = pending.get(pendingKey("question", body.questionID))
        if (!rec || rec.sessionID !== body.sessionID) return sendJSON(res, 409, { error: "Request no longer pending; refresh and retry" })
        const answers = body.answers ?? (body.answer ? [[body.answer]] : [])
        if (!body.reject && (!Array.isArray(answers) || !answers.length || answers.some(a => !Array.isArray(a) || !a.length || a.some(v => typeof v !== "string" || !v.trim())) || (rec.questions.length && answers.length !== rec.questions.length))) {
          return sendJSON(res, 400, { error: "One nonempty answer list is required for each question" })
        }
        try {
          const ids = { sessionID: body.sessionID, requestID: body.questionID }
          if (rec.protocol === "v2") {
            if (body.reject) await runtime.v2.session.question.reject(ids, { throwOnError: true })
            else await runtime.v2.session.question.reply({ ...ids, questionV2Reply: { answers } }, { throwOnError: true })
          } else {
            if (body.reject) await runtime.question.reject({ requestID: body.questionID, directory: rec.dir }, { throwOnError: true })
            else await runtime.question.reply({ requestID: body.questionID, directory: rec.dir, answers }, { throwOnError: true })
          }
        } catch {
          return sendJSON(res, 502, { error: "Question reply failed — request is still pending" })
        }
        pending.delete(pendingKey("question", body.questionID))
        notifyTUI(`question answered → ${body.sessionID.slice(-6)}`)
        broadcast(JSON.stringify({ type: "question.replied", sessionID: body.sessionID }))
        return sendJSON(res, 200, { ok: true })
      }

      return sendJSON(res, 404, { error: "not found" })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) sendJSON(res, 500, { error: message })
    }
  }

  const closeServer = (): void => {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
    if (reconcileTimer) {
      clearInterval(reconcileTimer)
      reconcileTimer = null
    }
    for (const clientRes of sseClients) clientRes.destroy()
    sseClients.clear()
    if (server) {
      try {
        server.close()
      } catch {
        // Already closed.
      }
    }
    server = null
    startPromise = null
  }

  const startServer = (): Promise<string> => {
    if (startPromise) return startPromise
    startPromise = (async () => {
      let host = options?.host ?? "tailscale"
      if (host === "tailscale") {
        host = (await detectTailscaleIPv4()) ?? "127.0.0.1"
      } else if (host === "localhost") {
        host = "127.0.0.1"
      }

      // One opencode process can initialize this plugin once per project
      // directory (and the attach/TUI process loads it too). Only the first
      // instance should bind; everyone else reuses the existing UI instead
      // of proliferating ports 4409, 4410, 4411, …
      for (let p = port; p < port + 12; p++) {
        try {
          const probeURL = new URL(`http://${host}:${p}/`)
          if (token) probeURL.searchParams.set("token", token)
          const probe = await fetch(probeURL, { signal: AbortSignal.timeout(800) })
          const text = await probe.text()
          if (probe.ok && text.includes('<meta name="opencode-remote-ui" content="1">')) {
            return `http://${host}:${p}`
          }
        } catch {
          // Nothing listening on that port — keep scanning.
        }
      }

      // Try the configured port first, then walk up — so multiple opencode
      // instances (or a lingering socket) don't leave the tool unstartable.
      // Only address-in-use justifies a retry; anything else fails loudly
      // with the real bind error.
      let bound: ReturnType<typeof createServer> | null | undefined = null
      let activePort = port
      let lastError: unknown
      for (let attempt = 0; attempt < 12 && !bound; attempt++) {
        activePort = port + attempt
        const attemptPort = activePort
        bound = await new Promise((resolve) => {
          const s = createServer(handleRequest)
          s.once("error", (err: NodeJS.ErrnoException) => {
            const retryable = err.code === "EADDRINUSE"
            if (!retryable) lastError = err
            s.close()
            resolve(retryable ? null : undefined)
          })
          s.listen(attemptPort, host, () => resolve(s))
        })
        if (bound === undefined) break
        if (!bound) lastError = lastError ?? new Error(`port ${activePort} in use`)
      }
      if (!bound) {
        startPromise = null
        throw lastError ?? new Error(`could not bind any port from ${port} on ${host}`)
      }
      server = bound
      const address = server.address()
      if (address && typeof address !== "string") activePort = address.port

      heartbeat = setInterval(() => broadcast(": ping"), 25_000)
      // Safety net: pick up requests whose events were missed (other
      // directories, pre-hook requests). Events remain the fast path.
      reconcileTimer = setInterval(() => {
        for (const d of projectDirs()) void reconcilePending(d)
      }, 20_000)

      const url = `http://${host}:${activePort}`
      try {
        await client.app.log({
          body: { service: "remote-ui", level: "info", message: `remote UI listening on ${url}` },
        })
      } catch {
        // Logging is best-effort.
      }
      void client.tui
        .showToast({
          body: {
            title: "opencode remote UI started",
            message: url + (token ? " (token required)" : ""),
            variant: "success",
            duration: 8000,
          },
        })
        .catch(() => {})
      return url
    })()
    // A rejected start must not stay cached — the next `remote` call retries.
    const attempted = startPromise
    attempted.catch(() => {
      if (startPromise === attempted) startPromise = null
    })
    return startPromise
  }

  if (autoStart) startServer().catch(() => {})

  return {
    tool: {
      remote: tool({
        description:
          "Start the opencode remote UI web server (bound to the Tailscale interface by default) " +
          "so the user can open a mobile-friendly chat UI from another device on their tailnet. " +
          "Safe to call multiple times; returns the URL to open.",
        args: {},
        async execute() {
          const url = await startServer()
          return (
            `Remote UI is running at ${url}` +
            (token ? " (requires the shared token)" : "") +
            `. Open this URL in a browser on any device connected to the same Tailscale network to send messages to opencode.`
          )
        },
      }),
    },
    event: async ({ event }) => {
      // Runtime event names can differ from the pinned SDK's types (e.g.
      // permission.asked vs permission.updated, legacy vs permission.v2.*) —
      // compare as plain strings and normalize both protocols.
      const evtType = (event as { type: string }).type
      const props = (event.properties ?? {}) as Record<string, any>

      if (evtType === "permission.asked" || evtType === "permission.updated") {
        // v1 shape: { id, sessionID, permission, patterns, metadata, always, tool }
        upsertPending("permission", "v1", props, directory)
        return
      }
      if (evtType === "permission.v2.asked") {
        // v2 shape: { id, sessionID, action, resources, metadata, ... }
        upsertPending("permission", "v2", props, directory)
        return
      }
      if (evtType === "permission.replied" || evtType === "permission.v2.replied") {
        removePending("permission", props)
        return
      }
      if (evtType === "question.asked" || evtType === "question.v2.asked") {
        upsertPending("question", evtType === "question.v2.asked" ? "v2" : "v1", props, directory)
        return
      }
      if (["question.replied", "question.rejected", "question.v2.replied", "question.v2.rejected"].includes(evtType)) {
        removePending("question", props)
        return
      }

      if (evtType === "session.created" || evtType === "session.updated") {
        const info = props.info
        if (info?.id) {
          const prev = sessionInfo.get(info.id)
          sessionInfo.set(info.id, { dir: prev?.dir ?? directory, title: info.title ?? prev?.title })
        }
      }
      if (evtType === "session.deleted") {
        const info = props.info
        if (info?.id) sessionInfo.delete(info.id)
      }

      if (forwardedEvents.has(evtType)) {
        const sid = props.sessionID ?? props.info?.id
        broadcast(JSON.stringify({ type: evtType, sessionID: sid }))
      }
      switch (event.type) {
        case "server.instance.disposed": {
          closeServer()
          break
        }
      }
    },
  }
}

export default RemoteUIPlugin
