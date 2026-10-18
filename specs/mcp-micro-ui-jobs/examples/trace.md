# Example trace

This is one complete run against YuE2 Studio, the first server to implement the profile. The Invoker is
`reference/host`, an MCP Apps host. JSON-RPC envelopes are left out, and some long values are shortened
with `…`.

## 1. Discovery

`tools/list` (abridged):

```json
{ "name": "generate_song",
  "_meta": { "ui": { "resourceUri": "ui://yue2/song.html" },
             "dev.micro-ui/jobs": { "role": "start", "statusTool": "job_status", "resultTool": "job_result", "cancelTool": "job_cancel" } } }
{ "name": "job_status", "_meta": { "dev.micro-ui/jobs": { "role": "status" } } }
{ "name": "job_result", "_meta": { "dev.micro-ui/jobs": { "role": "result" } } }
{ "name": "job_cancel", "_meta": { "dev.micro-ui/jobs": { "role": "cancel" } } }
```

Server capabilities include `"extensions": { "io.modelcontextprotocol/ui": {}, "dev.micro-ui/jobs": { "version": "0.1.0" } }`.

## 2. Start (Invoker → Server)

```json
→ tools/call { "name": "generate_song", "arguments": { "style": "lofi hip hop, dusty drums", "instrumental": true, "max_seconds": 20 } }
← { "content": [{ "type": "text", "text": "Started generating an instrumental … Job id: song_cadc977584e14a9d. …" }],
    "structuredContent": { "jobId": "song_cadc977584e14a9d", "state": "working", "pollIntervalMs": 1000, "ttlMs": 3600000,
                           "createdAt": "2026-10-18T17:09:13.402Z",
                           "statusTool": "job_status", "resultTool": "job_result", "cancelTool": "job_cancel" } }
```

The Invoker reads `ui://yue2/song.html` (`text/html;profile=mcp-app`) and renders it in a sandboxed iframe.
In `ui/initialize` it answers `hostCapabilities.experimental["dev.micro-ui/jobs"] = {"version": "0.1.0"}`,
then sends `ui/notifications/tool-input` and `ui/notifications/tool-result` carrying the result above.

## 3. Two independent trackers

**The View** polls once per `pollIntervalMs`, with each call proxied through the host:

```json
View → Host → Server   tools/call { "name": "job_status", "arguments": { "jobId": "song_cadc977584e14a9d" } }
← { "jobId": "song_cadc977584e14a9d", "state": "working", "phase": "generating", "progress": 0.437,
    "message": "Generating song · 0:08 of music (max 0:20)", "elapsedMs": 17012, "pollIntervalMs": 1000,
    "updatedAt": "2026-10-18T17:09:30.415Z", "data": { "job": { … }, "request": { … } } }
View → Host   micro-ui-jobs/notifications/status { …same JobStatus… }
```

**The Invoker** long-polls on its own (spec 7.4) and receives `notifications/progress` while each call is held:

```json
→ tools/call { "name": "job_status", "arguments": { "jobId": "song_cadc977584e14a9d", "waitMs": 25000 }, "_meta": { "progressToken": 7 } }
← notifications/progress { "progressToken": 7, "progress": 0.437, "total": 1, "message": "Generating song · 0:08 of music (max 0:20)" }
← (returns early when `phase` changes to "synthesizing")
```

## 4. Completion and delivery

When the job reaches a terminal state, the View fetches the result, then sends `completed` and updates the
model context:

```json
View → Host   micro-ui-jobs/notifications/completed { "jobId": "song_cadc977584e14a9d", "state": "completed", "result": { … } }
View → Host   ui/update-model-context { "content": [{ "type": "text", "text": "The requested job … finished. Primary artifact: yue2://tracks/20261018-130941-279665/audio.mp3 …" }] }
```

Delivery is triggered by whichever arrives first: the View's `completed` or the Invoker's own long-poll.
The `jobId` guard makes sure it happens only once:

```json
→ tools/call { "name": "job_result", "arguments": { "jobId": "song_cadc977584e14a9d" } }
← { "content": [ { "type": "text", "text": "Song ready: … (0:20, seed 1945998502). Audio: yue2://tracks/…/audio.mp3" },
                 { "type": "resource_link", "uri": "yue2://tracks/20261018-130941-279665/audio.mp3", "name": "20261018-130941-279665.mp3", "mimeType": "audio/mpeg", "size": 802560 },
                 … ],
    "structuredContent": { "jobId": "song_cadc977584e14a9d", "state": "completed", "artifacts": [
      { "uri": "yue2://tracks/20261018-130941-279665/audio.mp3",  "name": "20261018-130941-279665.mp3",  "mimeType": "audio/mpeg", "size": 802560,  "sha256": "9cbd7c5e289dbbba…", "role": "primary",   "durationMs": 20000, "url": "http://127.0.0.1:7862/api/tracks/20261018-130941-279665/audio.mp3" },
      { "uri": "yue2://tracks/20261018-130941-279665/audio.flac", "name": "20261018-130941-279665.flac", "mimeType": "audio/flac", "size": 2767788, "sha256": "bee8908a59b6b577…", "role": "alternate", "durationMs": 20000, "url": "…" },
      { "uri": "yue2://tracks/20261018-130941-279665/score.abc",  "name": "20261018-130941-279665.abc",  "mimeType": "text/plain", "size": 388,     "sha256": "6fe58eec198fb105…", "role": "auxiliary", "url": "…" } ],
    "data": { "track": { … }, "studioUrl": "http://127.0.0.1:7862" } } }

→ resources/read { "uri": "yue2://tracks/20261018-130941-279665/audio.mp3" }
← { "contents": [{ "uri": "…", "mimeType": "audio/mpeg", "blob": "SUQzBAAAAAAA…" }] }   // Invoker checks size + sha256, then hands the bytes to the app

Host → View   micro-ui-jobs/notifications/delivered { "jobId": "song_cadc977584e14a9d", "artifacts": [ "yue2://…/audio.mp3", "yue2://…/audio.flac", "yue2://…/score.abc" ] }
```

The View then shows "Delivered to <host name>".

## Variant: input collected by the View

```json
→ tools/call { "name": "generate_song", "arguments": {} }
← { "structuredContent": { "state": "input_required", "missing": ["style", "lyrics"], "draft": { "instrumental": false, "max_seconds": 180, "cot": "full" },
                           "statusTool": "job_status", "resultTool": "job_result", "cancelTool": "job_cancel", "pollIntervalMs": 1000, "ttlMs": 3600000 } }
```

The View renders a form. When the user submits it, the View calls `generate_song` itself, receives a
JobHandle and sends `micro-ui-jobs/notifications/started {JobHandle}`. From there the Invoker continues
as in section 3.

## Variant: headless Invoker

```
$ python reference/invoker/invoker.py --url http://127.0.0.1:7862/mcp --args '{"style":"lofi piano","instrumental":true,"max_seconds":20}' --out out
started song_bbbf6478df474301 via generate_song
[working/planning]   0.0%  Planning score · 0 / 20 s
[working/generating]  15.0%  Generating song · 0:00 of music (max 0:20)
…
[completed/done] 100.0%  Done
delivered primary   out/20261018-130544-8692e8.mp3   audio/mpeg  802,560 bytes  sha256 ok
delivered alternate out/20261018-130544-8692e8.flac  audio/flac  2,711,534 bytes  sha256 ok
delivered auxiliary out/20261018-130544-8692e8.abc   text/plain  368 bytes  sha256 ok
```
