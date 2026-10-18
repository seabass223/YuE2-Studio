import { useCallback, useEffect, useRef, useState } from "react"
import type { App } from "@modelcontextprotocol/ext-apps"
import { z } from "zod"

import {
  NOTIFY,
  PROFILE,
  isTerminal,
  type InputNeeded,
  type JobHandle,
  type JobResult,
  type JobStatus,
} from "./profile"

type ToolResult = Awaited<ReturnType<App["callServerTool"]>>

export type JobView<StatusData, ResultData> =
  | { kind: "waiting" }
  | { kind: "form"; input: InputNeeded }
  | { kind: "tracking"; handle: JobHandle; status: JobStatus<StatusData> | null }
  | { kind: "finished"; handle: JobHandle; status: JobStatus<StatusData>; result: JobResult<ResultData> | null }
  | { kind: "error"; message: string }

function errorText(result: ToolResult) {
  const structured = result.structuredContent as { error?: { message?: string } } | undefined
  const text = result.content?.find((c) => c.type === "text")
  return structured?.error?.message ?? (text && "text" in text ? text.text : "The tool call failed")
}

/**
 * Follows one job per the MCP Micro-UI Jobs profile: reads the handle from the start tool's result,
 * polls the status tool through the host, fetches the result when it completes and reports each step
 * to hosts that advertise the profile.
 */
export function useJob<StatusData, ResultData>(app: App | null, startTool: string) {
  const [view, setView] = useState<JobView<StatusData, ResultData>>({ kind: "waiting" })
  const [delivered, setDelivered] = useState<string | null>(null)
  const reported = useRef(new Set<string>())

  const notify = useCallback(
    (method: string, params: object) => {
      if (!app?.getHostCapabilities()?.experimental?.[PROFILE]) return
      app.notification({ method, params: params as Record<string, unknown> }).catch(() => {})
    },
    [app],
  )

  /** Handles the start tool's result, whether the host or this View made the call. */
  const accept = useCallback(
    (result: ToolResult, startedHere = false) => {
      const structured = result.structuredContent as { state?: string; jobId?: string } | undefined
      if (result.isError || !structured) {
        setView({ kind: "error", message: errorText(result) })
      } else if (structured.state === "input_required") {
        setView({ kind: "form", input: structured as InputNeeded })
      } else if (structured.jobId) {
        const handle = structured as JobHandle
        setView({ kind: "tracking", handle, status: null })
        if (startedHere) notify(NOTIFY.started, handle)
      }
    },
    [notify],
  )

  const handle = view.kind === "tracking" ? view.handle : null

  useEffect(() => {
    if (!app || !handle) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = ""
    let failures = 0

    const finish = async (status: JobStatus<StatusData>) => {
      let result: JobResult<ResultData> | null = null
      if (status.state === "completed") {
        const response = await app.callServerTool({ name: handle.resultTool, arguments: { jobId: handle.jobId } })
        if (!response.isError) result = response.structuredContent as unknown as JobResult<ResultData>
      }
      if (stopped) return
      setView({ kind: "finished", handle, status, result })
      if (reported.current.has(handle.jobId)) return
      reported.current.add(handle.jobId)
      notify(NOTIFY.completed, { jobId: handle.jobId, state: status.state, ...(result ? { result } : {}), ...(status.error ? { error: status.error } : {}) })
      const primary = result?.artifacts.find((a) => a.role === "primary")
      const summary = primary
        ? `The requested job ${handle.jobId} finished. Primary artifact: ${primary.uri} (${primary.mimeType}, ${primary.size} bytes).`
        : `The requested job ${handle.jobId} ended: ${status.state}. ${status.message}`
      app.updateModelContext({ content: [{ type: "text", text: summary }], structuredContent: { ...(result ?? status) } }).catch(() => {})
    }

    const poll = async () => {
      try {
        const response = await app.callServerTool({ name: handle.statusTool, arguments: { jobId: handle.jobId } })
        if (stopped) return
        if (response.isError) {
          setView({ kind: "error", message: errorText(response) })
          return
        }
        failures = 0
        const status = response.structuredContent as unknown as JobStatus<StatusData>
        setView((v) => (v.kind === "tracking" && v.handle === handle ? { ...v, status } : v))
        const key = `${status.state}|${status.phase}|${status.progress}|${status.message}`
        if (key !== last) {
          last = key
          notify(NOTIFY.status, status)
        }
        if (isTerminal(status.state)) {
          await finish(status)
          return
        }
        timer = setTimeout(poll, Math.max(status.pollIntervalMs, handle.pollIntervalMs))
      } catch {
        if (stopped) return
        failures += 1 // transient host or server hiccup: back off, keep the job
        timer = setTimeout(poll, Math.min(handle.pollIntervalMs * 2 ** failures, 15000))
      }
    }

    poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [app, handle, notify])

  useEffect(() => {
    if (!app) return
    app.setNotificationHandler(NOTIFY.delivered, { params: deliveredSchema }, (params) => setDelivered(params.jobId))
    return () => app.removeNotificationHandler(NOTIFY.delivered)
  }, [app])

  const start = useCallback(
    async (args: Record<string, unknown>) => {
      if (!app) return
      try {
        accept(await app.callServerTool({ name: startTool, arguments: args }), true)
      } catch (e) {
        setView({ kind: "error", message: (e as Error).message })
      }
    },
    [app, accept, startTool],
  )

  const cancel = useCallback(async () => {
    if (!app || !handle) return
    await app.callServerTool({ name: handle.cancelTool, arguments: { jobId: handle.jobId } }).catch(() => {})
  }, [app, handle])

  const jobId = view.kind === "tracking" || view.kind === "finished" ? view.handle.jobId : null
  return { view, accept, start, cancel, delivered: jobId !== null && delivered === jobId }
}

const deliveredSchema = z.object({ jobId: z.string(), artifacts: z.array(z.string()).optional() })
