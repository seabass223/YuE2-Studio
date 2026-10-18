/**
 * Reference Invoker with a UI, for the MCP Micro-UI Jobs profile (spec section 7).
 *
 * It connects to a server over Streamable HTTP and invokes its start tool. The server's View is
 * rendered in a sandboxed iframe through the MCP Apps AppBridge. The job is tracked independently
 * of the View (long-poll); the View's `completed` notification only lets delivery happen sooner.
 * The payload is fetched with resources/read, checked against size and sha256, and delivered
 * exactly once per jobId.
 *
 * Simplification: this uses a single sandboxed iframe. Production web hosts must use the MCP Apps
 * double-iframe sandbox proxy on a separate origin.
 */
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/client"
import { AppBridge, PostMessageTransport, getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge"
import { z } from "zod"

const PROFILE = "dev.micro-ui/jobs"
const VERSION = "0.1.0"
const APP_MIME = "text/html;profile=mcp-app"
const NOTIFY = {
  started: "micro-ui-jobs/notifications/started",
  status: "micro-ui-jobs/notifications/status",
  completed: "micro-ui-jobs/notifications/completed",
  delivered: "micro-ui-jobs/notifications/delivered",
}
const TERMINAL = new Set(["completed", "failed", "cancelled"])
const LONG_POLL_MS = 25_000
// What the View gets: no network, inline code only, data: media. Close to the MCP Apps default CSP.
const VIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'"

interface Handle { jobId: string; statusTool: string; resultTool: string; cancelTool: string; pollIntervalMs: number }
interface Status { jobId: string; state: string; phase: string; progress: number | null; message: string }
interface Artifact { uri: string; name: string; mimeType: string; size: number; sha256: string; role: string }
interface Mounted { bridge: AppBridge; frame: HTMLIFrameElement }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const argsBox = $<HTMLTextAreaElement>("args")
argsBox.value = JSON.stringify({ style: "lofi hip hop, dusty drums, warm rhodes", instrumental: true, max_seconds: 20 }, null, 2)

const client = new Client(
  { name: "micro-ui-jobs-reference-host", version: VERSION },
  {
    // `extensions` is the 2026 capability slot; older SDK typings don't know it yet.
    capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [APP_MIME] }, [PROFILE]: { version: VERSION } } } as never,
    versionNegotiation: { mode: "auto" }, // 2026-07-28 when the server speaks it; extensions ride on every request
  },
)
let tools: Tool[] = []
const handles = new Map<string, Handle>() // jobId -> handle
const views = new Map<string, Mounted>() // jobId -> View showing it
const tracked = new Set<string>()
const delivered = new Set<string>() // exactly-once delivery guard

function log(tag: string, text: string, bad = false) {
  const li = document.createElement("li")
  li.innerHTML = `<time>${new Date().toLocaleTimeString()}</time><span class="tag"></span><span></span>`
  li.children[1].textContent = tag
  li.children[2].textContent = text
  if (bad) li.children[2].className = "bad"
  $("log").prepend(li)
}

const profileMeta = (tool: Tool) => (tool._meta?.[PROFILE] ?? {}) as Record<string, string>
const visibility = (tool: Tool) => ((tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility ?? ["model", "app"])

async function connect() {
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.href)))
  tools = (await client.listTools()).tools
  const info = client.getServerVersion()
  // 2026-07-28 advertises under `extensions`, handshake-era servers under `experimental` (spec 2).
  const caps = client.getServerCapabilities() as { extensions?: Record<string, unknown>; experimental?: Record<string, unknown> } | undefined
  const advertised = Boolean(caps?.extensions?.[PROFILE] ?? caps?.experimental?.[PROFILE])
  $("server").textContent = `${info?.name ?? "server"} · ${advertised ? `${PROFILE} ✓` : "profile not advertised"}`
  $("server").classList.toggle("ok", advertised)
  log("connect", `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`)
  $<HTMLButtonElement>("invoke").disabled = false
  $<HTMLButtonElement>("invoke-empty").disabled = false
}

