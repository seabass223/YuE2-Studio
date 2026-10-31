export type Cot = "full" | "melody" | "off"

export const SECTION_LABELS = [
  "intro",
  "verse",
  "pre-chorus",
  "chorus",
  "bridge",
  "interlude",
  "instrumental",
  "outro",
  "silence",
] as const
export type SectionLabel = (typeof SECTION_LABELS)[number]
export type Meter = "4/4" | "3/4"
/** Every key the backend accepts (up to 7 sharps or flats), by pitch; enharmonic spellings side by side. */
export const MAJOR_KEYS = ["C", "C#", "Db", "D", "Eb", "E", "F", "F#", "Gb", "G", "Ab", "A", "Bb", "B", "Cb"] as const
export const MINOR_KEYS = ["Cm", "C#m", "Dm", "D#m", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Abm", "Am", "A#m", "Bbm", "Bm"] as const
export const KEY_HINT = "Auto lets YuE2 choose; it nearly always picks E or A minor. Pick a key to vary the harmony."

export interface Section {
  id: string
  label: SectionLabel
  bars: number
  /** Extra style text used only for this section (rendered separately when `strict`). */
  description?: string
}

export interface Timeline {
  bpm: number
  meter: Meter
  sections: Section[]
  /** Render each section separately so boundaries land exactly on the bar grid. */
  strict?: boolean
}

export const beatsPerBar = (meter: Meter) => (meter === "3/4" ? 3 : 4)
export const timelineBars = (t: Timeline) => t.sections.reduce((sum, s) => sum + s.bars, 0)
export const timelineSeconds = (t: Timeline) => (timelineBars(t) * beatsPerBar(t.meter) * 60) / t.bpm
/** The key to send: a custom score sets its own key, and without planning there is no score to set it on. */
export const effectiveKey = (p: GenerateParams) => (p.abc.trim() || p.cot === "off" ? null : p.key)
export const newSectionId = () => Math.random().toString(36).slice(2, 10)

export interface GenerateParams {
  style: string
  lyrics: string
  instrumental: boolean
  timeline: Timeline
  /** The song's key ("A", "F#m", ...); null = YuE2 picks. Applies to every planned score. */
  key: string | null
  cot: Cot
  seed: number | null
  max_seconds: number
  cfg_scale: number | null
  temperature: number
  top_p: number
  top_k: number
  repetition_penalty: number
  ode_steps: number
  abc: string
  /** Instrumentals: listen for stray singing and re-render the part that has it (up to 2 times). */
  vocal_check: boolean
}

export interface Track {
  id: string
  created: string
  duration: number
  truncated: boolean
  seconds_taken: number
  has_score: boolean
  params: Omit<GenerateParams, "timeline" | "key"> & {
    seed: number
    key?: string | null
    timeline?: {
      bpm: number
      meter: Meter
      key?: string | null
      strict?: boolean
      sections: { label: SectionLabel; bars: number; description?: string }[]
    } | null
  }
}

export interface Job {
  id: string
  state: "queued" | "running" | "done" | "error" | "cancelled"
  stage: string
  completed: number
  total: number | null
  unit: string | null
  audio_seconds: number
  max_seconds: number
  elapsed: number
  error: string | null
  track: Track | null
  part: string | null
  /** "mcp" when another app requested it; the studio then leaves playback to that app. */
  source: "studio" | "mcp"
  /** "transcribe": Import from audio, which shares the one job slot so it never overlaps a song. */
  kind: "song" | "transcribe"
  result: Transcription | null
}

/** Import from audio: SheetSage2's melody-only score for a recording. */
export interface Transcription {
  abc: string
  name: string
  duration: number
  /** Only the first 6:00 (YuE2's longest song) was transcribed. */
  truncated: boolean
  warnings: string[]
  /** Folder under imports\ with SheetSage2's score, MIDI and annotations. */
  folder: string
}

export interface Snapshot {
  status: "starting" | "downloading" | "loading" | "ready" | "error"
  detail: string
  gpu: { name: string; total_gib: number; used_gib: number; last_peak_gib: number | null } | null
  job: Job | null
  /** SheetSage2 is installed (Install.cmd adds it). */
  audio_import: boolean
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let message = res.statusText
    try {
      message = (await res.json()).detail ?? message
    } catch {
      /* not JSON */
    }
    throw new Error(message)
  }
  return res.json()
}

export const api = {
  generate: (params: GenerateParams) =>
    request<Job>("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }),
  /** Import from audio: uploads the file and starts transcribing it to a melody score. */
  transcribe: (file: File) =>
    request<Job>(`/api/transcribe?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }),
  cancel: () => request("/api/cancel", { method: "POST" }),
  tracks: () => request<Track[]>("/api/tracks"),
  deleteTrack: (id: string) => request(`/api/tracks/${id}`, { method: "DELETE" }),
  audioUrl: (id: string) => `/api/tracks/${id}/audio.flac`,
  downloadUrl: (id: string) => `/api/tracks/${id}/audio.flac?download=true`,
  mp3Url: (id: string) => `/api/tracks/${id}/audio.mp3`,
  scoreUrl: (id: string) => `/api/tracks/${id}/score.abc`,
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

/** Like formatTime, with tenths when the length isn't a whole second (e.g. 1:07.5). */
export function formatLength(seconds: number) {
  const tenths = Math.round(seconds * 10) % 10
  return formatTime(seconds) + (tenths ? `.${tenths}` : "")
}
