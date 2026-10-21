import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2Icon, SparklesIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"

import { DEFAULT_PARAMS, GenerateForm } from "@/components/generate-form"
import { Library } from "@/components/library"
import { Player } from "@/components/player"
import { ThemeToggle } from "@/components/theme-toggle"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { JobProgress } from "@/components/job-progress"
import { useBackend } from "@/hooks/use-backend"
import { api, formatTime, newSectionId, type GenerateParams, type Snapshot, type Track } from "@/lib/api"

const FORM_KEY = "yue2-form"

function loadForm(): GenerateParams {
  try {
    return { ...DEFAULT_PARAMS, ...JSON.parse(localStorage.getItem(FORM_KEY) ?? "{}") }
  } catch {
    return DEFAULT_PARAMS
  }
}

function StatusBadge({ snapshot, connected }: { snapshot: Snapshot | null; connected: boolean }) {
  if (!connected) return <Badge variant="destructive">Offline</Badge>
  if (!snapshot) return <Badge variant="secondary">Connecting</Badge>
  if (snapshot.job?.state === "running") return <Badge>{snapshot.job.kind === "transcribe" ? "Transcribing" : "Generating"}</Badge>
  const labels = { starting: "Starting", downloading: "Downloading model", loading: "Loading model", ready: "Ready", error: "Error" }
  return <Badge variant={snapshot.status === "error" ? "destructive" : snapshot.status === "ready" ? "outline" : "secondary"}>{labels[snapshot.status]}</Badge>
}

