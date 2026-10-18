# YuE2 Studio over MCP: integration guide

**Audience:** the team building an application that calls YuE2 Studio to generate songs. This guide
calls that application the *Invoker*.

**Scope:** this file is self-contained. It covers:

- how to connect;
- every tool, argument and limit;
- the full protocol your application must follow (*MCP Micro-UI Jobs*, v0.1.0);
- the JSON Schema;
- an annotated message trace;
- reference code and a conformance checklist.

| | |
|---|---|
| Server | YuE2 Studio, a local GPU song generator on Windows |
| Transport | MCP Streamable HTTP at `http://127.0.0.1:7862/mcp`, or stdio via a launcher script |
| MCP versions | 2026-07-28 (preferred), or the 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 handshake |
| Embedded UI | MCP Apps 2026-01-26 (`io.modelcontextprotocol/ui`) |
| Job profile | MCP Micro-UI Jobs 0.1.0 (`dev.micro-ui/jobs`), specified in section 6 |
| Auth | None. Loopback only. |

---

## Contents

1. [What happens, in one paragraph](#1-what-happens-in-one-paragraph)
2. [Quick start](#2-quick-start)
3. [Connecting](#3-connecting)
4. [YuE2 Studio tool and resource reference](#4-yue2-studio-tool-and-resource-reference)
5. [Timing, queueing and limits](#5-timing-queueing-and-limits)
6. [The protocol: MCP Micro-UI Jobs 0.1.0 (normative)](#6-the-protocol-mcp-micro-ui-jobs-010-normative)
7. [Implementing the Invoker](#7-implementing-the-invoker)
8. [Example trace](#8-example-trace)
9. [Conformance checklist](#9-conformance-checklist)
10. [Troubleshooting](#10-troubleshooting)
11. [Appendix A: JSON Schema](#appendix-a-json-schema)
12. [Appendix B: why a profile on top of MCP Apps](#appendix-b-why-a-profile-on-top-of-mcp-apps)

---

## 1. What happens, in one paragraph

1. Your application calls the MCP tool `generate_song`. It returns a **job handle** right away:
   generating a song takes about 1–2× the song's length.
2. If your application is an MCP Apps host, it renders YuE2's small embedded UI (the *View*,
   `ui://yue2/song.html`). The View shows live progress, and a player when the song is done.
3. Whether or not it renders the View, your application follows the job itself with `job_status`.
4. When the job completes, it calls `job_result`. That returns descriptors for the files: an MP3, a
   FLAC and an ABC score, each with its size and sha256.
5. It downloads the bytes with MCP `resources/read`, verifies them, and hands them to your product
   **exactly once**.

If the user calls without a style, the View shows a small form instead. The job starts when the user
submits it.

---

## 2. Quick start

### Headless (no UI), in Python with `mcp>=2.3`

```python
import asyncio, base64, hashlib
from mcp import Client
from mcp.client import advertise

PROFILE = "dev.micro-ui/jobs"

async def make_song():
    async with Client("http://127.0.0.1:7862/mcp", extensions=[advertise(PROFILE, {"version": "0.1.0"})]) as c:
        tools = (await c.list_tools()).tools
        start = next(t for t in tools if (t.meta or {}).get(PROFILE, {}).get("role") == "start")
        names = start.meta[PROFILE]                      # statusTool / resultTool / cancelTool

        r = await c.call_tool(start.name, {"style": "lofi piano, warm, mellow", "instrumental": True, "max_seconds": 30})
        if r.is_error: raise RuntimeError(r.structured_content["error"])
        job = r.structured_content["jobId"]

        while True:                                      # long-poll; progress notifications arrive meanwhile
            s = (await c.call_tool(names["statusTool"], {"jobId": job, "waitMs": 25000},
                                   progress_callback=lambda p, t, m: print(f"{p:.0%} {m}"),
                                   read_timeout_seconds=40)).structured_content
            if s["state"] in ("completed", "failed", "cancelled"): break
        if s["state"] != "completed": raise RuntimeError(s["message"])

        result = (await c.call_tool(names["resultTool"], {"jobId": job})).structured_content
        for a in result["artifacts"]:
            item = (await c.read_resource(a["uri"])).contents[0]
            data = base64.b64decode(item.blob) if getattr(item, "blob", None) else item.text.encode()
            assert len(data) == a["size"] and hashlib.sha256(data).hexdigest() == a["sha256"]
            open(a["name"], "wb").write(data)            # deliver to your product here, once per jobId

asyncio.run(make_song())
```

### With the embedded UI (MCP Apps host)

Follow the same steps, and also:

- render `_meta.ui.resourceUri` of the start tool in a sandboxed iframe;
- proxy the View's `tools/call` and `resources/read` to the server;
- listen for the four profile notifications.

The TypeScript wiring is in section 7.3.

---

## 3. Connecting

### 3.1 Streamable HTTP (preferred)

- **Endpoint:** `http://127.0.0.1:7862/mcp`. The port is `7862` unless the user sets `YUE2_PORT`.
- **Loopback only:**
  - The `Host` header must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`. Anything else
    gets **421**.
  - Browsers may only call from `http://127.0.0.1:*`, `http://localhost:*` or `http://[::1]:*` origins.
    Anything else gets **403**. A browser app on another origin must call through a local proxy (see
    section 7.3).
- **The backend must be running.** It runs while the user has YuE2 Studio open (Start menu → YuE2
  Studio), or when the stdio launcher below has started it.
- **Health check:** `GET http://127.0.0.1:7862/api/health` returns `{"ok": true, "app": "yue2-studio"}`.

### 3.2 stdio (for clients that launch servers as a command)

```json
{
  "mcpServers": {
    "yue2": {
      "command": "C:\\path\\to\\YuE2 Studio\\.venv\\Scripts\\python.exe",
      "args": ["C:\\path\\to\\YuE2 Studio\\scripts\\mcp_stdio.py"]
    }
  }
}
```

The launcher:

- starts the backend if it isn't running (the first start loads a ~7 GB model);
- keeps the backend alive while connected;
- relays to the HTTP endpoint;
- writes only MCP messages to stdout, with diagnostics on stderr.

Some clients kill the whole process tree on disconnect. With those, a backend that the launcher
started stops with it; a backend the user started from the Start menu keeps running.

### 3.3 What to declare as a client

| Capability | Value | Effect |
|---|---|---|
| `extensions["io.modelcontextprotocol/ui"]` | `{"mimeTypes": ["text/html;profile=mcp-app"]}` | Declare it **only if you render the View**. It enables the form path (`input_required`) when arguments are missing. |
| `extensions["dev.micro-ui/jobs"]` | `{"version": "0.1.0"}` | Says you follow this profile. Recommended. |

With the TypeScript SDK v2, also pass `versionNegotiation: { mode: "auto" }` so the client uses
2026-07-28. The server supports both eras. On 2025-era handshakes the server advertises the profile
under `capabilities.experimental` instead of `capabilities.extensions`.

### 3.4 Backend lifetime (why your job won't be cut off)

- With no studio page open, the backend stays up for **5 minutes after your last MCP request**, and
  for **as long as a song you started is queued or generating**.
- After that it exits on its own. The next call fails to connect: restart it with the stdio launcher,
  or ask the user to open YuE2 Studio.

---

## 4. YuE2 Studio tool and resource reference

The server name is `yue2-studio` (title "YuE2 Studio"). It advertises the extensions
`io.modelcontextprotocol/ui` and `dev.micro-ui/jobs` (`{"version": "0.1.0"}`).

### 4.1 `generate_song` (start tool)

`_meta`:

```json
{ "ui": { "resourceUri": "ui://yue2/song.html" },
  "dev.micro-ui/jobs": { "role": "start", "statusTool": "job_status", "resultTool": "job_result", "cancelTool": "job_cancel" } }
```

Visible to both the model and the app. Arguments (all optional at the schema level; validation rules
below the table):

| Argument | Type | Default | Limits and meaning |
|---|---|---|---|
| `style` | string \| null | null | Genre, mood, instruments and vocal description, e.g. `"dreamy synth-pop, airy female vocals, 100 bpm"`. **Required in practice.** |
| `lyrics` | string \| null | null | Lyrics with section tags `[verse]`, `[chorus]`, `[bridge]`, `[outro]`… **Required unless `instrumental`.** |
| `instrumental` | boolean | `false` | No vocals. The song is fitted to **exactly** `max_seconds`. |
| `max_seconds` | integer | `180` | 10–360. The cap for vocal songs (their length follows the lyrics); the exact length for instrumentals. |
| `seed` | integer \| null | null | Reproducible output. null means random; the seed used is reported in the result. |
| `cot` | `"full"` \| `"melody"` \| `"off"` | `"full"` | Score planning before audio: `full` plans melody and chords (best structure). Instrumentals cannot use `off`. |
| `timeline` | object \| null | null | Instrumentals only. An exact section layout that **overrides `max_seconds`** (see 4.1.1). |
| `temperature` | number \| null | null (1.0) | 0.05–2.0. Sampling temperature. |
| `cfg_scale` | number \| null | null (model default) | 0–5. Style adherence. Values above 1 cost a second branch. |

**Validation.** These failures return `isError: true` with error code `invalid_input`:

- `style` is missing or blank. Exception: an MCP Apps client gets `input_required` instead (4.1.2).
- `lyrics` is missing on a vocal song. Same exception as above.
- `instrumental: true` together with `cot: "off"`.
- An invalid `timeline` (4.1.1).

#### 4.1.1 `timeline` object (instrumentals)

```json
{ "bpm": 120, "meter": "4/4", "strict": true,
  "sections": [ { "label": "intro", "bars": 4 }, { "label": "verse", "bars": 8, "description": "sparse piano" },
                { "label": "chorus", "bars": 8 }, { "label": "outro", "bars": 4 } ] }
```

- `bpm`: 40–240.
- `meter`: `"4/4"` or `"3/4"`.
- `strict`: default `true`. Renders each section separately so boundaries land exactly on the bar
  grid. Slower, but exact.
- `sections`: one or more entries, at least one of them not `silence`.
  - `label` is one of `intro`, `verse`, `pre-chorus`, `chorus`, `bridge`, `interlude`,
    `instrumental`, `outro`, `silence`.
  - `bars` is 1–64.
  - `description` is optional style text for that section only, up to 300 characters.
- Total length is bars × beats per bar × 60 ÷ bpm, and at most 360 s.

#### 4.1.2 Results

**Accepted.** You get a JobHandle:

```json
{ "content": [{ "type": "text", "text": "Started generating an instrumental (…). Job id: song_cadc977584e14a9d. …" }],
  "structuredContent": { "jobId": "song_cadc977584e14a9d", "state": "working", "pollIntervalMs": 1000, "ttlMs": 3600000,
    "createdAt": "2026-10-18T17:09:13.402Z", "statusTool": "job_status", "resultTool": "job_result", "cancelTool": "job_cancel" } }
```

**Input needed.** This happens only if you declared MCP Apps and `style` or `lyrics` was missing:

```json
{ "structuredContent": { "state": "input_required", "missing": ["style", "lyrics"],
    "draft": { "instrumental": false, "max_seconds": 180, "cot": "full" },
    "statusTool": "job_status", "resultTool": "job_result", "cancelTool": "job_cancel", "pollIntervalMs": 1000, "ttlMs": 3600000 } }
```

No job exists yet. Render the View: it shows a form, calls `generate_song` itself when the user
submits, and then sends you `micro-ui-jobs/notifications/started` with the JobHandle.

**Error:**

```json
{ "isError": true, "structuredContent": { "error": { "code": "invalid_input", "message": "Style description is required" } } }
```

### 4.2 `job_status`

- **Arguments:** `{ "jobId": string, "waitMs"?: integer 0–30000 (default 0) }`.
- **`waitMs` = 0:** returns at once.
- **`waitMs` > 0:** the call is held until the job finishes, its `phase` changes, or `waitMs` passes.
  While it's held, if your request carries `_meta.progressToken`, you receive
  `notifications/progress { progress: 0–1, total: 1, message }`.

```json
{ "jobId": "song_cadc977584e14a9d", "state": "working", "phase": "generating", "progress": 0.437,
  "message": "Generating song · 0:08 of music (max 0:20)", "elapsedMs": 17012, "pollIntervalMs": 1000,
  "updatedAt": "2026-10-18T17:09:30.415Z",
  "data": { "request": { "style": "lofi hip hop, dusty drums", "instrumental": true, "max_seconds": 20 },
            "job": { "id": "279665ca4f76", "state": "running", "stage": "Generating song", "completed": 205, "total": null,
                     "unit": "tokens", "audio_seconds": 8.2, "max_seconds": 20, "elapsed": 9.4, "error": null, "part": null,
                     "source": "mcp" } } }
```

**`state`:** `working` → `completed`, `failed` or `cancelled` (terminal).

**`phase`** values YuE2 emits. Treat the list as informative; new values may appear.

| `phase` | Meaning | Typical `progress` |
|---|---|---|
| `queued` | Waiting for another song to finish (one song at a time on the GPU) | 0 |
| `loading` | The model is loading (cold start), or weights are being swapped mid-run | 0, or unchanged |
| `planning` | Writing the melody and chord score | 0–0.15 |
| `generating` | Writing song tokens. `message` shows seconds of music so far. | 0.15–0.85 |
| `synthesizing` | Flow-matching acoustic synthesis | 0.85–0.95 |
| `loading-audio-decoder`, `decoding` | VAE decode | 0.95–0.99 |
| `saving` | Writing files | 0.99 |
| `done` / `cancelled` / `failed` | Terminal | 1 / null / null |

- `progress` never decreases, and stays at or below 0.99 until the state is `completed`.
- `message` is a human-readable line you can show as-is.
- `data` is YuE2-specific. Don't depend on it.

### 4.3 `job_result`

- **Arguments:** `{ "jobId": string, "inline"?: boolean (default false) }`.
- **Job still working:** `isError`, with `{ "error": { "code": "not_ready", "retryAfterMs": 1000 } }`.
- **Job failed or cancelled:** `isError`, with code `failed` or `cancelled`.
- **Job completed:**

```json
{ "content": [
    { "type": "text", "text": "Song ready: lofi hip hop, dusty drums (0:20, seed 1945998502). Audio: yue2://tracks/20261018-130941-279665/audio.mp3" },
    { "type": "resource_link", "uri": "yue2://tracks/20261018-130941-279665/audio.mp3", "name": "20261018-130941-279665.mp3", "mimeType": "audio/mpeg", "size": 802560 },
    { "type": "resource_link", "uri": "yue2://tracks/20261018-130941-279665/audio.flac", "name": "20261018-130941-279665.flac", "mimeType": "audio/flac", "size": 2767788 },
    { "type": "resource_link", "uri": "yue2://tracks/20261018-130941-279665/score.abc", "name": "20261018-130941-279665.abc", "mimeType": "text/plain", "size": 388 } ],
  "structuredContent": { "jobId": "song_cadc977584e14a9d", "state": "completed",
    "artifacts": [
      { "uri": "yue2://tracks/20261018-130941-279665/audio.mp3",  "name": "20261018-130941-279665.mp3",  "mimeType": "audio/mpeg", "size": 802560,
        "sha256": "9cbd7c5e289dbbba…", "role": "primary",   "durationMs": 20000, "url": "http://127.0.0.1:7862/api/tracks/20261018-130941-279665/audio.mp3" },
      { "uri": "yue2://tracks/20261018-130941-279665/audio.flac", "name": "20261018-130941-279665.flac", "mimeType": "audio/flac", "size": 2767788,
        "sha256": "bee8908a59b6b577…", "role": "alternate", "durationMs": 20000, "url": "http://127.0.0.1:7862/api/tracks/20261018-130941-279665/audio.flac" },
      { "uri": "yue2://tracks/20261018-130941-279665/score.abc",  "name": "20261018-130941-279665.abc",  "mimeType": "text/plain", "size": 388,
        "sha256": "6fe58eec198fb105…", "role": "auxiliary", "url": "http://127.0.0.1:7862/api/tracks/20261018-130941-279665/score.abc" } ],
    "data": { "track": { "id": "20261018-130941-279665", "created": "…", "duration": 20.0, "truncated": true, "seconds_taken": 21.1,
                         "has_score": true, "params": { "style": "…", "seed": 1945998502, "…": "…" } },
              "studioUrl": "http://127.0.0.1:7862" } } }
```

The artifacts:

| Role | File | Format |
|---|---|---|
| `primary` | `audio.mp3` | MP3, 320 kbps CBR, 48 kHz stereo. Use this one by default. |
| `alternate` | `audio.flac` | FLAC, 48 kHz stereo, 24-bit. Lossless, about 3–5× larger. |
| `auxiliary` | `score.abc` | ABC notation of the planned score. Present only when a score was planned (`cot` not `off`). |

`inline: true` also embeds the MP3 as `{ "type": "audio", "data": <base64>, "mimeType": "audio/mpeg" }`.
That is about 2.4 MB per minute of audio before base64. Prefer `resources/read`.

### 4.4 `job_cancel`

- **Arguments:** `{ "jobId": string }`. Returns a JobStatus.
- **Queued job:** cancelled immediately (`"Cancelled before it started"`).
- **Running job:** stops within a few seconds. The state moves from `working` to `cancelled`.
- **Idempotent:** on a terminal job it returns that job's status unchanged.

### 4.5 Resources

| URI | MIME | Content |
|---|---|---|
| `ui://yue2/song.html` | `text/html;profile=mcp-app` | The View: one self-contained HTML file (~600 KB, inline JS and CSS). |
| `yue2://tracks/{trackId}/audio.mp3` | `audio/mpeg` | `blob` (base64). Encoded on first request; the first read of a long song can take a few seconds. |
| `yue2://tracks/{trackId}/audio.flac` | `audio/flac` | `blob` (base64) |
| `yue2://tracks/{trackId}/score.abc` | `text/plain` | `text` |

The track resources are resource templates (`resources/templates/list`). Get the URIs from
`job_result`; don't build them yourself. The `url` fields serve the same bytes over plain HTTP, for
invokers on the same machine.

### 4.6 What the View needs from your host

The View needs **no network access**, **no `allow-forms`** and **no `allow-same-origin`**.
`sandbox="allow-scripts"` and a CSP with `connect-src 'none'` are enough. Audio plays from `data:`
URLs, so `media-src data:` must be allowed. The MCP Apps default policy allows it.

| The View uses | For | If you don't support it |
|---|---|---|
| `ui/initialize`, `ui/notifications/tool-input`, `ui/notifications/tool-result` | Startup and the job handle | The View can't work |
| `tools/call` → `job_status`, `job_result`, `job_cancel`, `generate_song` | Polling, result, Cancel button, form submit | The View shows no progress |
| `resources/read` → `yue2://…/audio.mp3` | Its built-in player, which starts paused and never autoplays | The player never loads; everything else works |
| `ui/notifications/size-changed` | Auto-height | Give the iframe enough height (~300 px) |
| `ui/notifications/host-context-changed` (`theme`) | Light or dark theme | It follows `prefers-color-scheme` |
| `ui/update-model-context` | Tells your model the song is ready and gives the primary artifact URI | Harmless if unsupported |
| `ui/open-link` → `http://127.0.0.1:7862` | "Open in YuE2 Studio" button | The button does nothing |
| Profile notifications (section 6.6) | `started`, `status`, `completed`; listens for `delivered` | Sent only if you advertise the profile in `hostCapabilities.experimental` |

---

## 5. Timing, queueing and limits

- **Duration.** Expect about **1–2× the song length** on the user's RTX 3060: a 20 s instrumental
  took about 35 s, a 60 s one about 66 s. A cold start adds model loading (tens of seconds). The
  first-ever run downloads ~7.8 GB.
- **One song at a time.** MCP jobs queue first-in first-out, behind each other and behind any song
  the user starts in the studio window (`phase: "queued"`). The server never returns `busy`.
- **Lifetimes:**
  - A job handle is valid for `ttlMs` = 1 hour after the job finishes; after that, `not_found`.
  - Songs persist on disk, and their resource URIs stay valid until the user deletes the song in the
    studio.
  - Handles don't survive a backend restart. Songs do.
- **Polling.** Use `pollIntervalMs` = 1000 for short polls, or long-poll with `waitMs` up to 30000.
  Allow at least `waitMs` + 15 s of client-side timeout.
- **Sizes.** The MP3 is about 2.4 MB per minute, the FLAC about 8–15 MB per minute. `resources/read`
  returns base64 (+33%).
- **Shared library.** Songs made over MCP appear in the user's studio library like any other. If the
  studio window is open, it shows the song's progress and adds the song to its library when it's
  done. It never plays an MCP-requested song by itself: playback is your application's decision.

---

## 6. The protocol: MCP Micro-UI Jobs 0.1.0 (normative)

> This section is the profile specification your Invoker must follow. YuE2 Studio is one server that
> implements it, and the same rules apply to any other server. The key words MUST, SHOULD and MAY are
> used as described in RFC 2119.

### 6.1 Roles

| Role | Who | Responsibility |
|---|---|---|
| **Server** | MCP server (YuE2 Studio) | Runs jobs. Exposes the start tool, the companion tools, the View resource and the artifact resources. |
| **Invoker** | Your application: an MCP client, usually also an MCP Apps host | Starts the job, renders the View, tracks the job itself, and fetches and delivers the payload. |
| **View** | The micro UI: an MCP Apps `ui://` HTML resource running in your sandbox | Shows status, collects missing input, and lets the user cancel. Presentation only. |

**Rule:** the View is never the source of truth. The Invoker MUST be able to finish the whole flow
without it, whether the View has been torn down, the host has no UI, or the View misbehaves.

**Rule:** what happens to the payload is the Invoker's decision. That includes playing it, opening it
or showing it. Neither the View nor any other UI of the Server may play or open an Invoker's payload
automatically. Any player the View shows MUST start paused, and it plays only when the user acts.
YuE2 Studio follows this: its embedded player never autoplays, and the studio window adds
MCP-requested songs to its library without playing them.

### 6.2 Capability negotiation

- **Server, 2026-07-28.** It MUST advertise `capabilities.extensions["dev.micro-ui/jobs"] = {"version": "0.1.0"}`.
- **Server, handshake-era versions** (2025-11-25 and earlier). These have no `extensions` field, so
  the Server SHOULD advertise the same value under `capabilities.experimental["dev.micro-ui/jobs"]`.
- **Discovery.** The start tool's `_meta["dev.micro-ui/jobs"]` is enough, on its own, to tell that the
  Server implements the profile. An Invoker MUST NOT refuse a Server just because the capability
  entry is missing.
- **Invoker as client.** It SHOULD declare the same key in its client capabilities. Servers MUST NOT
  require that declaration.
- **Invoker as View host.** If it renders Views and consumes the View notifications (6.6), it MUST set
  `hostCapabilities.experimental["dev.micro-ui/jobs"] = {"version": "0.1.0"}` in its `ui/initialize`
  result.
- **Versioning.** Unknown fields MUST be ignored. Minor versions only add fields; a major version
  changes the extension id.

### 6.3 Tools

The Server registers one **start tool** per kind of job, plus three **companion tools**. The Server
chooses all the names. The Invoker MUST find them through `_meta["dev.micro-ui/jobs"]`, not by
hard-coding them.

| Tool | `_meta["dev.micro-ui/jobs"]` | MCP Apps `_meta.ui` |
|---|---|---|
| start | `{"role":"start","statusTool":"…","resultTool":"…","cancelTool":"…"}` | `resourceUri` SHOULD be set; visibility MUST include `"app"` if the View can submit input |
| status | `{"role":"status"}` | visibility MUST include `"app"` |
| result | `{"role":"result"}` | visibility MUST include `"app"` |
| cancel | `{"role":"cancel"}` | visibility MUST include `"app"` |

**Start tool.** It MUST return within a few seconds, and never wait for the job to finish. Its
`structuredContent` is one of the following:

- **JobHandle**: `{jobId, state:"working", statusTool, resultTool, cancelTool, pollIntervalMs, ttlMs, createdAt}`.
- **InputNeeded**: `{state:"input_required", missing[], draft{}, statusTool, resultTool, cancelTool, pollIntervalMs?, ttlMs?}`.
  - There is no `jobId`.
  - The Server MUST NOT return this unless the client negotiated MCP Apps.
  - This value is unrelated to the 2026-07-28 core `InputRequiredResult`.
- **Error**: see 6.9.

The text `content` MUST let a model without UI support carry on, by naming the job id and saying how
to poll.

**Status tool, `{jobId, waitMs?}` → JobStatus.**

- `waitMs` 0 or absent: the tool returns at once.
- `waitMs` 1–30000: the tool MAY hold the call. It MUST return as soon as any of these happens:
  - the job reaches a terminal state;
  - `phase` changes;
  - `waitMs` runs out.
- While the call is held, if the request carried `_meta.progressToken`, the Server SHOULD send
  `notifications/progress {progress (0–1), total: 1, message}`.
- An unknown or expired id produces `not_found`.

**Result tool, `{jobId, inline?}` → JobResult.**

- Job `working`: `not_ready`, with `retryAfterMs`.
- Job `failed` or `cancelled`: that code.
- Job `completed`:
  - `content` holds one `resource_link` per artifact, plus a text summary;
  - `structuredContent` is a JobResult.
- `inline: true`: the Server MAY also embed the primary artifact. It MAY decline above 10 MB.
- The tool MUST be idempotent for `ttlMs`: the same URIs and the same `sha256` every time.

**Cancel tool, `{jobId}` → JobStatus.**

- Idempotent. On a terminal job it returns the status unchanged.
- Cooperative. The state MAY stay `working` briefly before it becomes `cancelled`.

### 6.4 Types

**JobStatus**

| Field | Type | Notes |
|---|---|---|
| `jobId` | string | Opaque and unguessable (at least 64 random bits). |
| `state` | `working` \| `input_required` \| `completed` \| `failed` \| `cancelled` | The same vocabulary as MCP Tasks. The last three are terminal. |
| `phase` | string | Short machine label. Set by the Server. |
| `progress` | number 0–1 \| null | Null means indeterminate. MUST NOT decrease within a job. |
| `message` | string | A human-readable line. |
| `elapsedMs` | integer | Time since the job was created. |
| `etaMs` | integer? | Optional. |
| `pollIntervalMs` | integer | Clients MUST NOT poll faster than this. |
| `updatedAt` | RFC 3339 | |
| `error` | `{code, message}`? | Present when `state` is `failed`. |
| `data` | object? | Domain detail. Invokers MUST NOT depend on it. |

**Artifact**

| Field | Type | Notes |
|---|---|---|
| `uri` | string | An MCP resource URI on the issuing Server. |
| `name` | string | A suggested file name. Treat it as a bare name: strip any path. |
| `mimeType` | string | |
| `size` | integer | Size in bytes. |
| `sha256` | string | Lowercase hex digest. |
| `role` | `primary` \| `alternate` \| `auxiliary` | Exactly one artifact is `primary`. `alternate` is the same content in another format. |
| `durationMs` | integer? | For media. |
| `url` | string? | An optional direct HTTP(S) URL for the same bytes. |

**JobResult** is `{jobId, state:"completed", artifacts: Artifact[], data?}`.

### 6.5 Payload delivery

1. Artifacts are MCP resources. The Invoker MUST be able to fetch every artifact with
   `resources/read {uri}`. The result is a `blob` (base64), or `text` for text types.
2. The Invoker MUST check the bytes against `size` and `sha256`. If they don't match, the delivery has
   failed; the Invoker MAY retry.
3. `url` is only a shortcut. The Server SHOULD limit it to loopback, or to URLs without long-lived
   credentials. The Invoker MUST NOT require `url`.
4. The Invoker MUST NOT fetch an artifact from any server other than the one that issued it.

### 6.6 View protocol

The View is an MCP Apps View. These JSON-RPC notifications are added on the same postMessage channel:

| Direction | Method | Params | Sent |
|---|---|---|---|
| View → Host | `micro-ui-jobs/notifications/started` | JobHandle | Once, when the View started the job itself (InputNeeded path) |
| View → Host | `micro-ui-jobs/notifications/status` | JobStatus | Whenever `state`, `phase`, `progress` or `message` changes |
| View → Host | `micro-ui-jobs/notifications/completed` | `{jobId, state, result?: JobResult, error?}` | Once per job, when it reaches a terminal state |
| Host → View | `micro-ui-jobs/notifications/delivered` | `{jobId, artifacts: uri[]}` | After the Invoker has delivered the payload |

The View:

1. MUST read the JobHandle or InputNeeded from `ui/notifications/tool-result` (`structuredContent`).
2. On InputNeeded, MUST render input, call the start tool through `tools/call`, and continue with the
   JobHandle that comes back.
3. MUST poll the status tool through `tools/call`, no more often than `pollIntervalMs`. It SHOULD NOT
   use `waitMs`. It MAY back off after errors.
4. SHOULD send the View → Host notifications only when the host advertised
   `hostCapabilities.experimental["dev.micro-ui/jobs"]`.
5. When the job completes:
   - MUST call the result tool and send `completed`;
   - SHOULD call `ui/update-model-context` with a one-line summary and the primary artifact URI;
   - MUST NOT call `ui/message` unless the user acts;
   - MUST NOT start playback or open the payload by itself (6.1).
6. MUST NOT cancel the job when it is torn down. It cancels only on an explicit user action, through
   the cancel tool.
7. When remounted with the same handle, MUST resume polling. All of the companion tools are idempotent.

### 6.7 Invoker requirements (what you must implement)

1. **Discover.** Run `tools/list`, find the start tool by `role:"start"`, and read the names of its
   companion tools.
2. **Start.** Call the start tool and keep the `jobId`. On InputNeeded, render the View; the `jobId`
   arrives with `started`.
3. **Render.** If you are an MCP Apps host, render `_meta.ui.resourceUri` as the MCP Apps spec says.
   Proxy the View's `tools/call`, only for tools whose visibility includes `"app"`. Advertise the
   profile in `hostCapabilities.experimental`.
4. **Track independently.** The Invoker MUST follow the job itself through the status tool.
   Long-polling with `waitMs` is RECOMMENDED. A `completed` notification from the View MAY trigger
   step 5 earlier, but the Invoker MUST NOT depend on it.
5. **Deliver exactly once.** When the job is `completed`:
   - call the result tool;
   - fetch and verify the artifacts;
   - hand them to the application, at most once per `jobId` (deduplicate, because your own tracking
     and the View can both fire);
   - send `delivered` to the View if it is mounted.
6. **Failure.** When the job is `failed` or `cancelled`, show the error and deliver nothing.
7. **Cancel.** User cancellation in the Invoker's own UI MUST call the cancel tool. Tearing down the
   View MUST NOT cancel the job.
8. **Lifetime.** After `ttlMs` the companion tools MAY return `not_found`. Artifacts already fetched
   remain valid.

A **headless Invoker** (no UI) runs steps 1, 2, 4, 5 and 6:
start → status(waitMs=25000) until terminal → result → `resources/read` each artifact → verify → deliver.

### 6.8 Security

- The View runs under the MCP Apps sandbox and CSP. The profile requests no extra permissions.
- A `jobId` is a bearer capability. Servers that serve more than one principal SHOULD scope it to the
  session or user.
- Treat every string from the Server or the View as untrusted data. That includes file names: strip
  paths.

### 6.9 Errors

Tool-level errors use `isError: true`, `structuredContent.error = {code, message, retryAfterMs?}`, and
a text block. Protocol failures, such as an unknown tool, remain JSON-RPC errors.

| Code | Meaning | YuE2 returns it when |
|---|---|---|
| `invalid_input` | The start arguments were rejected | Validation fails (section 4.1) |
| `not_found` | The `jobId` is unknown or expired | The id is wrong, the TTL passed, or the backend restarted |
| `not_ready` | Result requested while the job is still `working` | The result is called too early (`retryAfterMs: 1000`) |
| `busy` | The Server can't accept a job; retry later | Never: YuE2 queues |
| `unavailable` | The Server can't run jobs | Never as an error: queued jobs end `failed` with "Model failed to load: …" |
| `failed` | The job failed | Out of GPU memory, a GPU error, a model error |
| `cancelled` | The job was cancelled | After `job_cancel`, or a cancel from the studio window |

### 6.10 Relationship to other MCP work

- **MCP Tasks** (`io.modelcontextprotocol/tasks`): the `state` values match. A Server MAY also
  implement Tasks, with `jobId` equal to `taskId`. YuE2 doesn't; few hosts support Tasks yet.
- **Plain MCP Apps hosts** that ignore this profile still work, in degraded form. The View shows
  progress and updates the model context, and the model can call `job_result` itself.

---

## 7. Implementing the Invoker

### 7.1 State machine (per invocation)

```
             tools/call start
 IDLE ─────────────────────────▶ STARTED ──(JobHandle)──▶ TRACKING ──(state=completed)──▶ DELIVERING ──▶ DELIVERED
                                   │                        │  ▲                               │
                                   │ (input_required)       │  └─ status(waitMs) loop          │ result + resources/read + verify
                                   ▼                        │                                  │ (guard: once per jobId)
                              AWAITING_INPUT                ├──(failed|cancelled)──▶ ENDED     ▼
                     (View shows form; wait for            │                              notify View "delivered"
                      micro-ui-jobs/.../started)───────────┘
```

Two triggers lead to DELIVERING: your own long-poll seeing `completed`, and the View's `completed`
notification. Guard with a `Set<jobId>`, so whichever arrives second does nothing.

### 7.2 Headless reference (Python)

The full version is the reference CLI in the YuE2 repository:
`specs/mcp-micro-ui-jobs/reference/invoker/invoker.py`. The core is in section 2. Points to get right:

- Use `read_timeout_seconds` of at least `waitMs` + 15 s on long-polls.
- Decode `blob` with base64. For `text` contents, encode as UTF-8 before hashing.
- Write files under your own directory, using only the base name of `artifact.name`.

### 7.3 MCP Apps host reference (TypeScript)

Packages: `@modelcontextprotocol/client@^2.3`, `@modelcontextprotocol/ext-apps@2.0.3`, `zod@^4`. The full
version is `specs/mcp-micro-ui-jobs/reference/host/src/main.ts` in the YuE2 repository.

```ts
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/client"
import { AppBridge, PostMessageTransport, getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge"
import { z } from "zod"

const PROFILE = "dev.micro-ui/jobs", APP_MIME = "text/html;profile=mcp-app"
const N = { started: "micro-ui-jobs/notifications/started", status: "micro-ui-jobs/notifications/status",
            completed: "micro-ui-jobs/notifications/completed", delivered: "micro-ui-jobs/notifications/delivered" }

const client = new Client({ name: "my-app", version: "1.0.0" }, {
  capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [APP_MIME] }, [PROFILE]: { version: "0.1.0" } } } as never,
  versionNegotiation: { mode: "auto" },
})
// A browser app on another origin: proxy /mcp to http://127.0.0.1:7862/mcp on a loopback origin (section 3.1).
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:7862/mcp")))
const tools: Tool[] = (await client.listTools()).tools
const start = tools.find((t) => (t._meta?.[PROFILE] as any)?.role === "start")!

const handles = new Map<string, any>(), views = new Map<string, AppBridge>(), tracked = new Set<string>(), delivered = new Set<string>()

async function mountView(uri: string, container: HTMLElement) {
  const html = ((await client.readResource({ uri })).contents[0] as { text: string }).text
  const frame = document.createElement("iframe")
  frame.setAttribute("sandbox", "allow-scripts")                     // opaque origin: no storage, no parent DOM
  container.append(frame)
  const bridge = new AppBridge(null, { name: "my-app", version: "1.0.0" },
    { serverTools: {}, serverResources: {}, openLinks: {}, updateModelContext: { text: {} }, experimental: { [PROFILE]: { version: "0.1.0" } } },
    { hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"] } })
  bridge.oncalltool = async (p) => {                                 // proxy, respecting visibility
    const t = tools.find((x) => x.name === p.name)
    const vis = ((t?._meta?.ui as any)?.visibility ?? ["model", "app"]) as string[]
    if (!t || !vis.includes("app")) throw new Error(`${p.name} not available to apps`)
    return client.callTool(p)
  }
  bridge.onreadresource = (p) => client.readResource(p)
  bridge.onupdatemodelcontext = async (p) => { /* add p.content to your model's context */ return {} }
  bridge.onopenlink = async ({ url }) => { window.open(url, "_blank", "noopener"); return {} }
  bridge.onsizechange = ({ height }) => { if (height) frame.style.height = `${height}px` }
  const loose = z.looseObject({ jobId: z.string() })
  bridge.setNotificationHandler(N.started, { params: loose }, (h) => adopt(h, bridge))
  bridge.setNotificationHandler(N.status, { params: loose }, (s) => { /* optional: mirror status in your UI */ })
  bridge.setNotificationHandler(N.completed, { params: loose }, (c) => { if (c.state === "completed") deliver(handles.get(c.jobId)) })
  const ready = new Promise<void>((r) => (bridge.oninitialized = () => r()))
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!))
  frame.srcdoc = html                                                // load only after the bridge listens
  return { bridge, ready }
}

function adopt(handle: any, bridge?: AppBridge) {
  handles.set(handle.jobId, handle); if (bridge) views.set(handle.jobId, bridge); track(handle)
}

export async function invoke(args: Record<string, unknown>, container: HTMLElement) {
  const uri = getToolUiResourceUri(start)
  const view = uri ? await mountView(uri, container) : null
  const result = await client.callTool({ name: start.name, arguments: args })
  if (view) { await view.ready; await view.bridge.sendToolInput({ arguments: args }); await view.bridge.sendToolResult(result as CallToolResult) }
  const sc = result.structuredContent as any
  if (result.isError) throw new Error(sc?.error?.message)
  if (sc?.jobId) adopt(sc, view?.bridge)                             // input_required: wait for "started"
}

async function track(h: any) {                                       // spec 6.7 step 4
  if (tracked.has(h.jobId)) return; tracked.add(h.jobId)
  for (;;) {
    const r = await client.callTool({ name: h.statusTool, arguments: { jobId: h.jobId, waitMs: 25000 } }, { timeout: 40000 })
    const s = r.structuredContent as any
    if (r.isError || ["failed", "cancelled"].includes(s.state)) return /* surface the error */
    if (s.state === "completed") return deliver(h)
  }
}

async function deliver(h: any) {                                     // spec 6.7 step 5, exactly once
  if (!h || delivered.has(h.jobId)) return; delivered.add(h.jobId)
  const { artifacts } = (await client.callTool({ name: h.resultTool, arguments: { jobId: h.jobId } })).structuredContent as any
  for (const a of artifacts) {
    const c = (await client.readResource({ uri: a.uri })).contents[0] as any
    const bytes = c.blob ? Uint8Array.from(atob(c.blob), (x) => x.charCodeAt(0)) : new TextEncoder().encode(c.text)
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("")
    if (bytes.length !== a.size || hex !== a.sha256) throw new Error(`verification failed for ${a.uri}`)
    // hand `bytes` (a.mimeType, a.role, a.name) to your product here
  }
  views.get(h.jobId)?.notification({ method: N.delivered, params: { jobId: h.jobId, artifacts: artifacts.map((a: any) => a.uri) } })
}
```

**Production hosts on the web** must use the MCP Apps double-iframe sandbox proxy on a separate
origin. The single sandboxed iframe above is only suitable for local or desktop hosts.

### 7.4 Implementation checklist

- [ ] Find the start and companion tools by `_meta["dev.micro-ui/jobs"]`; don't hard-code names.
- [ ] Declare `io.modelcontextprotocol/ui` only if you really render Views.
- [ ] Render the View with `sandbox="allow-scripts"` and proxy `tools/call` (respecting visibility) and `resources/read`.
- [ ] Advertise `hostCapabilities.experimental["dev.micro-ui/jobs"]` and handle `started`, `status` and `completed`.
- [ ] Track each job yourself with long-polls; never rely only on the View.
- [ ] Deliver once per `jobId`; verify `size` and `sha256`; strip paths from `name`.
- [ ] Send `delivered` to the View after delivery.
- [ ] Don't cancel on View teardown; cancel only on user intent, with the cancel tool.
- [ ] Handle `not_found` (TTL or backend restart), `failed` and `cancelled` gracefully.
- [ ] Allow client timeouts of at least `waitMs` + 15 s; expect jobs to take minutes.

---

## 8. Example trace

These messages were captured from a real run against YuE2 Studio. Envelopes are left out, and some
values are shortened with `…`.

1. **Discovery.** `tools/list` shows `generate_song` (role `start`) and `job_status`, `job_result`,
   `job_cancel`. The server capabilities include `"dev.micro-ui/jobs": {"version":"0.1.0"}`.
2. **Start.**
   ```
   → tools/call generate_song {"style":"lofi hip hop, dusty drums","instrumental":true,"max_seconds":20}
   ← structuredContent {"jobId":"song_cadc977584e14a9d","state":"working","pollIntervalMs":1000,"ttlMs":3600000,…}
   ```
3. **Render.** The Invoker reads `ui://yue2/song.html`, mounts it, answers `ui/initialize` with
   `hostCapabilities.experimental["dev.micro-ui/jobs"]`, then sends `ui/notifications/tool-input` and
   `ui/notifications/tool-result`.
4. **The View polls**, once per second through the host:
   ```
   View→Host→Server  tools/call job_status {"jobId":"song_cadc977584e14a9d"}
   ←                 {"state":"working","phase":"generating","progress":0.437,"message":"Generating song · 0:08 of music (max 0:20)",…}
   View→Host         micro-ui-jobs/notifications/status {…}
   ```
5. **The Invoker long-polls** on its own:
   ```
   → tools/call job_status {"jobId":"song_cadc977584e14a9d","waitMs":25000}   _meta.progressToken = 7
   ← notifications/progress {"progressToken":7,"progress":0.437,"total":1,"message":"Generating song · 0:08 …"}
   ← returns early when phase changes; the Invoker calls again
   ```
6. **Done.** The phases run planning → generating → synthesizing → loading-audio-decoder → decoding
   → saving → done. The View calls `job_result`, sends `micro-ui-jobs/notifications/completed`, and
   calls `ui/update-model-context` ("The requested job … finished. Primary artifact: yue2://tracks/…/audio.mp3 …").
7. **Delivery.** Whichever trigger arrives first: `job_result` → three artifacts → `resources/read`
   each → size and sha256 verified → handed to the app.
   ```
   Host→View  micro-ui-jobs/notifications/delivered {"jobId":"song_cadc977584e14a9d","artifacts":["yue2://…/audio.mp3","…flac","…abc"]}
   ```
   The View then shows "Delivered to <your host name>".

**Form variant.** `generate_song {}` → `{"state":"input_required","missing":["style","lyrics"],"draft":{…}}`.
The View shows a form; on submit it calls `generate_song` itself → `micro-ui-jobs/notifications/started {JobHandle}`.
The flow continues from step 4.

**Measured on the target machine (RTX 3060):**

| Song | Time to deliver | MP3 | FLAC |
|---|---|---|---|
| 20 s instrumental | ~35 s | 802,560 B | ~2.7 MB |
| 60 s instrumental | ~66 s | 2,401,920 B | ~8.9 MB |

---

## 9. Conformance checklist

Run these against YuE2 Studio, with the backend running and the model loaded (`GET /api/status` →
`"status":"ready"`):

| Scenario | Expected |
|---|---|
| `generate_song {"lyrics":"la"}` without the MCP Apps capability | `isError`, `invalid_input` ("Style description is required") |
| `generate_song {"style":"x","instrumental":true,"cot":"off"}` | `invalid_input` |
| `generate_song {}` with the MCP Apps capability | `input_required` with `missing:["style","lyrics"]` |
| `job_status {"jobId":"nope"}` | `not_found` |
| `job_result` while working | `not_ready`, `retryAfterMs: 1000` |
| `job_cancel` mid-generation, then poll | `cancelled`; `job_result` → `cancelled`; cancelling again → `cancelled` |
| Start while another song is generating | `working`, phase `queued`, message "Waiting for the current song to finish" |
| A completed 10–20 s instrumental | Three artifacts; each `resources/read` matches `size` and `sha256`; exactly one `primary` |
| Kill your client mid-job, reconnect within the TTL, poll the same `jobId` | The job continues and is retrievable |

The YuE2 repository's headless reference CLI runs the happy path end to end:

```
python specs/mcp-micro-ui-jobs/reference/invoker/invoker.py --url http://127.0.0.1:7862/mcp --args '{"style":"lofi piano","instrumental":true,"max_seconds":20}' --out out
```

---

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Connection refused | The backend isn't running. Ask the user to open YuE2 Studio, or use the stdio launcher. |
| HTTP 421 Misdirected Request | `Host` is not loopback. Connect to `127.0.0.1` or `localhost`. |
| HTTP 403 | The browser `Origin` is not loopback. Call through a loopback proxy. |
| Long wait in phase `loading` | Cold start. The model is loading (tens of seconds). This is normal. |
| Stuck in phase `queued` | Another song is generating (maybe from the studio window). It continues automatically. |
| `not_found` for a known id | The TTL (1 h after finishing) passed, or the backend restarted. The song itself is still in the user's library. |
| The View shows no progress | The host doesn't proxy `tools/call`, or blocks tools with app visibility. |
| The View's player keeps saying "Loading audio…" | The host doesn't proxy `resources/read`, or its CSP blocks `media-src data:`. |
| The View never sends `started` / `status` / `completed` | The host didn't put `experimental["dev.micro-ui/jobs"]` in its `ui/initialize` result. |
| sha256 mismatch | Most often a base64 decoding mistake; for `text` contents, hash the UTF-8 bytes. Retry once. |
| `failed: Ran out of GPU memory…` | Other GPU applications are using memory. Retry with a shorter `max_seconds`. |

---

## Appendix A: JSON Schema

Types for the `dev.micro-ui/jobs` profile (JSON Schema 2020-12). Unknown properties are allowed and
must be ignored.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:dev.micro-ui:jobs:0.1.0",
  "title": "MCP Micro-UI Jobs 0.1.0",
  "$defs": {
    "ExtensionSettings": {
      "type": "object", "required": ["version"],
      "properties": { "version": { "type": "string", "pattern": "^0\\.1\\.\\d+$" } }
    },
    "ToolMeta": {
      "type": "object", "required": ["role"],
      "properties": {
        "role": { "enum": ["start", "status", "result", "cancel"] },
        "statusTool": { "type": "string" }, "resultTool": { "type": "string" }, "cancelTool": { "type": "string" }
      },
      "if": { "properties": { "role": { "const": "start" } } },
      "then": { "required": ["statusTool", "resultTool", "cancelTool"] }
    },
    "State": { "enum": ["working", "input_required", "completed", "failed", "cancelled"] },
    "CompanionTools": {
      "type": "object", "required": ["statusTool", "resultTool", "cancelTool"],
      "properties": { "statusTool": { "type": "string" }, "resultTool": { "type": "string" }, "cancelTool": { "type": "string" } }
    },
    "JobHandle": {
      "allOf": [{ "$ref": "#/$defs/CompanionTools" }],
      "type": "object", "required": ["jobId", "state", "pollIntervalMs", "ttlMs"],
      "properties": {
        "jobId": { "type": "string", "minLength": 1 }, "state": { "const": "working" },
        "pollIntervalMs": { "type": "integer", "minimum": 100 }, "ttlMs": { "type": "integer", "minimum": 0 },
        "createdAt": { "type": "string", "format": "date-time" }
      }
    },
    "InputNeeded": {
      "allOf": [{ "$ref": "#/$defs/CompanionTools" }],
      "type": "object", "required": ["state", "missing"],
      "properties": {
        "state": { "const": "input_required" }, "missing": { "type": "array", "items": { "type": "string" } },
        "draft": { "type": "object" }, "pollIntervalMs": { "type": "integer" }, "ttlMs": { "type": "integer" }
      }
    },
    "Error": {
      "type": "object", "required": ["code", "message"],
      "properties": {
        "code": { "enum": ["invalid_input", "not_found", "not_ready", "busy", "unavailable", "failed", "cancelled"] },
        "message": { "type": "string" }, "retryAfterMs": { "type": "integer", "minimum": 0 }
      }
    },
    "ErrorResult": { "type": "object", "required": ["error"], "properties": { "error": { "$ref": "#/$defs/Error" } } },
    "JobStatus": {
      "type": "object",
      "required": ["jobId", "state", "phase", "progress", "message", "elapsedMs", "pollIntervalMs", "updatedAt"],
      "properties": {
        "jobId": { "type": "string" }, "state": { "$ref": "#/$defs/State" }, "phase": { "type": "string" },
        "progress": { "type": ["number", "null"], "minimum": 0, "maximum": 1 }, "message": { "type": "string" },
        "elapsedMs": { "type": "integer", "minimum": 0 }, "etaMs": { "type": "integer", "minimum": 0 },
        "pollIntervalMs": { "type": "integer", "minimum": 100 }, "updatedAt": { "type": "string", "format": "date-time" },
        "error": { "$ref": "#/$defs/Error" }, "data": { "type": "object" }
      }
    },
    "Artifact": {
      "type": "object", "required": ["uri", "name", "mimeType", "size", "sha256", "role"],
      "properties": {
        "uri": { "type": "string" }, "name": { "type": "string" }, "mimeType": { "type": "string" },
        "size": { "type": "integer", "minimum": 0 }, "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "role": { "enum": ["primary", "alternate", "auxiliary"] }, "durationMs": { "type": "integer", "minimum": 0 },
        "url": { "type": "string", "format": "uri" }
      }
    },
    "JobResult": {
      "type": "object", "required": ["jobId", "state", "artifacts"],
      "properties": {
        "jobId": { "type": "string" }, "state": { "const": "completed" },
        "artifacts": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/Artifact" },
                       "contains": { "properties": { "role": { "const": "primary" } } }, "maxContains": 1 },
        "data": { "type": "object" }
      }
    },
    "StatusInput": { "type": "object", "required": ["jobId"],
      "properties": { "jobId": { "type": "string" }, "waitMs": { "type": "integer", "minimum": 0, "maximum": 30000 } } },
    "ResultInput": { "type": "object", "required": ["jobId"],
      "properties": { "jobId": { "type": "string" }, "inline": { "type": "boolean" } } },
    "CancelInput": { "type": "object", "required": ["jobId"], "properties": { "jobId": { "type": "string" } } },
    "StartedNotification": { "type": "object", "required": ["method", "params"],
      "properties": { "method": { "const": "micro-ui-jobs/notifications/started" }, "params": { "$ref": "#/$defs/JobHandle" } } },
    "StatusNotification": { "type": "object", "required": ["method", "params"],
      "properties": { "method": { "const": "micro-ui-jobs/notifications/status" }, "params": { "$ref": "#/$defs/JobStatus" } } },
    "CompletedNotification": { "type": "object", "required": ["method", "params"],
      "properties": {
        "method": { "const": "micro-ui-jobs/notifications/completed" },
        "params": { "type": "object", "required": ["jobId", "state"],
          "properties": { "jobId": { "type": "string" }, "state": { "enum": ["completed", "failed", "cancelled"] },
                          "result": { "$ref": "#/$defs/JobResult" }, "error": { "$ref": "#/$defs/Error" } } } } },
    "DeliveredNotification": { "type": "object", "required": ["method", "params"],
      "properties": {
        "method": { "const": "micro-ui-jobs/notifications/delivered" },
        "params": { "type": "object", "required": ["jobId"],
          "properties": { "jobId": { "type": "string" }, "artifacts": { "type": "array", "items": { "type": "string" } } } } } }
  }
}
```

---

## Appendix B: why a profile on top of MCP Apps

As of October 2026, no single standard covered this flow:

| Need | What exists | Gap this profile fills |
|---|---|---|
| Embedded UI from a tool | **MCP Apps** (SEP-1865, stable 2026-01-26): `ui://` resources, a sandboxed iframe, postMessage JSON-RPC | Nothing on long-running jobs: `tool-result` arrives only when the tool returns |
| Long-running jobs | **MCP Tasks** extension (SEP-2663, 2026-07-28): durable handles, `tasks/get` | No numeric progress, no link to a View, no artifact descriptor; few hosts support it yet |
| Progress | Core `notifications/progress` | Only while a request is open, and hosts aren't required to forward it to a View |
| Binary payload | `resource_link`, `audio` content, `resources/read` | No integrity hash, no roles, no rule for who delivers to the app, and no exactly-once guarantee |

MCP Micro-UI Jobs adds the missing pieces:

- a start tool that returns a handle immediately;
- companion status, result and cancel tools, discoverable through `_meta`;
- a JobStatus with numeric progress;
- artifact descriptors with sha256;
- four View↔host notifications;
- a clear rule: **the Invoker tracks and delivers, exactly once; the View only presents.**

It degrades gracefully on hosts that know only MCP Apps, or only plain MCP tools.
