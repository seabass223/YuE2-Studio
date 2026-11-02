import { useEffect, useRef } from "react"
import { COLUMN_WIDTH, columnsFromPeaks, paintWave, type WaveTone } from "@/lib/wave"
import { cn } from "@/lib/utils"

/** Mirrored mini waveform drawn from the sidecar's peak envelope. */
export function MiniWave({ peaks, className, active, progress }: { peaks: number[]; className?: string; active?: boolean; progress?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const tone: WaveTone = active ? "warm" : "dull"
    const toneAt = progress === undefined ? undefined : (frac: number): WaveTone => (frac <= progress ? "bright" : tone)
    // Fires once on observe too: cards are laid out late (the Generate view can be hidden) and stretch with the window.
    const observer = new ResizeObserver(() => {
      if (!c.clientWidth) return
      paintWave(c, columnsFromPeaks(peaks, Math.max(1, Math.round(c.clientWidth / COLUMN_WIDTH))), tone, { toneAt, headroom: 0.96 })
    })
    observer.observe(c)
    return () => observer.disconnect()
  }, [peaks, active, progress])
  return <canvas ref={ref} className={cn("h-8 w-full", className)} />
}
