import { useRef, useState } from "react"
import { ArrowLeftIcon, ArrowRightIcon, CopyIcon, MinusIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { FIELD, FIELD_TRIGGER, ParamKnob } from "@/components/param-knob"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { KeySelect } from "@/components/key-select"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  beatsPerBar,
  formatLength,
  newSectionId,
  SECTION_LABELS,
  timelineBars,
  timelineSeconds,
  type Meter,
  type Section,
  type SectionLabel,
  type Timeline,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const MAX_BARS = 64
const MAX_SECONDS = 360

export const DEFAULT_TIMELINE: Timeline = {
  bpm: 120,
  meter: "4/4",
  strict: true,
  sections: [
    { id: "s1", label: "intro", bars: 4 },
    { id: "s2", label: "verse", bars: 8 },
    { id: "s3", label: "chorus", bars: 8 },
    { id: "s4", label: "outro", bars: 4 },
  ],
}

const clampBars = (n: number) => Math.max(1, Math.min(MAX_BARS, Math.round(n)))

/** Scale section lengths to a new bar total (largest-remainder rounding, at least 1 bar each). */
function fitSections(sections: Section[], target: number): Section[] {
  const total = sections.reduce((s, x) => s + x.bars, 0)
  const exact = sections.map((s) => Math.max(1, (s.bars * target) / total))
  const bars = exact.map((x) => Math.max(1, Math.min(MAX_BARS, Math.floor(x))))
  let left = target - bars.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (let k = 0; left !== 0 && k < order.length * 4; k++) {
    const i = order[k % order.length][1]
    if (left > 0 && bars[i] < MAX_BARS) {
      bars[i]++
      left--
    } else if (left < 0 && bars[i] > 1) {
      bars[i]--
      left++
    }
  }
  return sections.map((s, i) => ({ ...s, bars: bars[i] }))
}

export function TimelineEditor({
  value,
  onChange,
  songKey,
  onSongKeyChange,
}: {
  value: Timeline
  onChange: (t: Timeline) => void
  songKey: string | null
  onSongKeyChange: (key: string | null) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(value.sections[0]?.id ?? null)
  const [frozenTotal, setFrozenTotal] = useState<number | null>(null)
  const strip = useRef<HTMLDivElement>(null)

  const bars = timelineBars(value)
  const seconds = timelineSeconds(value)
  const beats = beatsPerBar(value.meter)
  const secondsPerBar = (beats * 60) / value.bpm
  const maxBars = Math.floor(MAX_SECONDS / secondsPerBar)
  const selectedIndex = value.sections.findIndex((s) => s.id === selectedId)
  const selected = selectedIndex >= 0 ? value.sections[selectedIndex] : null
  const scale = frozenTotal ?? bars
  const strict = value.strict ?? true

  const setSections = (sections: Section[]) => onChange({ ...value, sections })
  const update = (id: string, patch: Partial<Section>) =>
    setSections(value.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const setLength = (target: number) => {
    const targetBars = Math.max(value.sections.length, Math.min(maxBars, Math.round(target / secondsPerBar)))
    if (targetBars !== bars) setSections(fitSections(value.sections, targetBars))
  }

  const add = () => {
    const section: Section = { id: newSectionId(), label: selected?.label === "verse" ? "chorus" : "verse", bars: 4 }
    const at = selectedIndex >= 0 ? selectedIndex + 1 : value.sections.length
    setSections([...value.sections.slice(0, at), section, ...value.sections.slice(at)])
    setSelectedId(section.id)
  }
  const duplicate = () => {
    if (!selected) return
    const copy = { ...selected, id: newSectionId() }
    setSections([...value.sections.slice(0, selectedIndex + 1), copy, ...value.sections.slice(selectedIndex + 1)])
    setSelectedId(copy.id)
  }
  const remove = () => {
    if (!selected || value.sections.length === 1) return
    const next = value.sections.filter((s) => s.id !== selected.id)
    setSections(next)
    setSelectedId(next[Math.min(selectedIndex, next.length - 1)].id)
  }
  const move = (delta: number) => {
    const to = selectedIndex + delta
    if (!selected || to < 0 || to >= value.sections.length) return
    const next = [...value.sections]
    next.splice(selectedIndex, 1)
    next.splice(to, 0, selected)
    setSections(next)
  }

  // Drag a block's right edge; widths keep the scale from the drag start so the edge tracks the pointer.
  const startResize = (event: React.PointerEvent, section: Section) => {
    event.preventDefault()
    event.stopPropagation()
    const width = strip.current?.getBoundingClientRect().width ?? 1
    const pxPerBar = width / bars
    const startX = event.clientX
    const startBars = section.bars
    setSelectedId(section.id)
    setFrozenTotal(bars)
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    let latest = value
    const onMove = (e: PointerEvent) => {
      const next = clampBars(startBars + (e.clientX - startX) / pxPerBar)
      latest = { ...latest, sections: latest.sections.map((s) => (s.id === section.id ? { ...s, bars: next } : s)) }
      onChange(latest)
    }
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onUp)
      handle.removeEventListener("pointercancel", onUp)
      setFrozenTotal(null)
    }
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onUp)
  }

  // Ruler ticks every 4 bars (8 or 16 for long timelines).
  const tickEvery = scale > 96 ? 16 : scale > 48 ? 8 : 4
  const ticks = Array.from({ length: Math.floor(scale / tickEvery) + 1 }, (_, i) => i * tickEvery)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[minmax(150px,1fr)_minmax(90px,0.6fr)_minmax(90px,0.6fr)_minmax(180px,1.6fr)] items-center gap-5 param-tight:gap-3">
        <ParamKnob
          label="BPM"
          value={value.bpm}
          min={40}
          max={240}
          step={1}
          decimals={0}
          defaultValue={DEFAULT_TIMELINE.bpm}
          onChange={(bpm) => onChange({ ...value, bpm: Math.round(bpm) })}
        />
        <div className={FIELD}>
          <Label htmlFor="meter" className="shrink-0">Meter</Label>
          <Select value={value.meter} onValueChange={(meter) => onChange({ ...value, meter: meter as Meter })}>
            <SelectTrigger id="meter" className={FIELD_TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="4/4">4/4</SelectItem>
              <SelectItem value="3/4">3/4</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className={FIELD}>
          <Label htmlFor="key" className="shrink-0">Key</Label>
          <KeySelect id="key" className={FIELD_TRIGGER} value={songKey} onChange={onSongKeyChange} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="length">Length</Label>
            <span className={cn("font-mono text-xs tabular-nums", seconds > MAX_SECONDS ? "text-destructive" : "text-muted-foreground")}>
              {formatLength(seconds)} · {bars} bars
            </span>
          </div>
          <Slider
            id="length"
            aria-label="Length"
            min={secondsPerBar * value.sections.length}
            max={MAX_SECONDS}
            step={secondsPerBar}
            value={[Math.min(seconds, MAX_SECONDS)]}
            onValueChange={([v]) => setLength(v)}
            className="h-8"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div ref={strip} className="panel-inset flex h-14 w-full overflow-hidden">
          {value.sections.map((section) => (
            <div
              key={section.id}
              className="relative h-full shrink-0"
              style={{ width: `${(section.bars / scale) * 100}%` }}
            >
              <button
                type="button"
                onClick={() => setSelectedId(section.id)}
                className={cn(
                  "flex h-full w-full flex-col items-start justify-center overflow-hidden border-r px-1.5 text-left",
                  `section-block section-${section.label}`,
                  section.id === selectedId && "shadow-[inset_0_0_14px_rgb(31_204_255/0.3)] ring-2 ring-ring ring-inset",
                )}
                title={`${section.label}: ${section.bars} bars (${formatLength(section.bars * secondsPerBar)})${
                  section.description ? `\n${section.description}` : ""
                }`}
              >
                <span className="w-full truncate text-xs font-medium capitalize">{section.label}</span>
                <span className="w-full truncate text-[11px] tabular-nums text-muted-foreground">
                  {section.bars}
                  {strict && section.description ? ` · ${section.description}` : ""}
                </span>
              </button>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${section.label}`}
                aria-valuenow={section.bars}
                aria-valuemin={1}
                aria-valuemax={MAX_BARS}
                tabIndex={0}
                onPointerDown={(e) => startResize(e, section)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault()
                    update(section.id, { bars: clampBars(section.bars + (e.key === "ArrowRight" ? 1 : -1)) })
                  }
                }}
                className="absolute top-0 right-0 z-10 h-full w-2.5 cursor-ew-resize touch-none hover:bg-foreground/15 focus-visible:bg-foreground/20 focus-visible:outline-none"
              />
            </div>
          ))}
        </div>
        <div className="relative h-4 text-[10px] tabular-nums text-muted-foreground">
          {ticks.map((bar) => (
            <span
              key={bar}
              className="absolute -translate-x-1/2 first:translate-x-0"
              style={{ left: `${(bar / scale) * 100}%` }}
            >
              {formatLength(bar * secondsPerBar)}
            </span>
          ))}
        </div>
      </div>

      {selected && (
        <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selected.label} onValueChange={(label) => update(selected.id, { label: label as SectionLabel })}>
            <SelectTrigger aria-label="Section label" className="w-36 capitalize">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SECTION_LABELS.map((label) => (
                <SelectItem key={label} value={label} className="capitalize">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center">
            <Button
              variant="outline"
              size="icon"
              className="rounded-r-none"
              aria-label="One bar shorter"
              onClick={() => update(selected.id, { bars: clampBars(selected.bars - 1) })}
            >
              <MinusIcon />
            </Button>
            <Input
              aria-label="Bars"
              inputMode="numeric"
              className="w-14 rounded-none border-x-0 text-center tabular-nums"
              value={selected.bars}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ""))
                if (n) update(selected.id, { bars: clampBars(n) })
              }}
            />
            <Button
              variant="outline"
              size="icon"
              className="rounded-l-none"
              aria-label="One bar longer"
              onClick={() => update(selected.id, { bars: clampBars(selected.bars + 1) })}
            >
              <PlusIcon />
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">bars</span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Move left" title="Move left" disabled={selectedIndex === 0} onClick={() => move(-1)}>
              <ArrowLeftIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Move right"
              title="Move right"
              disabled={selectedIndex === value.sections.length - 1}
              onClick={() => move(1)}
            >
              <ArrowRightIcon />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Duplicate" title="Duplicate" onClick={duplicate}>
              <CopyIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete section"
              title="Delete section"
              disabled={value.sections.length === 1}
              onClick={remove}
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
        {selected.label !== "silence" && (
          <Input
            aria-label="Style for this section"
            placeholder={
              strict
                ? `Style for this ${selected.label} only (optional), e.g. "driving staccato strings, big drums"`
                : "Section styles need exact section timing (below)"
            }
            disabled={!strict}
            value={selected.description ?? ""}
            onChange={(e) => update(selected.id, { description: e.target.value })}
          />
        )}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <Button variant="outline" size="sm" onClick={add}>
          <PlusIcon /> Add section
        </Button>
        <div className="flex items-center gap-2">
          <Label htmlFor="strict">
            Exact section timing
          </Label>
          <Switch id="strict" checked={strict} onCheckedChange={(on) => onChange({ ...value, strict: on })} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {seconds > MAX_SECONDS
          ? `Too long: the maximum is ${formatLength(MAX_SECONDS)}.`
          : strict
            ? "Each section is written in turn, continuing from the one before, and held to exactly its bars; the audio is rendered in one pass. The song is exactly this long."
            : "Rendered in one pass: smoother transitions, but sections can drift up to about a bar. The song is exactly this long."}
      </p>
    </div>
  )
}
