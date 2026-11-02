import { useEffect, useRef } from "react"

export interface MeterSource {
  media: HTMLMediaElement
}

const SCALE = [0, -6, -12, -24, -36, -60]
const FLOOR = -60

// One AudioContext/graph per media element (createMediaElementSource may only be called once).
const graphs = new WeakMap<HTMLMediaElement, { ctx: AudioContext; left: AnalyserNode; right: AnalyserNode }>()

function graphFor(media: HTMLMediaElement): { ctx: AudioContext; left: AnalyserNode; right: AnalyserNode } {
  let g = graphs.get(media)
  if (!g) {
    const ctx = new AudioContext()
    const src = ctx.createMediaElementSource(media)
    const split = ctx.createChannelSplitter(2)
    const left = ctx.createAnalyser()
    const right = ctx.createAnalyser()
    left.fftSize = right.fftSize = 1024
    src.connect(split)
    split.connect(left, 0)
    split.connect(right, 1)
    src.connect(ctx.destination)
    g = { ctx, left, right }
    graphs.set(media, g)
  }
  return g
}

function toPos(db: number): number {
  return Math.min(1, Math.max(0, (db - FLOOR) / -FLOOR))
}

/** Stereo peak meter (L/R) with hold, styled like the mockup. */
export function LevelMeter({ source }: { source: MeterSource | null }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!source) return
    const g = graphFor(source.media)
    const resume = (): void => void g.ctx.resume()
    source.media.addEventListener("play", resume)
    const buf = new Float32Array(g.left.fftSize)
    const level = [FLOOR, FLOOR]
    const hold = [FLOOR, FLOOR]
    const holdAt = [0, 0]
    let raf = 0
    const draw = (now: number): void => {
      const c = canvas.current
      if (c) {
        const dpr = window.devicePixelRatio || 1
        const w = c.clientWidth
        const h = c.clientHeight
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
          c.width = Math.round(w * dpr)
          c.height = Math.round(h * dpr)
        }
        const x = c.getContext("2d")!
        x.setTransform(dpr, 0, 0, dpr, 0, 0)
        x.clearRect(0, 0, w, h)
        const barW = 9
        const top = 6
        const bottom = h - 16
        ;[g.left, g.right].forEach((an, i) => {
          an.getFloatTimeDomainData(buf)
          let peak = 0
          for (let k = 0; k < buf.length; k++) peak = Math.max(peak, Math.abs(buf[k]))
          const db = source.media.paused ? FLOOR : 20 * Math.log10(Math.max(peak, 1e-6))
          level[i] = db > level[i] ? db : Math.max(FLOOR, level[i] - 1.2)
          if (level[i] >= hold[i] || now - holdAt[i] > 900) {
            hold[i] = level[i]
            holdAt[i] = now
          }
          const bx = 4 + i * (barW + 8)
          x.fillStyle = "#060a0b"
          x.fillRect(bx, top, barW, bottom - top)
          const grad = x.createLinearGradient(0, bottom, 0, top)
          grad.addColorStop(0, "#0f92d9")
          grad.addColorStop(0.55, "#33d5ff")
          grad.addColorStop(0.85, "#4af6ff")
          grad.addColorStop(1, "#a8fbff")
          const fill = toPos(level[i]) * (bottom - top)
          x.fillStyle = grad
          x.fillRect(bx, bottom - fill, barW, fill)
          const hy = bottom - toPos(hold[i]) * (bottom - top)
          x.fillStyle = hold[i] > -0.5 ? "#ff4d4d" : "#a8f2ff"
          x.fillRect(bx, hy - 1, barW, 2)
          x.fillStyle = "#769ca3"
          x.font = "10px Inter Variable, sans-serif"
          x.textAlign = "center"
          x.fillText(i === 0 ? "L" : "R", bx + barW / 2, h - 3)
        })
        x.textAlign = "left"
        for (const db of SCALE) {
          const y = bottom - toPos(db) * (bottom - top)
          x.fillStyle = "#58787d"
          x.fillText(String(db), 40, y + 3)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      source.media.removeEventListener("play", resume)
    }
  }, [source])

  return <canvas ref={canvas} className="h-full w-[64px] shrink-0" />
}
