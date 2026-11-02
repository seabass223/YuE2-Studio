import { Loader2Icon } from "lucide-react"

import { Progress } from "@/components/ui/progress"
import { formatTime, type Job } from "@/lib/api"

const STAGES = ["Planning score", "Generating song", "Synthesizing audio", "Decoding audio"]

type JobStatus = Pick<Job, "stage" | "completed" | "total" | "unit" | "audio_seconds" | "max_seconds" | "elapsed" | "part">

/** Progress through the current stage, or null when the stage doesn't know its total. */
export function jobPercent(job: JobStatus) {
  if (job.stage === "Generating song") return (job.audio_seconds / job.max_seconds) * 100
  return job.total ? (job.completed / job.total) * 100 : null
}

export function JobProgress({ job }: { job: JobStatus }) {
  const index = STAGES.indexOf(job.stage)
  const value = jobPercent(job)
  let detail = ""
  if (job.stage === "Generating song") {
    detail = `${formatTime(job.audio_seconds)} of music (max ${formatTime(job.max_seconds)})`
  } else if (job.total) {
    detail = `${job.completed} / ${job.total} ${job.unit ?? ""}`
  } else if (job.stage === "Planning score") {
    detail = `${job.completed} score tokens`
  } else if (job.stage === "Transcribing melody" && job.completed) {
    detail = `${job.completed} ${job.unit}`
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-sm">
        <span className="flex items-center gap-2">
          <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
          {index >= 0 && <span className="text-muted-foreground">{index + 1}/4</span>}
          {job.stage}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{formatTime(job.elapsed)}</span>
      </div>
      <Progress value={value ?? 0} className={value === null ? "animate-pulse" : undefined} />
      <span className="h-4 text-xs tabular-nums text-muted-foreground">
        {job.part ? `${job.part}${detail ? " · " + detail : ""}` : detail}
      </span>
    </div>
  )
}
