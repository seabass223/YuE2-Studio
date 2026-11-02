import { useRef, useState } from "react"
import { ChevronDownIcon, FileAudioIcon, Loader2Icon, LockIcon, ShuffleIcon } from "lucide-react"
import { toast } from "sonner"

import { JobProgress } from "@/components/job-progress"
import { FIELD, FIELD_TRIGGER, ParamKnob } from "@/components/param-knob"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { KeySelect } from "@/components/key-select"
import { DEFAULT_TIMELINE, TimelineEditor } from "@/components/timeline-editor"
import { api, formatTime, KEY_HINT, type Cot, type GenerateParams, type Job } from "@/lib/api"
import { cn } from "@/lib/utils"

export const DEFAULT_PARAMS: GenerateParams = {
  style: "",
  lyrics: "",
  instrumental: true,
  timeline: DEFAULT_TIMELINE,
  key: null,
  cot: "full",
  seed: null,
  max_seconds: 180,
  cfg_scale: null,
  temperature: 1.0,
  top_p: 0.95,
  top_k: 100,
  repetition_penalty: 1.2,
  ode_steps: 32,
  abc: "",
  vocal_check: true,
}

const LYRICS_PLACEHOLDER = `[Intro]

[Verse]
First verse lines...

[Chorus]
Chorus lines...

[Outro]`

const MAX_SEED = 2 ** 31 - 1
const PARAM_ROW = "grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-center gap-5 param-tight:gap-3"

