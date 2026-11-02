import { FolderOpenIcon } from "lucide-react"

import { SparkIcon, Wordmark } from "@/components/logo"
import { Progress } from "@/components/ui/progress"
import { jobPercent } from "@/components/job-progress"
import { formatTime, type Snapshot, type Track } from "@/lib/api"
import { cn } from "@/lib/utils"

export type View = "generate" | "library"

const NAV: { id: View; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "generate", label: "Generate", icon: SparkIcon },
  { id: "library", label: "Library", icon: FolderOpenIcon },
]

const STATUS_LABELS = { starting: "Starting", downloading: "Downloading model", loading: "Loading model", ready: "Ready", error: "Error" }

export function TitleBar({ snapshot, connected }: { snapshot: Snapshot | null; connected: boolean }) {
  return (
    <header className="flex h-[68px] shrink-0 items-center gap-5 border-b border-black/70 bg-linear-to-b from-[#1c2023] to-[#1d2226] pr-3 pl-6 shadow-[inset_0_1px_0_rgb(83_97_106/0.55)]">
      <Wordmark />
      <EnginePill snapshot={snapshot} connected={connected} />
    </header>
  )
}

function EnginePill({ snapshot, connected }: { snapshot: Snapshot | null; connected: boolean }) {
  const gpu = snapshot?.gpu
  const ok = connected && snapshot?.status === "ready"
  const running = snapshot?.job?.state === "running" || snapshot?.job?.state === "queued"
  const label = !connected ? "OFFLINE" : !snapshot ? "CONNECTING" : ok ? null : STATUS_LABELS[snapshot.status].toUpperCase()
  return (
    <div
      className={cn(
        "key key-well engine-pill ml-auto flex h-11 shrink-0 items-center gap-2.5 px-4 text-[14px] font-medium tracking-[0.04em] whitespace-nowrap",
        ok ? "text-[#72dd80]" : "text-muted-foreground",
      )}
      title={gpu?.last_peak_gib ? `Last song peaked at ${gpu.last_peak_gib} GB reserved by PyTorch` : undefined}
    >
      <span
        className={cn(
          "size-2.5 rounded-full shadow-[0_0_8px_currentColor]",
          ok ? "bg-success" : connected && snapshot?.status !== "error" ? "bg-warning" : "bg-destructive",
          running && "animate-pulse",
        )}
      />
      {label ?? (
        <span className="tabular-nums">
          LOCAL{gpu && ` · ${gpu.name.replace(/^NVIDIA (GeForce )?/, "")} · ${gpu.used_gib.toFixed(1)} / ${gpu.total_gib.toFixed(1)} GB`}
        </span>
      )}
    </div>
  )
}

export function Sidebar({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <nav className="panel flex w-[176px] shrink-0 flex-col gap-2 p-3 max-md:w-[68px] max-md:px-2">
      {NAV.map((n) => (
        <button
          key={n.id}
          onClick={() => onChange(n.id)}
          title={n.label}
          aria-current={view === n.id ? "page" : undefined}
          className={cn(
            "flex h-12 w-full items-center gap-3 rounded-md px-4 text-[15px] transition-colors max-md:justify-center max-md:px-0",
            view === n.id ? "nav-on font-medium" : "text-foreground/85 hover:bg-white/5 [&_svg]:text-[#a3e4ff]",
          )}
        >
          <n.icon className="size-5 shrink-0" />
          <span className="max-md:hidden">{n.label}</span>
        </button>
      ))}
    </nav>
  )
}

export function StatusBar({ snapshot, connected, current }: { snapshot: Snapshot | null; connected: boolean; current: Track | null }) {
  const job = snapshot?.job
  const running = job?.state === "running" || job?.state === "queued"
  const percent = job && running ? jobPercent(job) : null
  const state = !connected
    ? "Offline"
    : !snapshot
      ? "Connecting"
      : running
        ? job.stage || "Queued"
        : STATUS_LABELS[snapshot.status]
  return (
    <footer className="flex h-9 shrink-0 items-center gap-6 border-t border-black/70 bg-linear-to-b from-[#20262a] to-[#262f36] px-6 text-[13px]">
      <div className="flex items-center gap-4 text-muted-foreground max-md:hidden" title="Every song is saved in this format; MP3 is one click away in Download">
        <span>Output:</span>
        <span className="text-foreground">48 kHz</span>
        <span className="text-primary">Stereo</span>
        <span className="text-primary">FLAC</span>
      </div>
      <div className="flex-1" />
      {running && <Progress value={percent ?? 0} className={cn("h-1.5 w-40", percent === null && "animate-pulse")} />}
      <span className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full", !connected || snapshot?.status === "error" ? "bg-destructive" : running || snapshot?.status !== "ready" ? "animate-pulse bg-warning" : "bg-success")} />
        {state}
      </span>
      <span className="h-4 w-px bg-border" />
      <span className="text-muted-foreground">
        Generated in: <span className="text-foreground">{current ? formatTime(current.seconds_taken) : "–"}</span>
      </span>
    </footer>
  )
}