/** Renders the View for a tool call and wires the MCP Apps bridge plus this profile's notifications. */
async function mountView(uri: string): Promise<{ view: Mounted; ready: Promise<void> }> {
  const resource = await client.readResource({ uri })
  const content = resource.contents[0]
  if (!content || content.mimeType !== APP_MIME || !("text" in content)) throw new Error(`${uri} is not an MCP App`)
  const html = content.text.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">`)

  const frame = document.createElement("iframe")
  frame.setAttribute("sandbox", "allow-scripts") // opaque origin: no cookies, storage or parent DOM
  const container = $("views")
  if (!container.querySelector("iframe")) container.replaceChildren()
  container.prepend(frame)

  const dark = matchMedia("(prefers-color-scheme: dark)").matches
  const bridge = new AppBridge(
    null,
    { name: "Micro-UI Jobs reference host", version: VERSION },
    { openLinks: {}, serverTools: {}, serverResources: {}, updateModelContext: { text: {} }, experimental: { [PROFILE]: { version: VERSION } } },
    { hostContext: { theme: dark ? "dark" : "light", displayMode: "inline", availableDisplayModes: ["inline"], platform: "web" } },
  )
  const view = { bridge, frame }

  // MCP Apps proxying, limited to tools the server made visible to apps.
  bridge.oncalltool = async (params) => {
    const tool = tools.find((t) => t.name === params.name)
    if (!tool || !visibility(tool).includes("app")) throw new Error(`Tool ${params.name} is not available to apps`)
    return client.callTool(params)
  }
  bridge.onreadresource = async (params) => client.readResource(params)
  bridge.onopenlink = async ({ url }) => {
    if (/^https?:\/\//.test(url)) window.open(url, "_blank", "noopener")
    return {}
  }
  bridge.onupdatemodelcontext = async (params) => {
    const text = params.content?.find((c) => c.type === "text")
    log("model ctx", text && "text" in text ? text.text : JSON.stringify(params.structuredContent ?? {}))
    return {}
  }
  bridge.onmessage = async () => ({ isError: true }) // this host has no conversation to post into
  bridge.onsizechange = ({ height }) => {
    if (height) frame.style.height = `${Math.min(height, 900)}px`
  }

  // Profile notifications (spec section 6). The View's word is a hint, never the source of truth.
  const loose = z.looseObject({ jobId: z.string() })
  bridge.setNotificationHandler(NOTIFY.started, { params: loose }, (handle) => {
    log("view▸started", handle.jobId)
    adopt(handle as unknown as Handle, view)
  })
  bridge.setNotificationHandler(NOTIFY.status, { params: loose }, (s) => {
    const status = s as unknown as Status
    $("view-state").textContent = `${status.state} · ${status.phase}${status.progress == null ? "" : ` · ${Math.round(status.progress * 100)}%`}`
  })
  bridge.setNotificationHandler(NOTIFY.completed, { params: loose }, (c) => {
    log("view▸completed", `${c.jobId} ${String(c.state)}`)
    const handle = handles.get(c.jobId)
    if (handle && c.state === "completed") deliver(handle)
  })

  const ready = new Promise<void>((resolve) => (bridge.oninitialized = () => resolve()))
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!))
  frame.srcdoc = html // load after the bridge listens, so the View's ui/initialize is not missed
  return { view, ready }
}

function adopt(handle: Handle, view: Mounted | null) {
  handles.set(handle.jobId, handle)
  if (view) views.set(handle.jobId, view)
  track(handle)
}

async function invoke(args: Record<string, unknown>) {
  const start = tools.find((t) => profileMeta(t).role === "start")
  if (!start) return log("error", "server exposes no start tool", true)
  const uri = getToolUiResourceUri(start)
  const mounted = uri ? await mountView(uri) : null
  log("tools/call", `${start.name} ${JSON.stringify(args)}`)
  const result = await client.callTool({ name: start.name, arguments: args })
  if (mounted) {
    await mounted.ready
    await mounted.view.bridge.sendToolInput({ arguments: args })
    await mounted.view.bridge.sendToolResult(result as CallToolResult)
  }
  const structured = result.structuredContent as (Handle & { state?: string; missing?: string[]; error?: { code: string; message: string } }) | undefined
  if (result.isError) return log("error", `${structured?.error?.code}: ${structured?.error?.message}`, true)
  if (structured?.state === "input_required") return log("start", `input required (${structured.missing?.join(", ")}); the View collects it`)
  if (structured?.jobId) {
    log("start", `job ${structured.jobId}`)
    adopt(structured, mounted?.view ?? null)
  }
}

