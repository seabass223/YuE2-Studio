# MCP Micro-UI Jobs

| | |
|---|---|
| **Version** | 0.1.0 (draft) |
| **Extension id** | `dev.micro-ui/jobs` |
| **Builds on** | [MCP](https://modelcontextprotocol.io/specification) 2025-11-25 or 2026-07-28; [MCP Apps](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) 2026-01-26 (`io.modelcontextprotocol/ui`) |
| **Reference** | `reference/invoker` (headless CLI), `reference/host` (browser host); first server: YuE2 Studio |

An MCP server exposes a long-running job (rendering a song, a video, a report). The job comes with a
small embedded UI (a *micro UI*) that shows its live status. The finished payload is delivered back
into the application that started it, exactly once.

MCP Apps standardizes the embedded UI. MCP itself has progress notifications, and the Tasks
extension provides durable handles. Nothing standard yet covers how these pieces fit together:

- how the UI learns about the job;
- how status reaches the UI;
- how a binary payload is described and fetched;
- who is responsible for delivering the result.

This profile defines those parts, and nothing else.

The key words MUST, SHOULD and MAY are used as described in RFC 2119.

## 1. Roles

| Role | Who | Responsibility |
|---|---|---|
| **Server** | MCP server | Runs jobs. Exposes the start tool, the companion tools, the View resource and the artifact resources. |
| **Invoker** | Third-party app: an MCP client, usually also an MCP Apps host | Starts the job, renders the View, tracks the job itself, and fetches and delivers the payload. |
| **View** | The micro UI: an MCP Apps `ui://` HTML resource running in the Invoker's sandbox | Shows status, collects missing input, and lets the user cancel. Presentation only. |

**Rule:** the View is never the source of truth. The Invoker MUST be able to finish the whole flow
without it, whether the View has been torn down, the host has no UI, or the View misbehaves.

**Rule:** what happens to the payload is the Invoker's decision. That includes playing it, opening it
or showing it. Neither the View nor any other UI of the Server (for example the Server's own app
window) may play or open an Invoker's payload automatically. Any player the View shows MUST start
paused, and it plays only when the user acts.

## 2. Capability negotiation

- **Server.** It MUST advertise `capabilities.extensions["dev.micro-ui/jobs"] = {"version": "0.1.0"}`.
  On 2026-07-28 this goes in the `server/discover` result. Handshake-era versions (2025-11-25 and
  earlier) have no `extensions` field, so on those the Server SHOULD put the same value in
  `capabilities.experimental["dev.micro-ui/jobs"]`.
- **Discovery.** The start tool's `_meta["dev.micro-ui/jobs"]` (§3) is enough, on its own, to tell
  that the Server implements the profile. An Invoker MUST NOT refuse a Server just because the
  capability entry is missing.
- **Invoker as client.** It SHOULD declare the same key in its client capabilities. A Server MUST NOT
  require that declaration.
- **Invoker as View host.** If it renders Views and consumes the View notifications (§6), it MUST set
  `hostCapabilities.experimental["dev.micro-ui/jobs"] = {"version": "0.1.0"}` in its `ui/initialize`
  result.

Unknown fields MUST be ignored. Minor versions only add fields; a major version changes the extension id.

## 3. Tools

The Server registers one **start tool** for each kind of job, plus three **companion tools**. The
Server chooses all the tool names. The Invoker MUST find them through `_meta["dev.micro-ui/jobs"]`.

| Tool | `_meta["dev.micro-ui/jobs"]` | MCP Apps `_meta.ui` |
|---|---|---|
| start (e.g. `generate_song`) | `{"role":"start","statusTool":"…","resultTool":"…","cancelTool":"…"}` | `resourceUri` SHOULD be set; visibility MUST include `"app"` if the View can submit input (§3.1) |
| status | `{"role":"status"}` | visibility MUST include `"app"` |
| result | `{"role":"result"}` | visibility MUST include `"app"` |
| cancel | `{"role":"cancel"}` | visibility MUST include `"app"` |

The companion tools SHOULD also be visible to the model, so that a text-only model can follow a job.

### 3.1 Start tool

The start tool MUST return within a few seconds, and never wait for the job to finish. Its
`structuredContent` is one of the following:

- **JobHandle**: `{jobId, state:"working", statusTool, resultTool, cancelTool, pollIntervalMs, ttlMs, createdAt}`.
  The job has been accepted, possibly into a queue.
- **InputNeeded**: `{state:"input_required", missing:[…], draft:{…}, statusTool, resultTool, cancelTool, pollIntervalMs, ttlMs}`.
  - There is no `jobId`, because nothing has started yet.
  - The View collects the missing arguments and calls the start tool again with the complete set.
  - The Server MUST NOT return this unless the client negotiated MCP Apps support.
  - This `state` value is unrelated to the 2026-07-28 core `InputRequiredResult`.
- **Error**: see §8.

The text `content` MUST let a model without UI support carry on. It SHOULD name the job id and say
how to poll.

### 3.2 Status tool: `{jobId, waitMs?}` → JobStatus

- With `waitMs` = 0 or absent, the tool MUST return the current status at once.
- With `waitMs` from 1 to 30000, the tool MAY hold the call. It MUST return as soon as any of these
  happens:
  - the job reaches a terminal state;
  - `phase` changes;
  - `waitMs` runs out.

  While the call is held, if the request carried `_meta.progressToken`, the Server SHOULD send
  `notifications/progress {progress (0–1), total: 1, message}`.
- An unknown or expired `jobId` produces the `not_found` error.

### 3.3 Result tool: `{jobId, inline?}` → JobResult

- **Job still `working`:** error `not_ready`, with `retryAfterMs`.
- **Job `failed` or `cancelled`:** error `failed` or `cancelled`.
- **Job `completed`:**
  - `content` holds one `resource_link` per artifact, plus a text summary.
  - `structuredContent` is a JobResult (§4).
- **`inline: true`:** the Server MAY also embed the primary artifact as `audio`, `image` or
  embedded-`resource` content. It MAY decline to do so above 10 MB.
- **Idempotence:** the tool MUST be idempotent for `ttlMs`, returning the same URIs and the same
  `sha256` every time.

### 3.4 Cancel tool: `{jobId}` → JobStatus

- **Idempotent.** On a job that is already terminal, the tool returns its current status unchanged.
- **Cooperative.** The state MAY stay `working` for a short while before it becomes `cancelled`.

## 4. Types

The machine-readable definitions are in [`schema/micro-ui-jobs.schema.json`](schema/micro-ui-jobs.schema.json).

**JobStatus**

| Field | Type | Notes |
|---|---|---|
| `jobId` | string | Opaque. MUST be unguessable, with at least 64 random bits. |
| `state` | `working` \| `input_required` \| `completed` \| `failed` \| `cancelled` | The same vocabulary as MCP Tasks. The last three are terminal. |
| `phase` | string | A short machine-friendly label, such as `queued`, `loading` or `generating`. Set by the Server. |
| `progress` | number 0–1 \| null | Null means indeterminate. MUST NOT decrease within a job. |
| `message` | string | A human-readable line for the UI. |
| `elapsedMs` | integer | Time since the job was created. |
| `etaMs` | integer? | Optional estimate of the time remaining. |
| `pollIntervalMs` | integer | Clients MUST NOT poll faster than this. |
| `updatedAt` | RFC 3339 string | |
| `error` | `{code, message}`? | Present when `state` is `failed`. |
| `data` | object? | Detail specific to the job's domain. Invokers MUST NOT depend on it. |

**Artifact**

| Field | Type | Notes |
|---|---|---|
| `uri` | string | An MCP resource URI on the issuing Server. |
| `name` | string | A suggested file name. |
| `mimeType` | string | |
| `size` | integer | Size in bytes. |
| `sha256` | string | Lowercase hex digest of the bytes. |
| `role` | `primary` \| `alternate` \| `auxiliary` | Exactly one artifact is `primary`. `alternate` is the same content in another format. |
| `durationMs` | integer? | For time-based media. |
| `url` | string? | An optional direct HTTP(S) URL for the same bytes (§5). |

**JobResult** (`structuredContent` of the result tool) is `{jobId, state:"completed", artifacts: Artifact[], data?}`.

## 5. Payload delivery

1. Artifacts are MCP resources. The Invoker MUST be able to fetch every artifact with
   `resources/read {uri}`. The result is a `blob` (base64), or `text` for text types.
2. The Invoker MUST check the received bytes against `size` and `sha256`. If they don't match, the
   delivery has failed; the Invoker MAY retry.
3. `url` is only a shortcut, for when the Invoker can reach the Server over HTTP (for example on the
   same machine). The Server SHOULD limit `url` to loopback, or to URLs without long-lived
   credentials. The Invoker MUST NOT require `url`.
4. The Invoker MUST NOT fetch an artifact from any server other than the one that issued it.

## 6. View protocol

The View is an MCP Apps View and follows that spec. This profile adds four JSON-RPC notifications on
the same postMessage channel:

| Direction | Method | Params | Sent |
|---|---|---|---|
| View → Host | `micro-ui-jobs/notifications/started` | JobHandle | Once, when the View started the job itself (§3.1, InputNeeded) |
| View → Host | `micro-ui-jobs/notifications/status` | JobStatus | Whenever `state`, `phase`, `progress` or `message` changes |
| View → Host | `micro-ui-jobs/notifications/completed` | `{jobId, state, result?: JobResult, error?}` | Once per job, when it reaches a terminal state |
| Host → View | `micro-ui-jobs/notifications/delivered` | `{jobId, artifacts: uri[]}` | After the Invoker has delivered the payload (§7, step 5) |

The View:

1. MUST read the JobHandle or InputNeeded from `ui/notifications/tool-result` (`structuredContent`).
2. On InputNeeded, MUST render input, call the start tool through `tools/call`, and then continue
   with the JobHandle that comes back.
3. MUST poll the status tool through `tools/call`, no more often than `pollIntervalMs`. It SHOULD NOT
   use `waitMs`, because hosts may put timeouts on proxied calls. It MAY back off after errors.
4. SHOULD send the View → Host notifications only when the host advertised
   `hostCapabilities.experimental["dev.micro-ui/jobs"]`.
5. When the job completes:
   - MUST call the result tool and send `completed`;
   - SHOULD call `ui/update-model-context` with a one-line summary and the primary artifact URI;
   - MUST NOT call `ui/message` unless the user acts;
   - MUST NOT start playback or open the payload by itself (§1).
6. MUST NOT cancel the job when it is torn down. It cancels only on an explicit user action, through
   the cancel tool.
7. When remounted with the same handle, MUST resume polling. All of the companion tools are idempotent.

## 7. Invoker requirements

1. **Discover.** Run `tools/list`. Find the start tool by `role:"start"` and read the names of its
   companion tools.
2. **Start.** Call the start tool and keep the `jobId`. If the result is InputNeeded, render the View;
   the `jobId` then arrives with `started`.
3. **Render.** If the Invoker is an MCP Apps host, render `_meta.ui.resourceUri` as the MCP Apps spec
   says. Proxy the View's `tools/call` for tools whose visibility includes `"app"`. Advertise the
   profile (§2).
4. **Track independently.** The Invoker MUST follow the job itself through the status tool.
   Long-polling with `waitMs` is RECOMMENDED. A `completed` notification from the View MAY trigger
   step 5 earlier, but the Invoker MUST NOT depend on the View for it.
5. **Deliver exactly once.** When the job is `completed`:
   - call the result tool;
   - fetch and verify the artifacts (§5);
   - hand them to the application, at most once per `jobId` (deduplicate by `jobId`, because the
     View notification and the Invoker's own tracking can both fire);
   - send `delivered` to the View if it is mounted.
6. **Failure.** When the job is `failed` or `cancelled`, show the error and deliver nothing.
7. **Cancel.** User cancellation in the Invoker's own UI MUST call the cancel tool. Tearing down the
   View MUST NOT cancel the job.
8. **Lifetime.** After `ttlMs`, the companion tools MAY return `not_found`. Artifacts already fetched
   remain valid.

A **headless Invoker** (no UI) runs only steps 1, 2, 4, 5 and 6:

```
start → status(waitMs=25000) … until terminal → result → resources/read each artifact → verify → deliver
```

## 8. Errors

Tool-level errors use `isError: true`, `structuredContent.error = {code, message, retryAfterMs?}`, and
a text block. Protocol-level failures, such as an unknown tool, remain JSON-RPC errors.

| Code | Meaning |
|---|---|
| `invalid_input` | The start arguments were rejected. The message explains why. |
| `not_found` | The `jobId` is unknown or expired. |
| `not_ready` | The result was requested while the job is still `working`. |
| `busy` | The Server can't accept a job right now. Retry after `retryAfterMs`. |
| `unavailable` | The Server is unable to run jobs, for example because its model failed to load. |
| `failed` | The job failed. |
| `cancelled` | The job was cancelled. |

## 9. Security

- The View runs under the MCP Apps sandbox and CSP. This profile requests no extra permissions.
- A `jobId` is a bearer capability. Servers SHOULD scope it to the issuing session or user if they
  serve more than one principal.
- Artifact URIs are only meaningful on the issuing Server. Invokers MUST treat every string from the
  Server and the View as untrusted data.

## 10. Relationship to other work

- **MCP Tasks** (`io.modelcontextprotocol/tasks`, SEP-2663):
  - The `state` values match.
  - A Server MAY also implement Tasks. If it does, `jobId` SHOULD equal `taskId`, and the status tool
    SHOULD agree with `tasks/get`.
  - This profile exists because Tasks has no numeric progress, no binding to a View, and no artifact
    descriptor. Few hosts support Tasks yet.
- **Plain MCP Apps hosts** that ignore this profile still work, in degraded form. The View shows
  progress and updates the model context, and the model can call the result tool itself.
- **MCP-UI / OpenAI Apps SDK:** both converged on MCP Apps, which is the View transport this profile
  assumes.

## Repository layout

The directory is self-contained, so it can be moved to its own repository as-is:

```
README.md                         this spec
schema/micro-ui-jobs.schema.json  JSON Schema (2020-12) for every type and notification
examples/trace.md                 annotated end-to-end message trace
reference/invoker/                headless Python invoker (works against any conforming server)
reference/host/                   minimal browser host: renders the View, delivers the payload
```
