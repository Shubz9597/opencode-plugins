import { tool, type Plugin } from "@opencode-ai/plugin"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { execFile } from "node:child_process"
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs"
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

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
  /** Start the web server as soon as opencode loads (default false â€” start via the `remote` tool or /remote command) */
  autoStart?: boolean
}

type SerializedMessage = {
  id: string
  role: string
  segments: Array<{ type: "text" | "tool" | "thinking"; text: string; streaming?: boolean }>
  attachments: Array<{ name: string; mime: string; url: string }>
  time: number
  cost: number
  model: string
}

type PendingPermission = { id: string; sessionID: string; type: string; title: string; time: number }

const ATTACH_DIR = join(tmpdir(), "opencode-remote-ui-attachments")

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
  return new Promise((resolve) => {
    const done = (value?: string) => resolve(value)
    try {
      execFile("tailscale", ["ip", "-4"], { timeout: 4000 }, (err, stdout) => {
        if (err || !stdout) return done()
        const ip = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => /^100\.\d+\.\d+\.\d+$/.test(line))
        done(ip)
      })
    } catch {
      done()
    }
  })
}

function serializeMessages(
  rows: Array<{ info: any; parts: Array<any> }>,
): SerializedMessage[] {
  return rows
    .map(({ info, parts }) => {
      const segments: SerializedMessage["segments"] = []
      const attachments: SerializedMessage["attachments"] = []
      for (const part of parts) {
        if (part.type === "text" && !part.synthetic && !part.ignored && part.text) {
          segments.push({ type: "text", text: part.text })
        } else if (part.type === "reasoning" && part.text) {
          segments.push({ type: "thinking", text: part.text, streaming: !part.time?.end })
        } else if (part.type === "file") {
          const isRemote = /^https?:/i.test(part.url ?? "")
          attachments.push({
            name: part.filename ?? "attachment",
            mime: part.mime ?? "application/octet-stream",
            url: isRemote
              ? part.url
              : `/api/attachment?sessionID=${encodeURIComponent(info.sessionID)}&messageID=${encodeURIComponent(info.id)}&partID=${encodeURIComponent(part.id)}`,
          })
        } else if (part.type === "tool") {
          const state = part.state ?? {}
          const title =
            state.title || state.input?.description || state.input?.command || state.input?.filePath || ""
          segments.push({
            type: "tool",
            text: `${part.tool}${title ? ` â€” ${String(title).slice(0, 220)}` : ""}`,
          })
        }
      }
      return {
        id: info.id,
        role: info.role,
        segments,
        attachments,
        time: info.time?.created ?? 0,
        cost: info.role === "assistant" ? (info.cost ?? 0) : 0,
        model: info.role === "assistant" ? `${info.providerID}/${info.modelID}` : "",
      }
    })
    .filter((m) => m.segments.length > 0 || m.attachments.length > 0)
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
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
  const port = options?.port ?? 4409
  const defaultAgent = options?.agent ?? "build"
  const token = options?.token ?? ""
  const autoStart = options?.autoStart ?? false

  const pendingPermissions = new Map<string, PendingPermission>()
  void mkdir(ATTACH_DIR, { recursive: true }).then(cleanOldAttachments)

  let server: ReturnType<typeof createServer> | null = null
  let startPromise: Promise<string> | null = null

  const authorized = (url: URL, req: IncomingMessage): boolean => {
    if (!token) return true
    if (url.searchParams.get("token") === token) return true
    return req.headers["x-opencode-token"] === token
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    try {
      if (!authorized(url, req)) {
        return sendJSON(res, 401, { error: "unauthorized" })
      }

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        // Read per-request so UI edits apply with a browser refresh (no opencode restart).
        let html = PAGE
        try {
          html = readFileSync(join(here, "ui.html"), "utf8")
        } catch {
          // Fall back to the embedded copy if the file is missing.
        }
        return res.end(html.replace("__TOKEN__", JSON.stringify(token)))
      }

      if (req.method === "GET" && url.pathname === "/api/meta") {
        const [agentsRes, providersRes] = await Promise.all([
          client.app.agents({ query: { directory } }).catch(() => ({ data: [] })),
          client.config.providers({ query: { directory } }).catch(() => ({ data: undefined })),
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
        const defaultModel =
          defaultProvider && providersRes.data?.default?.[defaultProvider]
            ? `${defaultProvider}/${providersRes.data.default[defaultProvider]}`
            : models[0]?.models[0]?.value
        return sendJSON(res, 200, {
          agents,
          models,
          defaultModel,
          defaultAgent: agents.find((a) => a.mode !== "subagent")?.name ?? defaultAgent,
        })
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const result = await client.session.list({ query: { directory } })
        const sessions = (result.data ?? [])
          .filter((s) => !s.parentID)
          .sort((a, b) => b.time.updated - a.time.updated)
          .slice(0, 100)
          .map((s) => ({ id: s.id, title: s.title, updated: s.time.updated }))
        return sendJSON(res, 200, sessions)
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const sessionID = url.searchParams.get("sessionID")
        if (!sessionID) return sendJSON(res, 400, { error: "sessionID required" })
        const [messagesRes, statusRes] = await Promise.all([
          client.session.messages({ path: { id: sessionID }, query: { directory } }),
          client.session.status({ query: { directory } }).catch(() => ({ data: undefined })),
        ])
        const permissions = [...pendingPermissions.values()]
          .filter((p) => p.sessionID === sessionID)
          .sort((a, b) => a.time - b.time)
        return sendJSON(res, 200, {
          status: statusRes.data?.[sessionID]?.type ?? "idle",
          permissions,
          messages: serializeMessages((messagesRes.data ?? []) as Array<{ info: any; parts: Array<any> }>),
        })
      }

      if (req.method === "GET" && url.pathname === "/api/attachment") {
        const sessionID = url.searchParams.get("sessionID") ?? ""
        const messageID = url.searchParams.get("messageID") ?? ""
        const partID = url.searchParams.get("partID") ?? ""
        if (!sessionID || !messageID || !partID) return sendJSON(res, 400, { error: "missing params" })
        const result = await client.session.messages({ path: { id: sessionID }, query: { directory } })
        for (const row of result.data ?? []) {
          if (row.info.id !== messageID) continue
          for (const part of row.parts) {
            if (part.type !== "file" || part.id !== partID) continue
            if (!part.url || !part.url.startsWith("file://")) {
              return sendJSON(res, 404, { error: "attachment not locally available" })
            }
            const filePath = fileURLToPath(part.url)
            if (!existsSync(filePath)) return sendJSON(res, 404, { error: "file gone" })
            res.writeHead(200, {
              "content-type": part.mime || "application/octet-stream",
              "cache-control": "private, max-age=3600",
            })
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

        let sessionID = body.sessionID
        if (sessionID) {
          const status = await client.session
            .status({ query: { directory } })
            .catch(() => ({ data: undefined }))
          if (status.data?.[sessionID]?.type === "busy") {
            return sendJSON(res, 409, { error: "session is busy â€” wait or press Stop" })
          }
        }
        if (!sessionID || sessionID === "null") {
          const created = await client.session.create({
            body: { title: (text || safeName(attachments[0]?.name ?? "session")).slice(0, 80) },
            query: { directory },
          })
          sessionID = created.data!.id
        }

        // Slash command â†’ run as an opencode command; "!cmd" â†’ run in shell.
        if (text.startsWith("/") && attachments.length === 0) {
          const space = text.indexOf(" ")
          const command = space > 0 ? text.slice(1, space) : text.slice(1)
          const args = space > 0 ? text.slice(space + 1) : ""
          void client.session
            .command({
              path: { id: sessionID },
              query: { directory },
              body: { command, arguments: args, agent: body.agent || defaultAgent },
            })
            .catch(() => {})
          return sendJSON(res, 202, { sessionID, mode: "command" })
        }
        if (text.startsWith("!") && attachments.length === 0) {
          void client.session
            .shell({
              path: { id: sessionID },
              query: { directory },
              body: { command: text.slice(1).trim(), agent: body.agent || defaultAgent },
            })
            .catch(() => {})
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
          const filePath = join(ATTACH_DIR, `${Date.now()}-${name}`)
          await writeFile(filePath, Buffer.from(a.data!, "base64"))
          parts.push({
            type: "file",
            mime: a.mime || "application/octet-stream",
            filename: name,
            url: pathToFileURL(filePath).href,
          })
        }

        void client.session
          .promptAsync({
            path: { id: sessionID },
            query: { directory },
            body: { parts: parts as any, agent: body.agent || defaultAgent, model },
          })
          .catch(() => {})
        return sendJSON(res, 202, { sessionID, mode: "prompt" })
      }

      if (req.method === "POST" && url.pathname === "/api/abort") {
        const body = JSON.parse((await readBody(req)) || "{}") as { sessionID?: string }
        if (!body.sessionID) return sendJSON(res, 400, { error: "sessionID required" })
        try {
          await client.session.abort({ path: { id: body.sessionID }, query: { directory } })
        } catch {
          // Session may already be idle â€” nothing to abort.
        }
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
        const response = body.response === "always" ? "always" : body.response === "reject" ? "reject" : "once"
        try {
          await client.postSessionIdPermissionsPermissionId({
            path: { id: body.sessionID, permissionID: body.permissionID },
            query: { directory },
            body: { response },
          })
        } catch {
          // Permission may have been answered from the TUI in the meantime.
        }
        return sendJSON(res, 200, { ok: true })
      }

      return sendJSON(res, 404, { error: "not found" })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) sendJSON(res, 500, { error: message })
    }
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

      server = createServer(handleRequest)
      await new Promise<void>((resolve) => server!.listen(port, host, resolve))

      const url = `http://${host}:${port}`
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
    return startPromise
  }

  if (autoStart) void startServer()

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
      switch (event.type) {
        case "permission.updated": {
          const p = event.properties
          pendingPermissions.set(p.id, {
            id: p.id,
            sessionID: p.sessionID,
            type: p.type,
            title: p.title,
            time: p.time?.created ?? Date.now(),
          })
          break
        }
        case "permission.replied": {
          pendingPermissions.delete(event.properties.permissionID)
          break
        }
        case "server.instance.disposed": {
          server?.close()
          break
        }
      }
    },
  }
}

export default RemoteUIPlugin