export default function App() {
  const { snapshot, connected } = useBackend()
  const [params, setParams] = useState<GenerateParams>(loadForm)
  const [tracks, setTracks] = useState<Track[]>([])
  const [current, setCurrent] = useState<Track | null>(null)
  const [autoPlay, setAutoPlay] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const seenJob = useRef<string | null>(null)

  useEffect(() => {
    localStorage.setItem(FORM_KEY, JSON.stringify(params))
  }, [params])

  const refresh = useCallback(async () => {
    try {
      const list = await api.tracks()
      setTracks(list)
      return list
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    if (!connected) return
    refresh().then((list) => setCurrent((c) => c ?? list[0] ?? null))
  }, [connected, refresh])

  // React to a job finishing exactly once.
  const job = snapshot?.job ?? null
  useEffect(() => {
    if (!job || ["queued", "running"].includes(job.state)) return
    const key = `${job.id}:${job.state}`
    if (seenJob.current === key) return
    const firstSight = seenJob.current === null
    seenJob.current = key
    if (firstSight) return // finished before this page loaded
    if (job.kind === "transcribe") {
      const t = job.result
      if (job.state === "done" && t) {
        // A cover: the transcribed melody with planning set to melody-only, as upstream recommends,
        // so YuE2 writes a new accompaniment. The length is the recording's (a cap with lyrics).
        const seconds = Math.min(360, Math.max(10, Math.ceil(t.duration / 5) * 5))
        setParams((p) => ({ ...p, abc: t.abc, cot: "melody", max_seconds: p.instrumental ? seconds : Math.max(p.max_seconds, seconds) }))
        toast.success(`Melody of ${t.name} imported (${formatTime(t.duration)})`, {
          description:
            (t.truncated ? "Only the first 6:00 was transcribed. " : "") +
            "Planning is now Melody only. Add a style (and lyrics that follow the melody's sections), then Generate.",
        })
      } else if (job.state === "error") {
        toast.error(job.error ?? "Import from audio failed")
      } else if (job.state === "cancelled") {
        toast("Import from audio cancelled")
      }
      return
    }
    if (job.source === "mcp") {
      // Requested by another app over MCP: that app decides whether and when to play it.
      if (job.state === "done" && job.track) {
        refresh()
        toast(`Song for another app added to the library (${formatTime(job.track.duration)})`)
      }
    } else if (job.state === "done" && job.track) {
      refresh()
      setAutoPlay(true)
      setCurrent(job.track)
      toast.success(`Song ready (${formatTime(job.track.duration)})`)
    } else if (job.state === "error") {
      toast.error(job.error ?? "Generation failed")
    } else if (job.state === "cancelled") {
      toast("Generation cancelled")
    }
  }, [job, refresh])
  useEffect(() => {
    if (job && ["queued", "running"].includes(job.state)) seenJob.current = `${job.id}:running`
  }, [job])

  const running = job?.state === "running" || job?.state === "queued"
  const transcribing = running && job?.kind === "transcribe" // shown and cancelled by the score field
  const ready = connected && snapshot?.status === "ready"

  const generate = async () => {
    if (!params.style.trim()) {
      toast.error("Add a style description first")
      return
    }
    setSubmitting(true)
    try {
      await api.generate({ ...params, abc: params.abc.trim() })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const gpu = snapshot?.gpu

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <img src="/favicon.svg" alt="" className="size-7" />
          <h1 className="font-semibold tracking-tight">YuE2 Studio</h1>
          <StatusBadge snapshot={snapshot} connected={connected} />
          <div className="ml-auto flex items-center gap-3">
            {gpu && (
              <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline" title={gpu.last_peak_gib ? `Last song peaked at ${gpu.last_peak_gib} GB reserved by PyTorch` : undefined}>
                {gpu.name.replace("NVIDIA GeForce ", "")} · {gpu.used_gib.toFixed(1)} / {gpu.total_gib.toFixed(1)} GB
              </span>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {!connected && snapshot && (
          <Alert variant="destructive" className="lg:col-span-2">
            <AlertTitle>Backend is not running</AlertTitle>
            <AlertDescription>Start YuE2 Studio from the Start menu. This page reconnects automatically.</AlertDescription>
          </Alert>
        )}
        {connected && snapshot && snapshot.status !== "ready" && (
          <Alert variant={snapshot.status === "error" ? "destructive" : "default"} className="lg:col-span-2">
            {snapshot.status !== "error" && <Loader2Icon className="animate-spin" />}
            <AlertTitle>{snapshot.status === "error" ? "Model failed to load" : snapshot.detail || "Starting"}</AlertTitle>
            <AlertDescription>
              {snapshot.status === "error" ? snapshot.detail : "You can fill in the form meanwhile."}
            </AlertDescription>
          </Alert>
        )}

        <Card className="self-start">
          <CardHeader>
            <CardTitle>New song</CardTitle>
          </CardHeader>
          <CardContent>
            <GenerateForm params={params} onChange={setParams} job={job} audioImport={snapshot?.audio_import ?? false} />
          </CardContent>
          <CardFooter className="justify-end gap-2">
            {running && !transcribing ? (
              <Button variant="outline" size="lg" onClick={() => api.cancel()}>
                <SquareIcon /> Cancel
              </Button>
            ) : (
              <Button size="lg" disabled={!ready || submitting || transcribing} onClick={generate}>
                {submitting ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />} Generate
              </Button>
            )}
          </CardFooter>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="truncate" title={current?.params.style}>
                {current ? current.params.style : "Player"}
              </CardTitle>
              {current && (
                <p className="text-xs text-muted-foreground">
                  {current.params.instrumental ? "Instrumental" : "Vocal"} · seed {current.params.seed} · {current.params.cot} planning · generated in {formatTime(current.seconds_taken)}
                  {current.truncated && !current.params.instrumental && " · stopped at max length"}
                </p>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {running && !transcribing && job && <JobProgress job={job} />}
              <Player track={current} autoPlay={autoPlay} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Library</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[28rem] overflow-y-auto">
              <Library
                tracks={tracks}
                currentId={current?.id ?? null}
                onSelect={(t) => {
                  setAutoPlay(true)
                  setCurrent(t)
                }}
                onUseSettings={(t) => {
                  setParams({
                    ...DEFAULT_PARAMS,
                    ...t.params,
                    instrumental: t.params.instrumental ?? !t.params.lyrics.trim(),
                    abc: t.params.abc ?? "",
                    timeline: t.params.timeline
                      ? { ...t.params.timeline, sections: t.params.timeline.sections.map((s) => ({ ...s, id: newSectionId() })) }
                      : params.timeline,
                  })
                  toast("Settings loaded into the form")
                }}
                onDelete={async (t) => {
                  try {
                    await api.deleteTrack(t.id)
                    if (current?.id === t.id) setCurrent(null)
                    refresh()
                  } catch (e) {
                    toast.error((e as Error).message)
                  }
                }}
              />
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
