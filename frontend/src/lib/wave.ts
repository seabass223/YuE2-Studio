// Waveform painter shared by the editor and the take/library cards. Spikes are rasterised per pixel
// so each one can run from a hot core at the centre line to a faded tip, then bloomed like the mockup.

export type WaveTone = "dull" | "warm" | "bright"

/** CSS pixels per column: spikes this far apart read as fine hair. */
export const COLUMN_WIDTH = 1.25

/** One entry per painted column, all 0..1 of the available half height. */
export interface WaveColumns {
  /** Spike height above the centre line. */
  up: Float32Array
  /** Spike height below the centre line. */
  down: Float32Array
  /** 0..1 per column: lower shifts it along the colour ramp, so the wave has streaks instead of one flat colour. */
  shade: Float32Array
}

// Colour by distance from the centre line, as a fraction of the available height (s, r, g, b). Measured
// off the mockup: the core stays one width wherever the spikes reach, so colour doesn't scale with them.
const STOPS: Record<WaveTone, [number, number, number, number][]> = {
  dull: [
    [0, 48, 147, 210],
    [0.1, 43, 135, 192],
    [0.2, 36, 117, 170],
    [0.3, 32, 103, 150],
    [0.5, 28, 89, 130],
    [1, 26, 81, 118]
  ],
  warm: [
    [0, 76, 204, 250],
    [0.15, 62, 181, 234],
    [0.3, 52, 156, 210],
    [0.5, 46, 135, 186],
    [1, 40, 116, 160]
  ],
  bright: [
    [0, 118, 238, 255],
    [0.08, 100, 226, 253],
    [0.2, 84, 209, 250],
    [0.4, 68, 180, 232],
    [1, 54, 151, 205]
  ]
}

// Opacity by distance from the centre line to the local envelope (t, a): spikes fade out at their tips.
const FADE: [number, number][] = [
  [0, 1],
  [0.45, 1],
  [0.55, 0.92],
  [0.68, 0.75],
  [0.82, 0.5],
  [1, 0.18]
]

const BLOOM: Record<WaveTone, { blur: number; alpha: number }[]> = {
  dull: [{ blur: 2.5, alpha: 0.2 }],
  warm: [{ blur: 2.5, alpha: 0.4 }],
  bright: [
    { blur: 9, alpha: 0.28 },
    { blur: 2.5, alpha: 0.5 }
  ]
}

export function ramp(stops: number[][], t: number, channel: number): number {
  let k = 0
  while (k < stops.length - 2 && t > stops[k + 1][0]) k++
  const a = stops[k]
  const b = stops[k + 1]
  const f = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])))
  return a[channel] + (b[channel] - a[channel]) * f
}

const luts = new Map<WaveTone, Uint8ClampedArray>()

function colorLut(tone: WaveTone): Uint8ClampedArray {
  let lut = luts.get(tone)
  if (lut) return lut
  lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = ramp(STOPS[tone], i / 255, c + 1)
  }
  luts.set(tone, lut)
  return lut
}

const fadeLut = Uint8ClampedArray.from({ length: 256 }, (_, i) => ramp(FADE, i / 255, 1) * 255)

// The slow loudness envelope is compressed for display (fine detail is not), so ambience reads as a
// dense mass next to transients instead of a thin line. Silence stays flat.
const BASE_LEVEL = 0.32
const COMPRESS = 0.22
const GATE_LOW = 0.0001
const GATE_HIGH = 0.005
const ENVELOPE_COLUMNS = 7
// Cards are how sounds get told apart at a glance, so they keep more of the real dynamics. They only
// have a coarse peak envelope: a narrower window keeps the gaps between hits from collapsing.
const CARD_COMPRESS = 0.34
const CARD_ENVELOPE_COLUMNS = 3
// Spikes take their height from a few samples only: short windows vary from column to column, which
// gives noise its hair. A full-column peak would flatten it into a solid band.
const HAIR_SAMPLES = 5
const FINE_SAMPLES = 24
// Columns this far above their surroundings are real transients and rise towards their true peak.
const CREST_LOW = 4
const CREST_HIGH = 7
const TRANSIENT_KEEP = 0.4
// How far the darkest streak moves along the colour ramp.
const STREAK = 0.45
// Neighbouring columns on each side that share one fade, so a cluster of spikes tapers together.
const FADE_COLUMNS = 4
// Horizontal oversampling, so the sloped sides of the spikes come out smooth.
const SUPERSAMPLE = 3

/** Column data before the display curve. */
interface RawColumns {
  peakUp: Float32Array
  peakDown: Float32Array
  hairUp: Float32Array
  hairDown: Float32Array
  /** Column loudness. */
  level: Float32Array
  /** Short-window loudness, for the streaks. */
  fine: Float32Array
}

