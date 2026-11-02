import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { useApp, type App } from "@modelcontextprotocol/ext-apps/react"
import { CheckIcon, ExternalLinkIcon, Loader2Icon, MusicIcon, SparklesIcon, SquareIcon } from "lucide-react"

import { JobProgress } from "@/components/job-progress"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { formatLength, formatTime, KEY_HINT, MAJOR_KEYS, MINOR_KEYS, type Job, type Track } from "@/lib/api"
import type { Artifact, InputNeeded } from "./profile"
import { useJob } from "./use-job"

const START_TOOL = "generate_song"

interface SongStatusData {
  job?: Job
  request?: { style: string; instrumental: boolean; max_seconds: number }
}
interface SongResultData {
  track: Track
  studioUrl: string
}
type ToolResult = Awaited<ReturnType<App["callServerTool"]>>

/** Reads an artifact through the host (resources/read) into a data: URL the sandbox's CSP allows. */
function useArtifactSrc(app: App | null, artifact: Artifact | undefined) {
  const [src, setSrc] = useState<string | null>(null)
  const uri = artifact?.uri
  const mimeType = artifact?.mimeType
  useEffect(() => {
    if (!app || !uri) return
    let live = true
    app
      .readServerResource({ uri })
      .then((r) => {
        const content = r.contents[0]
        if (live && content && "blob" in content) setSrc(`data:${mimeType};base64,${content.blob}`)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [app, uri, mimeType])
  return src
}

function QuickForm({ input, onSubmit }: { input: InputNeeded; onSubmit: (args: Record<string, unknown>) => void }) {
  const draft = input.draft ?? {}
  const [style, setStyle] = useState(String(draft.style ?? ""))
  const [lyrics, setLyrics] = useState(String(draft.lyrics ?? ""))
  const [instrumental, setInstrumental] = useState(Boolean(draft.instrumental))
  const [seconds, setSeconds] = useState(Number(draft.max_seconds ?? 120))
  const draftTimeline = draft.timeline && typeof draft.timeline === "object" ? (draft.timeline as Record<string, unknown>) : null
  const [key, setKey] = useState(String(draft.key ?? draftTimeline?.key ?? ""))
  const [busy, setBusy] = useState(false)
  const ready = style.trim() && (instrumental || lyrics.trim())

  const submit = () => {
    if (!ready || busy) return
    setBusy(true)
    onSubmit({
      ...draft,
      style,
      lyrics: instrumental ? "" : lyrics,
      instrumental,
      max_seconds: seconds,
      key: key || null,
      // The key picked here replaces a draft timeline's own key, so the two can't disagree.
      ...(draftTimeline && { timeline: { ...draftTimeline, key: undefined } }),
    })
  }

  // Not a <form>: hosts may sandbox the View without allow-forms, which silently blocks submit events.
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="style">Style</Label>
        <Input id="style" value={style} onChange={(e) => setStyle(e.target.value)} onKeyDown={(e: KeyboardEvent) => e.key === "Enter" && submit()} placeholder="dreamy synth-pop, airy female vocals, 100 bpm" autoFocus />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="instrumental">Instrumental</Label>
        <Switch id="instrumental" checked={instrumental} onCheckedChange={setInstrumental} />
      </div>
      {!instrumental && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lyrics">Lyrics</Label>
          <Textarea id="lyrics" value={lyrics} onChange={(e) => setLyrics(e.target.value)} rows={5} placeholder={"[verse]\n...\n[chorus]\n..."} className="font-mono text-xs" />
        </div>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex justify-between text-sm">
          <Label>{instrumental ? "Length" : "Max length"}</Label>
          <span className="tabular-nums text-muted-foreground">{formatTime(seconds)}</span>
        </div>
        <Slider min={10} max={360} step={10} value={[seconds]} onValueChange={([v]) => setSeconds(v)} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="key">Key</Label>
        {/* Native select: its list opens outside the host's iframe instead of being clipped by it. */}
        <select
          id="key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          title={KEY_HINT}
          className="panel-inset h-9 w-28 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_optgroup]:bg-background"
        >
          <option value="">Auto</option>
          <optgroup label="Major">
            {MAJOR_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </optgroup>
          <optgroup label="Minor">
            {MINOR_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <Button type="button" disabled={!ready || busy} onClick={submit}>
        {busy ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />} Generate
      </Button>
    </div>
  )
}

export function MicroApp() {
  const [incoming, setIncoming] = useState<ToolResult | null>(null)
  const [args, setArgs] = useState<Record<string, unknown> | null>(null)
  const { app, isConnected, error } = useApp({
    appInfo: { name: "yue2-song", version: "1.0.0" },
    capabilities: {},
    autoResize: true, // report our height so the host sizes the iframe to fit
    onAppCreated: (created) => {
      created.ontoolinput = (params) => setArgs(params.arguments ?? {})
      created.ontoolresult = (params) => setIncoming(params as ToolResult)
    },
  })
  const connected = isConnected ? app : null
  const { view, accept, start, cancel, delivered } = useJob<SongStatusData, SongResultData>(connected, START_TOOL)

  const accepted = useRef<ToolResult | null>(null)
  useEffect(() => {
    if (!incoming || incoming === accepted.current) return
    accepted.current = incoming
    accept(incoming)
  }, [incoming, accept])

  const result = view.kind === "finished" ? view.result : null
  const primary = result?.artifacts.find((a) => a.role === "primary")
  const src = useArtifactSrc(connected, primary)
  const track = result?.data?.track
  const status = view.kind === "tracking" || view.kind === "finished" ? view.status : null
  const request = status?.data?.request
  const style = track?.params.style ?? request?.style ?? (typeof args?.style === "string" ? args.style : "")

  let badge = <Badge variant="secondary">Starting</Badge>
  if (error || view.kind === "error") badge = <Badge variant="destructive">Error</Badge>
  else if (view.kind === "form") badge = <Badge variant="outline">New song</Badge>
  else if (view.kind === "tracking") badge = <Badge>{status?.phase === "queued" || status?.phase === "loading" ? "Waiting" : "Generating"}</Badge>
  else if (view.kind === "finished") {
    const s = view.status.state
    badge = <Badge variant={s === "completed" ? "outline" : s === "failed" ? "destructive" : "secondary"}>{s === "completed" ? "Ready" : s === "failed" ? "Failed" : "Cancelled"}</Badge>
  }

  return (
    <div className="panel flex flex-col gap-3 p-4 text-foreground">
      <header className="flex min-w-0 items-center gap-2">
        <MusicIcon className="size-4 shrink-0 text-primary" />
        <span className="truncate text-sm font-medium" title={style}>{style || "YuE2 song"}</span>
        <span className="ml-auto shrink-0">{badge}</span>
      </header>

      {(error || view.kind === "error") && (
        <p className="text-sm text-destructive">{error?.message ?? (view.kind === "error" ? view.message : "")}</p>
      )}

      {!error && view.kind === "waiting" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" /> Starting…
        </p>
      )}

      {view.kind === "form" && <QuickForm input={view.input} onSubmit={start} />}

      {view.kind === "tracking" && (
        <>
          {request && (
            <p className="text-xs text-muted-foreground">
              {request.instrumental ? "Instrumental" : "Vocal"} · up to {formatTime(request.max_seconds)}
            </p>
          )}
          {status?.data?.job ? (
            <JobProgress job={status.data.job} />
          ) : (
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-2 text-sm">
                <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
                {status?.message ?? "Queued"}
              </span>
              <Progress value={0} className="animate-pulse" />
            </div>
          )}
          <Button variant="outline" size="sm" className="self-end" onClick={cancel}>
            <SquareIcon /> Cancel
          </Button>
        </>
      )}

      {view.kind === "finished" && view.status.state !== "completed" && (
        <p className="text-sm text-muted-foreground">{view.status.message}</p>
      )}

      {view.kind === "finished" && view.status.state === "completed" && (
        <>
          {src ? (
            <audio controls src={src} className="w-full" />
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" /> Loading audio…
            </p>
          )}
          {track && (
            <p className="text-xs text-muted-foreground">
              {formatLength(track.duration)} · {track.params.instrumental ? "Instrumental" : "Vocal"} · seed {track.params.seed} · generated in {formatTime(track.seconds_taken)}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            {delivered ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckIcon className="size-3.5" /> Delivered to {connected?.getHostVersion()?.name ?? "the app"}
              </span>
            ) : (
              <span />
            )}
            {result?.data?.studioUrl && (
              <Button variant="ghost" size="sm" onClick={() => connected?.openLink({ url: result.data!.studioUrl })}>
                <ExternalLinkIcon /> Open in YuE2 Studio
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
