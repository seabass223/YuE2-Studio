import { useState } from "react"
import { DownloadIcon, FileMusicIcon, MoreHorizontalIcon, PlayIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { api, formatTime, type Track } from "@/lib/api"
import { cn } from "@/lib/utils"

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

export function Library({
  tracks,
  currentId,
  onSelect,
  onUseSettings,
  onDelete,
}: {
  tracks: Track[]
  currentId: string | null
  onSelect: (t: Track) => void
  onUseSettings: (t: Track) => void
  onDelete: (t: Track) => void
}) {
  const [confirming, setConfirming] = useState<string | null>(null)

  if (!tracks.length) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No songs yet.</p>
  }
  return (
    <ul className="flex flex-col">
      {tracks.map((t) => (
        <li
          key={t.id}
          className={cn(
            "group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/60",
            t.id === currentId && "bg-muted",
          )}
        >
          <button
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={() => onSelect(t)}
            title={t.params.style}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground group-hover:text-foreground">
              <PlayIcon className="size-3.5" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm">{t.params.style}</span>
              <span className="truncate text-xs text-muted-foreground">
                {dateFormat.format(new Date(t.created))} · {formatTime(t.duration)}{t.params.instrumental && " · instrumental"} · seed {t.params.seed}
                {t.truncated && !t.params.instrumental && " · hit max length"}
              </span>
            </span>
          </button>
          <DropdownMenu onOpenChange={(open) => !open && setConfirming(null)}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Track actions">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onUseSettings(t)}>
                <SlidersHorizontalIcon /> Use these settings
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={api.mp3Url(t.id)} download>
                  <DownloadIcon /> Download MP3
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={api.downloadUrl(t.id)} download>
                  <DownloadIcon /> Download FLAC
                </a>
              </DropdownMenuItem>
              {t.has_score && (
                <DropdownMenuItem asChild>
                  <a href={api.scoreUrl(t.id)} download>
                    <FileMusicIcon /> Download score (ABC)
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={(e) => {
                  if (confirming !== t.id) {
                    e.preventDefault()
                    setConfirming(t.id)
                  } else {
                    onDelete(t)
                  }
                }}
              >
                <Trash2Icon /> {confirming === t.id ? "Click again to delete" : "Delete"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      ))}
    </ul>
  )
}
