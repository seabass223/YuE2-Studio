/** Types and names from the MCP Micro-UI Jobs profile (specs/mcp-micro-ui-jobs). */

export const PROFILE = "dev.micro-ui/jobs"
export const PROFILE_VERSION = "0.1.0"

export const NOTIFY = {
  started: "micro-ui-jobs/notifications/started",
  status: "micro-ui-jobs/notifications/status",
  completed: "micro-ui-jobs/notifications/completed",
  delivered: "micro-ui-jobs/notifications/delivered",
} as const

export type JobState = "working" | "input_required" | "completed" | "failed" | "cancelled"

export interface CompanionTools {
  statusTool: string
  resultTool: string
  cancelTool: string
}

export interface JobHandle extends CompanionTools {
  jobId: string
  state: "working"
  pollIntervalMs: number
  ttlMs: number
  createdAt?: string
}

export interface InputNeeded extends CompanionTools {
  state: "input_required"
  missing: string[]
  draft?: Record<string, unknown>
  pollIntervalMs?: number
  ttlMs?: number
}

export interface JobError {
  code: string
  message: string
  retryAfterMs?: number
}

export interface JobStatus<Data = Record<string, unknown>> {
  jobId: string
  state: JobState
  phase: string
  progress: number | null
  message: string
  elapsedMs: number
  etaMs?: number
  pollIntervalMs: number
  updatedAt: string
  error?: JobError
  data?: Data
}

export interface Artifact {
  uri: string
  name: string
  mimeType: string
  size: number
  sha256: string
  role: "primary" | "alternate" | "auxiliary"
  durationMs?: number
  url?: string
}

export interface JobResult<Data = Record<string, unknown>> {
  jobId: string
  state: "completed"
  artifacts: Artifact[]
  data?: Data
}

export const isTerminal = (state: JobState) => state === "completed" || state === "failed" || state === "cancelled"
