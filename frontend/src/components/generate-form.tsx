import { useState } from "react"
import { ChevronDownIcon, DicesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { DEFAULT_TIMELINE, TimelineEditor } from "@/components/timeline-editor"
import { formatTime, type Cot, type GenerateParams } from "@/lib/api"

export const DEFAULT_PARAMS: GenerateParams = {
  style: "",
  lyrics: "",
  instrumental: true,
  timeline: DEFAULT_TIMELINE,
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

function SliderField({
  id,
  label,
  hint,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  value: number
  display?: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{display ?? value}</span>
      </div>
      <Slider id={id} aria-label={label} min={min} max={max} step={step} value={[value]} onValueChange={([v]) => onChange(v)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function GenerateForm({
  params,
  onChange,
}: {
  params: GenerateParams
  onChange: (p: GenerateParams) => void
}) {
  const [advanced, setAdvanced] = useState(false)
  const set = <K extends keyof GenerateParams>(key: K, value: GenerateParams[K]) => onChange({ ...params, [key]: value })
  // The timeline always plans with chords: they keep YuE2's audio on the beat grid (melody-only drifts).
  const timelineActive = params.instrumental && !params.abc.trim()

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="style">Style</Label>
        <Textarea
          id="style"
          rows={3}
          placeholder="Genre, mood, instruments, vocals. e.g. Indie rock, driving drums, jangly guitars, male vocal, nostalgic"
          value={params.style}
          onChange={(e) => set("style", e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="lyrics">Lyrics</Label>
          <div className="flex items-center gap-2">
            {!params.instrumental && (
              <span className="hidden text-xs text-muted-foreground sm:inline">Section tags like [Verse], [Chorus]</span>
            )}
            <Label htmlFor="instrumental" className="text-xs font-normal text-muted-foreground">
              Instrumental
            </Label>
            <Switch
              id="instrumental"
              checked={params.instrumental}
              onCheckedChange={(on) => onChange({ ...params, instrumental: on, cot: on && params.cot === "off" ? "full" : params.cot })}
            />
          </div>
        </div>
        {params.instrumental ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">No vocals. Lay out the song's sections below.</p>
            <div
              className="flex shrink-0 items-center gap-2"
              title="YuE2 sometimes sings anyway. Listen for it and re-render the part that has singing (up to 2 times)."
            >
              <Label htmlFor="vocal-check" className="text-xs font-normal text-muted-foreground">
                Fix stray vocals
              </Label>
              <Switch id="vocal-check" checked={params.vocal_check} onCheckedChange={(on) => set("vocal_check", on)} />
            </div>
          </div>
        ) : (
          <Textarea
            id="lyrics"
            rows={12}
            className="font-mono text-xs leading-relaxed"
            placeholder={LYRICS_PLACEHOLDER}
            value={params.lyrics}
            onChange={(e) => set("lyrics", e.target.value)}
          />
        )}
      </div>

      {params.instrumental ? (
        params.abc.trim() ? (
          <SliderField
            id="max-seconds"
            label="Length"
            hint="Using the score from Advanced instead of the timeline (clear it to use the timeline). Its tempo is fitted to this length."
            value={params.max_seconds}
            display={formatTime(params.max_seconds)}
            min={10}
            max={360}
            step={5}
            onChange={(v) => set("max_seconds", v)}
          />
        ) : (
          <TimelineEditor value={params.timeline} onChange={(t) => set("timeline", t)} />
        )
      ) : (
        <SliderField
          id="max-seconds"
          label="Max length"
          hint="Song length follows the lyrics; generation stops here if it runs longer. Shorter caps use less VRAM."
          value={params.max_seconds}
          display={formatTime(params.max_seconds)}
          min={10}
          max={360}
          step={5}
          onChange={(v) => set("max_seconds", v)}
        />
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="cot">Planning</Label>
          <Select
            value={timelineActive ? "full" : params.cot}
            onValueChange={(v) => set("cot", v as Cot)}
            disabled={timelineActive}
          >
            <SelectTrigger
              id="cot"
              className="w-full"
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
        <div className="flex flex-col gap-2">
          <Label htmlFor="seed">Seed</Label>
          <div className="flex gap-2">
            <Input
              id="seed"
              inputMode="numeric"
              placeholder="Random"
              value={params.seed ?? ""}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, "")
                set("seed", digits ? Number(digits) : null)
              }}
            />
            <Button variant="outline" size="icon" aria-label="Random seed" title="Random seed" onClick={() => set("seed", null)}>
              <DicesIcon />
            </Button>
          </div>
        </div>
      </div>

      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="-ml-2.5 text-muted-foreground">
            <ChevronDownIcon className={advanced ? "rotate-180 transition-transform" : "transition-transform"} />
            Advanced
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="cfg-auto">Guidance (CFG)</Label>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Auto</span>
                <Switch
                  id="cfg-auto"
                  checked={params.cfg_scale === null}
                  onCheckedChange={(auto) => set("cfg_scale", auto ? null : 1.2)}
                />
              </div>
            </div>
            {params.cfg_scale !== null && (
              <Slider
                aria-label="Guidance scale"
                min={1}
                max={3}
                step={0.05}
                value={[params.cfg_scale]}
                onValueChange={([v]) => set("cfg_scale", v)}
              />
            )}
            <p className="text-xs text-muted-foreground">
              {params.cfg_scale === null
                ? "Model default (1.0, or 1.01 with planning off)."
                : `${params.cfg_scale.toFixed(2)}: stronger adherence to style and lyrics. Values above 1 run two passes and use more VRAM.`}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <SliderField id="temperature" label="Temperature" value={params.temperature} display={params.temperature.toFixed(2)} min={0.5} max={1.5} step={0.05} onChange={(v) => set("temperature", v)} />
            <SliderField id="top-p" label="Top-p" value={params.top_p} display={params.top_p.toFixed(2)} min={0.5} max={1} step={0.01} onChange={(v) => set("top_p", v)} />
            <SliderField id="top-k" label="Top-k" value={params.top_k} min={10} max={500} step={10} onChange={(v) => set("top_k", v)} />
            <SliderField id="rep" label="Repetition penalty" value={params.repetition_penalty} display={params.repetition_penalty.toFixed(2)} min={1} max={1.5} step={0.01} onChange={(v) => set("repetition_penalty", v)} />
            <SliderField id="steps" label="Flow steps" hint="Acoustic detail vs. speed. Default 32." value={params.ode_steps} min={8} max={64} step={1} onChange={(v) => set("ode_steps", v)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="abc">Score (ABC notation, optional)</Label>
            <Textarea
              id="abc"
              rows={5}
              className="font-mono text-xs"
              placeholder="Paste or edit a score (e.g. one downloaded from a previous song) to control melody and chords."
              value={params.abc}
              onChange={(e) => set("abc", e.target.value)}
            />
          </div>
          <Button variant="outline" size="sm" className="self-start" onClick={() => {
              const { cfg_scale, temperature, top_p, top_k, repetition_penalty, ode_steps, abc } = DEFAULT_PARAMS
              onChange({ ...params, cfg_scale, temperature, top_p, top_k, repetition_penalty, ode_steps, abc })
            }}>
            Reset advanced to defaults
          </Button>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
