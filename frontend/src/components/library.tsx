import { useEffect, useRef, useState } from "react"
import { DownloadIcon, FileMusicIcon, MoreVerticalIcon, PauseIcon, PlayIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react"

import { MiniWave } from "@/components/mini-wave"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { api, formatTime, type Track } from "@/lib/api"
import { trackPeaks } from "@/lib/peaks"
import { cn } from "@/lib/utils"

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

const RECENT = 4

interface TrackActions {
  currentId: string | null
  playing: boolean
  onSelect: (t: Track) => void
  onUseSettings: (t: Track) => void
  onDelete: (t: Track) => void
}

/** Decodes a track's envelope once its card is on screen. */
function TrackWave({ track, active, className }: { track: Track; active: boolean; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [peaks, setPeaks] = useState<number[]>([])
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      observer.disconnect()
      trackPeaks(track.id, api.audioUrl(track.id)).then(setPeaks).catch(() => {})
    })
    if (box.current) observer.observe(box.current)
    return () => observer.disconnect()
  }, [track.id])
  return (
    <div ref={box} className={className}>
      <MiniWave peaks={peaks} active={active} className="size-full" />
    </div>
  )
}

function TrackMenu({ track, onUseSettings, onDelete }: { track: Track; onUseSettings: (t: Track) => void; onDelete: (t: Track) => void }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <DropdownMenu onOpenChange={(open) => !open && setConfirming(false)}>
      <DropdownMenuTrigger aria-label="Track actions" className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground">
        <MoreVerticalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => onUseSettings(track)}>
          <SlidersHorizontalIcon /> Use these settings
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={api.mp3Url(track.id)} download>
            <DownloadIcon /> Download MP3
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={api.downloadUrl(track.id)} download>
            <DownloadIcon /> Download FLAC
          </a>
        </DropdownMenuItem>
        {track.has_score && (
          <DropdownMenuItem asChild>
            <a href={api.scoreUrl(track.id)} download>
              <FileMusicIcon /> Download score (ABC)
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={(e) => {
            if (!confirming) {
              e.preventDefault()
              setConfirming(true)
            } else {
              onDelete(track)
            }
          }}
        >
          <Trash2Icon /> {confirming ? "Click again to delete" : "Delete"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PlayGlyph({ on, className }: { on: boolean; className: string }) {
  return on ? <PauseIcon className={cn(className, "fill-current")} /> : <PlayIcon className={cn(className, "ml-0.5 fill-current")} />
}

export function RecentSongs({ tracks, currentId, playing, onSelect, onUseSettings, onDelete, generating }: TrackActions & { tracks: Track[]; generating: boolean }) {
  return (
    <div className="panel flex shrink-0 flex-col gap-2 px-4 pt-2.5 pb-3">
      <span className="label-caps">Recent songs</span>
      {tracks.length === 0 ? (
        <div className="flex h-[60px] items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          {generating ? "Generating…" : "New songs appear here, and stay in the Library."}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
          {tracks.slice(0, RECENT).map((t) => {
            const current = t.id === currentId
            return (
              <div key={t.id} className={cn("take-card relative flex items-center gap-3 px-3 py-2.5", current && "take-card-on")}>
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onSelect(t)} title={t.params.style}>
                  <span className="take-play flex size-12 shrink-0 items-center justify-center rounded-full">
                    <PlayGlyph on={current && playing} className="size-5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate pr-4 text-sm font-medium">{t.params.style}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{formatTime(t.duration)}</span>
                      <TrackWave track={t} active={current} className="h-7 min-w-0 flex-1" />
                    </span>
                  </span>
                </button>
                <div className="absolute top-1.5 right-1.5">
                  <TrackMenu track={t} onUseSettings={onUseSettings} onDelete={onDelete} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Library({ tracks, currentId, playing, onSelect, onUseSettings, onDelete }: TrackActions & { tracks: Track[] }) {
  return (
    <div className="panel flex min-h-full flex-col gap-1 p-3">
      <div className="flex items-baseline gap-3 px-1 pb-2">
        <span className="label-caps">All songs</span>
        <span className="text-xs text-muted-foreground">
          {tracks.length} {tracks.length === 1 ? "item" : "items"}
        </span>
      </div>
      {!tracks.length && <p className="py-6 text-center text-sm text-muted-foreground">No songs yet.</p>}
      <ul className="flex flex-col">
        {tracks.map((t) => {
          const current = t.id === currentId
          return (
            <li key={t.id} className={cn("group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/[0.03]", current && "bg-accent hover:bg-accent")}>
              <button className="flex min-w-0 flex-1 items-center gap-4 text-left" onClick={() => onSelect(t)} title={t.params.style}>
                <span className="take-play flex size-9 shrink-0 items-center justify-center rounded-full">
                  <PlayGlyph on={current && playing} className="size-4" />
                </span>
                <TrackWave track={t} active={current} className="h-10 w-40 shrink-0 max-md:hidden" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px] font-medium">{t.params.style}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {dateFormat.format(new Date(t.created))} · seed {t.params.seed}
                    {t.truncated && !t.params.instrumental && " · hit max length"}
                  </span>
                </span>
                <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground max-lg:hidden">
                  {t.params.instrumental ? "instrumental" : "vocal"}
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">{formatTime(t.duration)}</span>
              </button>
              <TrackMenu track={t} onUseSettings={onUseSettings} onDelete={onDelete} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
