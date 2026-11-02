import { useEffect, useRef, useState } from "react"
import { DownloadIcon, MusicIcon, PauseIcon, PlayIcon, RepeatIcon, RotateCcwIcon, RotateCwIcon, SquareIcon, Volume2Icon, VolumeXIcon } from "lucide-react"

import { JobProgress } from "@/components/job-progress"
import { LevelMeter, type MeterSource } from "@/components/level-meter"
import { TimeRuler } from "@/components/time-ruler"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Slider } from "@/components/ui/slider"
import { api, formatTime, type Job, type Track } from "@/lib/api"
import { decodeChannels } from "@/lib/peaks"
import { cn } from "@/lib/utils"
import { COLUMN_WIDTH, columnsFromAudio, columnsFromPeaks, paintWave } from "@/lib/wave"

const TRANSPORT = "key-bright h-11"

export function Player({
  track,
  autoPlay,
  job,
  audio,
  onPlayingChange,
}: {
  track: Track | null
  autoPlay: boolean
  /** A running song: its progress shows over the waveform. */
  job: Job | null
  audio: React.RefObject<HTMLAudioElement | null>
  onPlayingChange: (playing: boolean) => void
}) {
  const view = useRef<HTMLDivElement>(null)
  const dull = useRef<HTMLCanvasElement>(null)
  const bright = useRef<HTMLCanvasElement>(null)
  const cursor = useRef<HTMLDivElement>(null)
  const [channels, setChannels] = useState<Float32Array[] | null>(null)
  const [meter, setMeter] = useState<MeterSource | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(() => Number(localStorage.getItem("volume") ?? 0.8))
  const [muted, setMuted] = useState(false)
  const [loop, setLoop] = useState(false)

  useEffect(() => {
    const el = audio.current
    if (!el) return
    el.volume = volume
    el.muted = muted
    el.loop = loop
    localStorage.setItem("volume", String(volume))
  }, [audio, volume, muted, loop])

  useEffect(() => {
    if (audio.current) setMeter({ media: audio.current })
  }, [audio])

  useEffect(() => {
    setTime(0)
    setDuration(track?.duration ?? 0)
    if (track && autoPlay) audio.current?.play().catch(() => {})
  }, [audio, track, autoPlay])

  const trackId = track?.id
  useEffect(() => {
    setChannels(null)
    if (!trackId) return
    const abort = new AbortController()
    decodeChannels(api.audioUrl(trackId), abort.signal).then(setChannels).catch(() => {})
    return () => abort.abort()
  }, [trackId])

  // Fires once on observe too, and again whenever the window stretches the view.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (!dull.current || !bright.current || !dull.current.clientWidth) return
      const columns = Math.max(1, Math.round(dull.current.clientWidth / COLUMN_WIDTH))
      const cols = channels ? columnsFromAudio(channels, columns) : columnsFromPeaks([], columns)
      paintWave(dull.current, cols, "dull")
      paintWave(bright.current, cols, "bright")
    })
    if (view.current) observer.observe(view.current)
    return () => observer.disconnect()
  }, [channels])

  // The bright copy of the wave shows up to the playhead; timeupdate alone would make it stutter.
  useEffect(() => {
    let frame = 0
    const draw = () => {
      const el = audio.current
      const total = el?.duration || duration
      const percent = el && total ? (el.currentTime / total) * 100 : 0
      if (bright.current) bright.current.style.clipPath = `inset(0 ${100 - percent}% 0 0)`
      if (cursor.current) cursor.current.style.left = `${percent}%`
      if (playing) frame = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [audio, playing, time, duration])

  const toggle = () => {
    const el = audio.current
    if (!el || !track) return
    if (el.paused) el.play().catch(() => {})
    else el.pause()
  }

  // Space toggles playback unless typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.code !== "Space" || target.closest("input, textarea, select, button, [role=slider], [role=combobox]")) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  const seek = (to: number) => {
    const el = audio.current
    if (!el) return
    el.currentTime = Math.max(0, Math.min(to, el.duration || duration))
    setTime(el.currentTime)
  }
  const stop = () => {
    audio.current?.pause()
    seek(0)
  }
  const fractionAt = (e: React.PointerEvent) => {
    const box = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - box.left) / box.width))
  }

  const disabled = !track
  return (
    <div className="panel panel-dark flex h-[clamp(232px,32vh,340px)] shrink-0 flex-col gap-2 p-3">
      <audio
        ref={audio}
        src={track ? api.audioUrl(track.id) : undefined}
        preload="metadata"
        onPlay={() => {
          setPlaying(true)
          onPlayingChange(true)
        }}
        onPause={() => {
          setPlaying(false)
          onPlayingChange(false)
        }}
        onEnded={() => {
          setPlaying(false)
          onPlayingChange(false)
        }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col px-2 pt-1">
          <div className="flex h-5 min-w-0 items-baseline gap-3 text-[13px]">
            {track && (
              <>
                <span className="min-w-0 truncate font-medium text-foreground/90 select-text" title={track.params.style}>
                  {track.params.style}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground max-lg:hidden">
                  {track.params.instrumental ? "Instrumental" : "Vocal"} · seed {track.params.seed} · {track.params.cot} planning
                  {track.truncated && !track.params.instrumental && " · stopped at max length"}
                </span>
              </>
            )}
          </div>
          <div
            ref={view}
            data-testid="waveform"
            className={cn("wave-view relative mt-[26px] min-h-0 flex-1", !disabled && "cursor-pointer")}
            onPointerDown={(e) => {
              if (disabled) return
              e.currentTarget.setPointerCapture(e.pointerId)
              seek(fractionAt(e) * duration)
            }}
            onPointerMove={(e) => {
              if (disabled) return
              setHover(fractionAt(e))
              if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(fractionAt(e) * duration)
            }}
            onPointerLeave={() => setHover(null)}
          >
            <canvas ref={dull} className="pointer-events-none absolute inset-0 size-full" />
            <canvas ref={bright} className="pointer-events-none absolute inset-0 size-full" />
            {!disabled && <div ref={cursor} className="wave-cursor" />}
            {hover !== null && (
              <div className="pointer-events-none absolute inset-y-0 w-px bg-[#66e8ff]" style={{ left: `${hover * 100}%` }}>
                <span className={cn("absolute top-1 rounded-sm bg-popover px-1.5 py-0.5 font-mono text-[11px] text-accent-foreground", hover > 0.92 ? "right-1" : "left-1")}>
                  {formatTime(hover * duration)}
                </span>
              </div>
            )}
            <TimeRuler duration={duration} />
          </div>
          {!track && !job && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <MusicIcon className="size-6 opacity-60" />
              <p className="text-sm">Generate a song, or pick one from the library</p>
            </div>
          )}
          {job && (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="panel w-[460px] max-w-full px-4 py-3">
                <JobProgress job={job} />
              </div>
            </div>
          )}
        </div>
        <div className="max-md:hidden">
          <LevelMeter source={meter} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="icon" className={cn(TRANSPORT, "w-[85px] max-md:w-[64px]")} onClick={toggle} disabled={disabled} aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)">
          {playing ? <PauseIcon className="size-6 fill-current" /> : <PlayIcon className="size-6 fill-current" />}
        </Button>
        <Button variant="secondary" size="icon" className={cn(TRANSPORT, "w-[56px]")} onClick={stop} disabled={disabled} aria-label="Stop" title="Stop">
          <SquareIcon className="size-5 fill-current" />
        </Button>
        <Button variant="secondary" size="icon" className={cn(TRANSPORT, "w-[56px] max-md:hidden")} onClick={() => seek(time - 10)} disabled={disabled} aria-label="Back 10 seconds" title="Back 10 seconds">
          <RotateCcwIcon className="size-5" />
        </Button>
        <Button variant="secondary" size="icon" className={cn(TRANSPORT, "w-[56px] max-md:hidden")} onClick={() => seek(time + 10)} disabled={disabled} aria-label="Forward 10 seconds" title="Forward 10 seconds">
          <RotateCwIcon className="size-5" />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className={cn(TRANSPORT, "w-[56px]", loop && "key-on")}
          aria-label="Loop"
          aria-pressed={loop}
          title="Loop"
          disabled={disabled}
          onClick={() => setLoop(!loop)}
        >
          <RepeatIcon className="size-5" />
        </Button>
        <span className="ml-3 whitespace-nowrap font-mono text-sm text-foreground/90 tabular-nums">
          {formatTime(time)} <span className="text-muted-foreground">/ {formatTime(duration)}</span>
        </span>
        <Slider
          aria-label="Seek"
          className="mx-2 flex-1"
          disabled={disabled}
          min={0}
          max={duration || 1}
          step={0.1}
          value={[time]}
          onValueChange={([v]) => seek(v)}
        />
        <button className="ml-2 text-muted-foreground hover:text-foreground" onClick={() => setMuted(!muted)} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
          {muted || volume === 0 ? <VolumeXIcon className="size-5" /> : <Volume2Icon className="size-5" />}
        </button>
        <Slider
          aria-label="Volume"
          className="w-28 max-lg:w-20"
          min={0}
          max={1}
          step={0.01}
          value={[muted ? 0 : volume]}
          onValueChange={([v]) => {
            setVolume(v)
            setMuted(false)
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="icon" className={cn(TRANSPORT, "ml-2 w-[56px]")} aria-label="Download" title="Download" disabled={disabled}>
              <DownloadIcon className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          {track && (
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem asChild>
                <a href={api.mp3Url(track.id)} download>
                  MP3 <span className="ml-auto pl-4 text-xs text-muted-foreground">320 kbps</span>
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={api.downloadUrl(track.id)} download>
                  FLAC <span className="ml-auto pl-4 text-xs text-muted-foreground">lossless</span>
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          )}
        </DropdownMenu>
      </div>
    </div>
  )
}