/** The Invoker's own tracking (spec 7.4): long-poll until terminal, regardless of the View. */
async function track(handle: Handle) {
  if (tracked.has(handle.jobId)) return
  tracked.add(handle.jobId)
  let last = ""
  for (;;) {
    let status: Status
    try {
      const r = await client.callTool(
        { name: handle.statusTool, arguments: { jobId: handle.jobId, waitMs: LONG_POLL_MS } },
        { timeout: LONG_POLL_MS + 15_000 },
      )
      if (r.isError) return log("status", JSON.stringify(r.structuredContent), true)
      status = r.structuredContent as unknown as Status
    } catch (e) {
      log("status", `${(e as Error).message}; retrying`, true)
      await new Promise((r) => setTimeout(r, handle.pollIntervalMs * 3))
      continue
    }
    const line = `${status.state}/${status.phase}`
    if (line !== last) log("status", `${line} ${status.message}`)
    last = line
    if (!TERMINAL.has(status.state)) continue
    if (status.state === "completed") await deliver(handle)
    else log("ended", `${status.state}: ${status.message}`, true)
    return
  }
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Spec 7.5: result tool, resources/read, verify, hand to the app once, tell the View. */
async function deliver(handle: Handle) {
  if (delivered.has(handle.jobId)) return
  delivered.add(handle.jobId)
  const r = await client.callTool({ name: handle.resultTool, arguments: { jobId: handle.jobId } })
  if (r.isError) {
    delivered.delete(handle.jobId)
    return log("result", JSON.stringify(r.structuredContent), true)
  }
  const { artifacts } = r.structuredContent as { artifacts: Artifact[] }
  const box = $("delivered")
  box.replaceChildren()
  for (const artifact of artifacts) {
    const read = (await client.readResource({ uri: artifact.uri })).contents[0]
    const bytes = "blob" in read ? Uint8Array.from(atob(read.blob), (c) => c.charCodeAt(0)) : new TextEncoder().encode(read.text)
    const hash = await sha256Hex(bytes)
    const ok = bytes.length === artifact.size && hash === artifact.sha256
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: artifact.mimeType }))
    const row = document.createElement("div")
    row.className = "artifact"
    row.innerHTML = `<strong></strong><a download></a><span class="meta"></span>`
    row.children[0].textContent = `${artifact.role}: ${artifact.name}`
    Object.assign(row.children[1] as HTMLAnchorElement, { href: url, download: artifact.name, textContent: "Save" })
    const meta = row.children[2] as HTMLElement
    meta.innerHTML = `${artifact.mimeType} · ${bytes.length.toLocaleString()} bytes · sha256 ${hash.slice(0, 16)}… <span></span>`
    meta.lastElementChild!.className = ok ? "ok" : "bad"
    meta.lastElementChild!.textContent = ok ? "verified" : "MISMATCH"
    if (artifact.role === "primary" && artifact.mimeType.startsWith("audio/")) {
      const audio = Object.assign(document.createElement("audio"), { controls: true, src: url })
      row.append(audio)
    }
    box.append(row)
    log("delivered", `${artifact.role} ${artifact.name} ${bytes.length} bytes ${ok ? "sha256 ok" : "VERIFY FAILED"}`, !ok)
  }
  views.get(handle.jobId)?.bridge
    .notification({ method: NOTIFY.delivered, params: { jobId: handle.jobId, artifacts: artifacts.map((a) => a.uri) } })
    .catch(() => {})
}

function run(args: Record<string, unknown>) {
  invoke(args).catch((e) => log("error", (e as Error).message, true))
}

$("invoke").addEventListener("click", () => {
  try {
    run(JSON.parse(argsBox.value))
  } catch (e) {
    log("error", `arguments: ${(e as Error).message}`, true)
  }
})
$("invoke-empty").addEventListener("click", () => run({}))

connect().catch((e) => {
  $("server").textContent = "connection failed"
  log("connect", (e as Error).message, true)
})