function rawColumns(columns: number): RawColumns {
  const make = (): Float32Array => new Float32Array(columns)
  return { peakUp: make(), peakDown: make(), hairUp: make(), hairDown: make(), level: make(), fine: make() }
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/** Applies the display curve. */
function shape(raw: RawColumns, compress = COMPRESS, smoothing = ENVELOPE_COLUMNS): WaveColumns {
  const n = raw.level.length
  const smooth = new Float32Array(n)
  let top = 1e-6
  for (let x = 0; x < n; x++) {
    let sum = 0
    let count = 0
    for (let i = Math.max(0, x - smoothing); i <= Math.min(n - 1, x + smoothing); i++) {
      sum += raw.level[i]
      count++
    }
    smooth[x] = sum / count
    top = Math.max(top, smooth[x])
  }
  const cols: WaveColumns = { up: new Float32Array(n), down: new Float32Array(n), shade: new Float32Array(n) }
  const spike = (hair: number, peak: number, level: number, keep: number): number => {
    // Exaggerate the spread around the column's loudness: short spikes shorter, tall ones taller.
    const ratio = hair / Math.max(level, 1e-7)
    const spiky = Math.max(level * 0.25, level * Math.pow(ratio, 1.5) * 0.62)
    return spiky + Math.max(0, peak - spiky) * keep * TRANSIENT_KEEP
  }
  for (let x = 0; x < n; x++) {
    const local = Math.max(smooth[x], 1e-7)
    const rel = local / top
    const gain = (BASE_LEVEL * Math.pow(rel, compress) * smoothstep(GATE_LOW, GATE_HIGH, rel)) / local
    const level = raw.level[x]
    const keep = smoothstep(CREST_LOW, CREST_HIGH, Math.max(raw.peakUp[x], raw.peakDown[x]) / local)
    cols.up[x] = Math.tanh(spike(raw.hairUp[x], raw.peakUp[x], level, keep) * gain)
    cols.down[x] = Math.tanh(spike(raw.hairDown[x], raw.peakDown[x], level, keep) * gain)
    cols.shade[x] = Math.min(1, raw.fine[x] / Math.max(level, 1e-7))
  }
  return cols
}

/** Columns from decoded audio: top half from the first channel, bottom half from the second. */
export function columnsFromAudio(channels: ArrayLike<number>[], columns: number): WaveColumns {
  const top = channels[0]
  const bottom = channels[channels.length > 1 ? 1 : 0]
  const raw = rawColumns(columns)
  const len = top.length
  for (let x = 0; x < columns; x++) {
    const a = Math.floor((x * len) / columns)
    const b = Math.min(len, Math.max(a + 1, Math.floor(((x + 1) * len) / columns)))
    const n = b - a
    if (n <= 0) continue
    let pos = 0
    let neg = 0
    let sum = 0
    for (let i = a; i < b; i++) {
      const t = top[i]
      const r = bottom[i]
      if (t > pos) pos = t
      if (-r > neg) neg = -r
      sum += t * t + r * r
    }
    // Sample the short windows at different offsets so the two halves don't mirror each other.
    const hairSpan = Math.min(n, HAIR_SAMPLES)
    const hairMid = a + ((n - hairSpan) >> 1)
    let hairUp = 0
    let hairDown = 0
    for (let i = 0; i < hairSpan; i++) {
      hairUp = Math.max(hairUp, Math.abs(top[a + i]))
      hairDown = Math.max(hairDown, Math.abs(bottom[hairMid + i]))
    }
    const fineSpan = Math.min(n, FINE_SAMPLES)
    let fine = 0
    for (let i = 0; i < fineSpan; i++) fine += top[a + i] * top[a + i]
    raw.peakUp[x] = pos
    raw.peakDown[x] = neg
    raw.hairUp[x] = hairUp
    raw.hairDown[x] = hairDown
    raw.level[x] = Math.sqrt(sum / (2 * n))
    raw.fine[x] = Math.sqrt(fine / fineSpan)
  }
  return shape(raw)
}

// Stable pseudo-random 0..1 per column, for cards: the sidecar only stores a coarse peak envelope.
function jitter(i: number): number {
  const v = Math.sin(i * 12.9898) * 43758.5453
  return v - Math.floor(v)
}

/** Columns from the sidecar"s peak envelope (cards don"t have the audio decoded). */
export function columnsFromPeaks(peaks: number[], columns: number): WaveColumns {
  const n = peaks.length
  // No envelope on file: zero columns paint nothing.
  const raw = rawColumns(n ? columns : 0)
  for (let x = 0; x < raw.level.length; x++) {
    const a = Math.floor((x * n) / columns)
    const b = Math.max(a + 1, Math.floor(((x + 1) * n) / columns))
    let peak = 0
    for (let i = a; i < b && i < n; i++) peak = Math.max(peak, peaks[i] ?? 0)
    raw.peakUp[x] = peak
    raw.peakDown[x] = peak
    raw.hairUp[x] = peak * (0.3 + 0.7 * Math.pow(jitter(x), 1.6))
    raw.hairDown[x] = peak * (0.3 + 0.7 * Math.pow(jitter(x + 503), 1.6))
    raw.level[x] = peak * 0.36
    raw.fine[x] = peak * 0.36 * (0.5 + jitter(x + 1009))
  }
  return shape(raw, CARD_COMPRESS, CARD_ENVELOPE_COLUMNS)
}

/** Local envelope over a few neighbouring columns, so a cluster of spikes shares one gradient. */
function envelope(h: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(h.length)
  for (let x = 0; x < h.length; x++) {
    let m = 0
    for (let i = Math.max(0, x - radius); i <= Math.min(h.length - 1, x + radius); i++) m = Math.max(m, h[i])
    out[x] = Math.max(m, 1e-3)
  }
  return out
}

export interface PaintOptions {
  /** Pick the tone per column (card playback progress). */
  toneAt?: (frac: number) => WaveTone
  /** Fraction of the half height the tallest spike may use. */
  headroom?: number
}

/** Fits the canvas to its CSS size and paints the columns on it, bloom included. */
export function paintWave(canvas: HTMLCanvasElement, cols: WaveColumns, tone: WaveTone, opts: PaintOptions = {}): void {
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(canvas.clientWidth * dpr)
  const h = Math.round(canvas.clientHeight * dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext("2d")
  if (!ctx || !w || !h) return
  ctx.clearRect(0, 0, w, h)
  const count = cols.up.length
  if (!count) return

  const sw = w * Math.max(1, Math.round(SUPERSAMPLE / dpr))
  const off = document.createElement("canvas")
  off.width = sw
  off.height = h
  const octx = off.getContext("2d")!
  const img = octx.createImageData(sw, h)
  const data = img.data
  const mid = h >> 1
  const amp = (h / 2) * (opts.headroom ?? 0.82)
  const envUp = envelope(cols.up, FADE_COLUMNS)
  const envDown = envelope(cols.down, FADE_COLUMNS)
  const { toneAt } = opts

  const paintSide = (x: number, height: number, envPx: number, shift: number, dir: number, lut: Uint8ClampedArray): void => {
    const full = Math.ceil(height)
    for (let d = 0; d < full; d++) {
      const y = dir < 0 ? mid - 1 - d : mid + d
      if (y < 0 || y >= h) break
      const li = Math.min(255, Math.round((d / amp + shift) * 255)) * 3
      const i = (y * sw + x) * 4
      data[i] = lut[li]
      data[i + 1] = lut[li + 1]
      data[i + 2] = lut[li + 2]
      data[i + 3] = fadeLut[Math.min(255, Math.round((d / envPx) * 255))] * Math.min(1, height - d)
    }
  }

  const base = colorLut(tone)
  const last = count - 1
  for (let x = 0; x < sw; x++) {
    // Heights run in straight lines between columns: spikes taper to a point instead of ending flat.
    const pos = ((x + 0.5) / sw) * last
    const c = Math.floor(pos)
    const next = Math.min(last, c + 1)
    const f = pos - c
    const lut = toneAt ? colorLut(toneAt(x / sw)) : base
    const up = Math.max(1, (cols.up[c] + (cols.up[next] - cols.up[c]) * f) * amp)
    const down = Math.max(1, (cols.down[c] + (cols.down[next] - cols.down[c]) * f) * amp)
    const shift = (1 - cols.shade[f < 0.5 ? c : next]) * STREAK
    paintSide(x, up, Math.max(up, envUp[c] * amp), shift, -1, lut)
    paintSide(x, down, Math.max(down, envDown[c] * amp), shift, 1, lut)
  }
  octx.putImageData(img, 0, 0)

  // Bloom goes under the core, so the core keeps its exact colour instead of washing out.
  ctx.save()
  for (const pass of BLOOM[tone]) {
    ctx.globalAlpha = pass.alpha
    ctx.filter = `blur(${pass.blur * dpr}px)`
    ctx.drawImage(off, 0, 0, w, h)
  }
  ctx.globalAlpha = 1
  ctx.filter = `blur(${0.35 * dpr}px)`
  ctx.drawImage(off, 0, 0, w, h)
  ctx.restore()
}
