import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2Icon, SquareIcon } from "lucide-react"
import { toast } from "sonner"

import { DEFAULT_PARAMS, GenerateForm } from "@/components/generate-form"
import { jobPercent } from "@/components/job-progress"
import { Library, RecentSongs } from "@/components/library"
import { SparkIcon } from "@/components/logo"
import { Player } from "@/components/player"
import { Sidebar, StatusBar, TitleBar, type View } from "@/components/shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useBackend } from "@/hooks/use-backend"
import { api, effectiveKey, formatTime, newSectionId, type GenerateParams, type Track } from "@/lib/api"
import { cn } from "@/lib/utils"

const FORM_KEY = "yue2-form"

function loadForm(): GenerateParams {
  try {
    const saved = JSON.parse(localStorage.getItem(FORM_KEY) ?? "{}")
    if (saved.timeline && "key" in saved.timeline) {
      saved.key ??= saved.timeline.key // older forms kept the key on the timeline
      delete saved.timeline.key
    }
    return { ...DEFAULT_PARAMS, ...saved }
  } catch {
    return DEFAULT_PARAMS
  }
}

export default function App() {
  const { snapshot, connected } = useBackend()
  const [params, setParams] = useState<GenerateParams>(loadForm)
  const [tracks, setTracks] = useState<Track[]>([])
  const [current, setCurrent] = useState<Track | null>(null)
  const [autoPlay, setAutoPlay] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [view, setView] = useState<View>("generate")
  const audio = useRef<HTMLAudioElement>(null)
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
  const generating = running && !transcribing
  const ready = connected && snapshot?.status === "ready"
  const canGenerate = ready && !submitting && !running

  const generate = async () => {
    if (!canGenerate) return
    if (!params.style.trim()) {
      toast.error("Add a style description first")
      return
    }
    setSubmitting(true)
    try {
      await api.generate({ ...params, abc: params.abc.trim(), key: effectiveKey(params) })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const percent = job && generating ? jobPercent(job) : null
  const trackActions = {
    currentId: current?.id ?? null,
    playing,
    onSelect: (t: Track) => {
      const el = audio.current
      if (t.id === current?.id && el) {
        if (el.paused) el.play().catch(() => {})
        else el.pause()
        return
      }
      setAutoPlay(true)
      setCurrent(t)
    },
    onUseSettings: (t: Track) => {
      setParams({
        ...DEFAULT_PARAMS,
        ...t.params,
        instrumental: t.params.instrumental ?? !t.params.lyrics.trim(),
        abc: t.params.abc ?? "",
        key: t.params.key ?? t.params.timeline?.key ?? null,
        timeline: t.params.timeline
          ? {
              bpm: t.params.timeline.bpm,
              meter: t.params.timeline.meter,
              strict: t.params.timeline.strict,
              sections: t.params.timeline.sections.map((s) => ({ ...s, id: newSectionId() })),
            }
          : params.timeline,
      })
      setView("generate")
      toast("Settings loaded into the form")
    },
    onDelete: async (t: Track) => {
      try {
        await api.deleteTrack(t.id)
        if (current?.id === t.id) setCurrent(null)
        refresh()
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden select-none">
      <TitleBar snapshot={snapshot} connected={connected} />
      <div className="flex min-h-0 flex-1 gap-2.5 p-2.5">
        <Sidebar view={view} onChange={setView} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
          {!connected && snapshot && (
            <Alert variant="destructive" className="panel shrink-0">
              <AlertTitle>Backend is not running</AlertTitle>
              <AlertDescription>Start YuE2 Studio from the Start menu. This page reconnects automatically.</AlertDescription>
            </Alert>
          )}
          {connected && snapshot && snapshot.status !== "ready" && (
            <Alert variant={snapshot.status === "error" ? "destructive" : "default"} className="panel shrink-0">
              {snapshot.status !== "error" && <Loader2Icon className="animate-spin" />}
              <AlertTitle>{snapshot.status === "error" ? "Model failed to load" : snapshot.detail || "Starting"}</AlertTitle>
              <AlertDescription>
                {snapshot.status === "error" ? snapshot.detail : "You can fill in the form meanwhile."}
              </AlertDescription>
            </Alert>
          )}

          <Player track={current} autoPlay={autoPlay} job={generating ? job : null} audio={audio} onPlayingChange={setPlaying} />

          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
            {/* Generate stays mounted so the form's open sections and selection survive tab switches. */}
            <div className={cn("flex flex-col gap-2.5", view !== "generate" && "hidden")}>
              <GenerateForm
                params={params}
                onChange={setParams}
                job={job}
                audioImport={snapshot?.audio_import ?? false}
                onGenerate={generate}
                action={
                  <Button
                    className="h-[74px] w-full text-[19px] font-medium tracking-[0.06em]"
                    disabled={generating ? false : !ready || submitting || transcribing}
                    onClick={generating ? () => api.cancel() : generate}
                    title={generating ? "Cancel" : !ready ? "Wait for the model to load" : "Generate (Ctrl+Enter)"}
                  >
                    {generating ? <SquareIcon className="size-6 fill-current" /> : submitting ? <Loader2Icon className="size-7 animate-spin" /> : <SparkIcon className="size-7" />}
                    {generating ? (
                      <span className="flex flex-col items-center leading-tight">
                        {percent === null ? "WORKING" : `${Math.round(percent)}%`}
                        <span className="text-[10px] font-medium tracking-normal opacity-80">click to cancel</span>
                      </span>
                    ) : (
                      "GENERATE"
                    )}
                  </Button>
                }
              />
              <RecentSongs {...trackActions} tracks={tracks} generating={generating} />
            </div>
            {view === "library" && <Library {...trackActions} tracks={tracks} />}
          </div>
        </main>
      </div>
      <StatusBar snapshot={snapshot} connected={connected} current={current} />
    </div>
  )
}
