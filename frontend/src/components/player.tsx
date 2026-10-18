import { useEffect, useRef, useState } from "react"
import {
  DownloadIcon,
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  RotateCcwIcon,
  RotateCwIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api, formatTime, type Track } from "@/lib/api"
import { cn } from "@/lib/utils"

function IconButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(active && "bg-muted text-foreground")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function Player({ track, autoPlay }: { track: Track | null; autoPlay: boolean }) {
  const audio = useRef<HTMLAudioElement>(null)
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
  }, [volume, muted, loop])

  useEffect(() => {
    setTime(0)
    setDuration(track?.duration ?? 0)
    if (track && autoPlay) audio.current?.play().catch(() => {})
  }, [track, autoPlay])

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

  const disabled = !track
  return (
    <div className="flex flex-col gap-3">
      <audio
        ref={audio}
        src={track ? api.audioUrl(track.id) : undefined}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />
      <div className="flex items-center gap-3">
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{formatTime(time)}</span>
        <Slider
          aria-label="Seek"
          disabled={disabled}
          min={0}
          max={duration || 1}
          step={0.1}
          value={[time]}
          onValueChange={([v]) => seek(v)}
        />
        <span className="w-10 text-xs tabular-nums text-muted-foreground">{formatTime(duration)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <IconButton label="Back 10 seconds" disabled={disabled} onClick={() => seek(time - 10)}>
          <RotateCcwIcon />
        </IconButton>
        <Button
          size="icon-lg"
          className="rounded-full"
          aria-label={playing ? "Pause" : "Play"}
          disabled={disabled}
          onClick={toggle}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <IconButton label="Forward 10 seconds" disabled={disabled} onClick={() => seek(time + 10)}>
          <RotateCwIcon />
        </IconButton>
        <IconButton label="Loop" active={loop} disabled={disabled} onClick={() => setLoop(!loop)}>
          <RepeatIcon />
        </IconButton>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)}>
            {muted || volume === 0 ? <VolumeXIcon /> : <Volume2Icon />}
          </IconButton>
          <Slider
            aria-label="Volume"
            className="w-24"
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
              <Button variant="ghost" size="icon" aria-label="Download" title="Download" disabled={disabled}>
                <DownloadIcon />
              </Button>
            </DropdownMenuTrigger>
            {track && (
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a href={api.mp3Url(track.id)} download>
                    MP3 <span className="ml-auto text-xs text-muted-foreground">320 kbps</span>
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={api.downloadUrl(track.id)} download>
                    FLAC <span className="ml-auto text-xs text-muted-foreground">lossless</span>
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            )}
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