export function GenerateForm({
  params,
  onChange,
  job,
  audioImport,
  onGenerate,
  action,
}: {
  params: GenerateParams
  onChange: (p: GenerateParams) => void
  /** The backend's current job: a running transcription shows its progress by the score. */
  job: Job | null
  /** SheetSage2 is installed. */
  audioImport: boolean
  onGenerate: () => void
  /** The Generate button, next to the style. */
  action: React.ReactNode
}) {
  const [advanced, setAdvanced] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const set = <K extends keyof GenerateParams>(key: K, value: GenerateParams[K]) => onChange({ ...params, [key]: value })
  // The timeline always plans with chords: they keep YuE2's audio on the beat grid (melody-only drifts).
  const timelineActive = params.instrumental && !params.abc.trim()
  const keyBlocked = params.abc.trim()
    ? "The score from Advanced sets its own key (its K: line)."
    : params.cot === "off"
      ? "The key is set on the planned score, and planning is off."
      : null
  const busy = job?.state === "queued" || job?.state === "running"
  const transcribing = busy && job?.kind === "transcribe"

  // App fills in the score when the job finishes.
  const importAudio = async (file: File) => {
    setUploading(true)
    try {
      await api.transcribe(file)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const setInstrumental = (on: boolean) => onChange({ ...params, instrumental: on, cot: on && params.cot === "off" ? "full" : params.cot })

  return (
    <div className="@container/prompt-panel panel flex shrink-0 flex-col gap-3 px-5 pt-3 pb-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div role="radiogroup" aria-label="Song type" className="key key-well flex gap-1 p-0.5">
          {(
            [
              [true, "Instrumental", "No vocals. Lay out the song's sections below."],
              [false, "Vocal", "Sung lyrics. Section tags like [Verse], [Chorus] shape the song."],
            ] as const
          ).map(([on, label, hint]) => (
            <button
              key={label}
              role="radio"
              aria-checked={params.instrumental === on}
              title={hint}
              onClick={() => setInstrumental(on)}
              className={cn("h-7 rounded-md px-3 text-xs font-medium", params.instrumental === on ? "key key-on" : "hover:bg-white/5")}
            >
              {label}
            </button>
          ))}
        </div>
        {params.instrumental && (
          <div className="flex items-center gap-2" title="YuE2 sometimes sings anyway. Listen for it and re-render the part that has singing (up to 2 times).">
            <Label htmlFor="vocal-check">Fix stray vocals</Label>
            <Switch id="vocal-check" checked={params.vocal_check} onCheckedChange={(on) => set("vocal_check", on)} />
          </div>
        )}
      </div>

      <div className="flex gap-4 max-md:flex-col">
        <Label htmlFor="style" className="w-[64px] shrink-0 items-start pt-3 max-md:pt-0">
          Style
        </Label>
        <div className="panel-inset relative min-w-0 flex-1 bg-[#191c1e]">
          <textarea
            id="style"
            className="block h-[74px] w-full resize-none bg-transparent px-4 py-2.5 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60"
            placeholder="Genre, mood, instruments, vocals. e.g. Indie rock, driving drums, jangly guitars, male vocal, nostalgic"
            value={params.style}
            onChange={(e) => set("style", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onGenerate()
            }}
          />
        </div>
        <div className="w-[240px] shrink-0 max-md:w-full">{action}</div>
      </div>

      {!params.instrumental && (
        <div className="flex gap-4 max-md:flex-col">
          <Label htmlFor="lyrics" className="w-[64px] shrink-0 items-start pt-3 max-md:pt-0">
            Lyrics
          </Label>
          <div className="panel-inset min-w-0 flex-1 bg-[#191c1e]">
            <textarea
              id="lyrics"
              rows={12}
              className="block w-full resize-y bg-transparent px-4 py-2.5 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60"
              placeholder={LYRICS_PLACEHOLDER}
              value={params.lyrics}
              onChange={(e) => set("lyrics", e.target.value)}
            />
          </div>
        </div>
      )}

      <div className={cn(PARAM_ROW, "border-t border-border/60 pt-3")}>
        <div className={FIELD}>
          <Label htmlFor="cot" className="shrink-0">
            Planning
          </Label>
          <Select value={timelineActive ? "full" : params.cot} onValueChange={(v) => set("cot", v as Cot)} disabled={timelineActive}>
            <SelectTrigger
              id="cot"
              className={FIELD_TRIGGER}
              title={timelineActive ? "The timeline needs chords in every bar to keep the audio on its beat grid." : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="full">Full score (melody + chords)</SelectItem>
              <SelectItem value="melody">Melody only</SelectItem>
              <SelectItem value="off" disabled={params.instrumental}>
                Off (direct)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ParamKnob
          label="Seed"
          value={params.seed ?? 0}
          min={0}
          max={MAX_SEED}
          step={1}
          decimals={0}
          display={params.seed === null ? "Random" : String(params.seed)}
          hint="A fixed seed reproduces a song; Random picks a new one each time."
          onChange={(v) => set("seed", Math.round(v))}
          adornment={
            <button
              aria-label={params.seed === null ? "Lock a seed" : "Back to random"}
              title={params.seed === null ? "Lock a seed" : "Back to random"}
              onClick={() => set("seed", params.seed === null ? Math.floor(Math.random() * 99999) : null)}
              className={cn("hover:text-primary", params.seed === null ? "text-muted-foreground" : "text-primary")}
            >
              {params.seed === null ? <ShuffleIcon className="size-4" /> : <LockIcon className="size-4" />}
            </button>
          }
        />
        {!timelineActive && (
          <>
            <ParamKnob
              label={params.instrumental ? "Length" : "Max length"}
              value={params.max_seconds}
              min={10}
              max={360}
              step={5}
              decimals={0}
              defaultValue={DEFAULT_PARAMS.max_seconds}
              display={formatTime(params.max_seconds)}
              hint="In seconds. Shorter caps use less VRAM."
              onChange={(v) => set("max_seconds", v)}
            />
            <div className={FIELD}>
              <Label htmlFor="song-key" className="shrink-0">
                Key
              </Label>
              <KeySelect
                id="song-key"
                className={FIELD_TRIGGER}
                value={keyBlocked ? null : params.key}
                onChange={(k) => set("key", k)}
                disabled={Boolean(keyBlocked)}
                title={keyBlocked ?? KEY_HINT}
              />
            </div>
          </>
        )}
      </div>
      {!timelineActive && (
        <p className="text-xs text-muted-foreground">
          {params.instrumental
            ? "Using the score from Advanced instead of the timeline (clear it to use the timeline). Its tempo is fitted to this length."
            : "Song length follows the lyrics; generation stops here if it runs longer. Shorter caps use less VRAM."}
        </p>
      )}

      {timelineActive && (
        <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
          <span className="label-caps">Arrangement</span>
          <TimelineEditor value={params.timeline} onChange={(t) => set("timeline", t)} songKey={params.key} onSongKeyChange={(k) => set("key", k)} />
        </div>
      )}

      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase hover:text-foreground">
          <ChevronDownIcon className={cn("size-4 transition-transform", advanced && "rotate-180")} />
          Advanced: guidance, sampling, flow steps, custom score
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 flex flex-col gap-4">
          <div className={cn(PARAM_ROW, "grid-cols-3 max-md:grid-cols-2")}>
            <ParamKnob
              label="Guidance"
              value={params.cfg_scale ?? 1}
              min={1}
              max={3}
              step={0.05}
              decimals={2}
              display={params.cfg_scale === null ? "Auto" : undefined}
              hint="Classifier-free guidance. Auto is the model default (1.0, or 1.01 with planning off). Higher adheres more to style and lyrics; values above 1 run two passes and use more VRAM."
              onChange={(v) => set("cfg_scale", v)}
              adornment={
                <button
                  title={params.cfg_scale === null ? "Set the guidance by hand" : "Back to the model default"}
                  onClick={() => set("cfg_scale", params.cfg_scale === null ? 1.2 : null)}
                  className={cn("text-[10px] font-semibold tracking-wider hover:text-primary", params.cfg_scale === null ? "text-primary" : "text-muted-foreground")}
                >
                  AUTO
                </button>
              }
            />
            <ParamKnob label="Temperature" value={params.temperature} min={0.5} max={1.5} step={0.05} decimals={2} defaultValue={DEFAULT_PARAMS.temperature} onChange={(v) => set("temperature", v)} />
            <ParamKnob label="Top-p" value={params.top_p} min={0.5} max={1} step={0.01} decimals={2} defaultValue={DEFAULT_PARAMS.top_p} onChange={(v) => set("top_p", v)} />
            <ParamKnob label="Top-k" value={params.top_k} min={10} max={500} step={10} decimals={0} defaultValue={DEFAULT_PARAMS.top_k} onChange={(v) => set("top_k", v)} />
            <ParamKnob label="Repetition" hint="Repetition penalty" value={params.repetition_penalty} min={1} max={1.5} step={0.01} decimals={2} defaultValue={DEFAULT_PARAMS.repetition_penalty} onChange={(v) => set("repetition_penalty", v)} />
            <ParamKnob label="Flow steps" hint="Acoustic detail vs. speed. Default 32." value={params.ode_steps} min={8} max={64} step={1} decimals={0} defaultValue={DEFAULT_PARAMS.ode_steps} onChange={(v) => set("ode_steps", v)} />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="abc">Score (ABC notation, optional)</Label>
              <Button
                variant="outline"
                size="sm"
                disabled={!audioImport || busy || uploading}
                title={
                  !audioImport
                    ? "Run Install.cmd again to add Import from audio (SheetSage2)."
                    : busy && !transcribing
                      ? "Wait for the song to finish."
                      : "Transcribe a recording's melody into the score, for a cover in a new style."
                }
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? <Loader2Icon className="animate-spin" /> : <FileAudioIcon />} Import from audio
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="audio/*,video/*,.flac,.m4a,.ogg,.opus,.wav,.mp3"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = "" // picking the same file again still fires
                  if (file) importAudio(file)
                }}
              />
            </div>
            {transcribing && job && (
              <div className="panel-inset flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <JobProgress job={job} />
                </div>
                <Button variant="ghost" size="sm" onClick={() => api.cancel()}>
                  Cancel
                </Button>
              </div>
            )}
            <div className="panel-inset bg-[#191c1e]">
              <textarea
                id="abc"
                rows={5}
                className="block max-h-96 w-full resize-y bg-transparent px-4 py-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                placeholder="Paste or edit a score (e.g. one downloaded from a previous song) to control melody and chords, or import one from a recording."
                value={params.abc}
                onChange={(e) => set("abc", e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Import from audio transcribes a recording's melody with SheetSage2 and switches Planning to Melody only, so YuE2
              plays that tune in your style (with your lyrics, if any) and writes its own accompaniment.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => {
              const { cfg_scale, temperature, top_p, top_k, repetition_penalty, ode_steps, abc } = DEFAULT_PARAMS
              onChange({ ...params, cfg_scale, temperature, top_p, top_k, repetition_penalty, ode_steps, abc })
            }}
          >
            Reset advanced to defaults
          </Button>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
