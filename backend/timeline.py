"""Instrumentals laid out on a user timeline: BPM, meter and labeled sections of whole bars.

YuE2 still writes the score with its own sampler; the timeline puts it on rails:
  * the header (meter, unit length, tempo, voices) is written for it; it only picks the key,
  * every group starts with forced "V: Vocal"/"V: Ins" lines, and each section's label is
    forced at its first bar,
  * a Vocal line is cut off when it reaches the section's remaining bars (at most 4), and the Ins
    line is held to exactly the same bar count, so no phrase straddles a section boundary,
  * "silence" sections are written as full-bar rests in both voices,
  * the score ends right after the last section's final bar.
Afterwards the melody moves to the instrument voice (YuE2's instrumental recipe), silence bars
lose their chord symbols, and the length is exactly bars x beats / BPM.
"""
from __future__ import annotations

import dataclasses
import math
import re

import torch

import fitted
from fitted import _bars_in, clean_abc, convert_score, parse_abc
from compile_score import SECTIONS
from yue2.protocol import ABC_END, EOD, SongRequest, token_prefixes

# YuE2 itself writes "% silence"; the vendored converter just doesn't list it.
SECTIONS.add("silence")
LABELS = ("intro", "verse", "pre-chorus", "chorus", "bridge", "interlude", "instrumental", "outro", "silence")
METERS = {"4/4": (4, 4), "3/4": (3, 4)}
MAX_SECONDS = 360  # 9000 song tokens
# The header is written for the model except two values it picks itself: the note unit (it
# chooses the grid that matches the rhythm it has in mind) and the key. None = model writes a line.
HEADER = ["X:1\nT:\nM:{meter}\nL:1/", None, "Q:1/4={bpm}\n"
          'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"\n'
          'V: Ins clef=treble name="Ins Melody" snm="Inst."\nK:', None]


@dataclasses.dataclass
class Timeline:
    bpm: int
    meter: str
    sections: list  # [(label, bars)]
    descriptions: list = dataclasses.field(default_factory=list)  # per-section style text ("" = none)
    strict: bool = True  # render each section separately so boundaries land exactly

    @classmethod
    def parse(cls, raw):
        if not isinstance(raw, dict):
            raise ValueError("timeline must be an object")
        bpm = int(raw.get("bpm", 0))
        if not 40 <= bpm <= 240:
            raise ValueError("BPM must be between 40 and 240")
        meter = raw.get("meter", "4/4")
        if meter not in METERS:
            raise ValueError("Meter must be 4/4 or 3/4")
        sections, descriptions = [], []
        for item in raw.get("sections") or []:
            label, bars = str(item.get("label", "")).lower(), int(item.get("bars", 0))
            if label not in LABELS:
                raise ValueError(f"Unknown section label: {label}")
            if not 1 <= bars <= 64:
                raise ValueError("Each section must be 1-64 bars")
            sections.append((label, bars))
            descriptions.append(" ".join(str(item.get("description") or "").split())[:300])
        if not sections:
            raise ValueError("Add at least one section")
        if all(label == "silence" for label, _ in sections):
            raise ValueError("The timeline needs at least one non-silent section")
        timeline = cls(bpm, meter, sections, descriptions, bool(raw.get("strict", True)))
        if timeline.seconds > MAX_SECONDS:
            raise ValueError(f"The timeline is {timeline.seconds:.0f} s; the maximum is {MAX_SECONDS} s")
        return timeline

    @property
    def bar_quarters(self):
        n, d = METERS[self.meter]
        return 4 * n / d

    @property
    def bars(self):
        return sum(bars for _, bars in self.sections)

    @property
    def seconds(self):
        return self.bars * self.bar_quarters * 60 / self.bpm

    def planning_lyrics(self):
        tags = [label for i, (label, _) in enumerate(self.sections) if i == 0 or label != self.sections[i - 1][0]]
        return "\n\n".join("[" + label.title() + "]" for label in tags) + "\n"

    def to_dict(self):
        descriptions = self.descriptions or [""] * len(self.sections)
        return {"bpm": self.bpm, "meter": self.meter, "strict": self.strict,
                "sections": [{"label": label, "bars": bars, "description": text}
                             for (label, bars), text in zip(self.sections, descriptions)]}

    def section_seconds(self, bars):
        return bars * self.bar_quarters * 60 / self.bpm


class Rails:
    """State machine that decides what is forced, masked and cut while YuE2 writes the score."""

    def __init__(self, timeline: Timeline):
        self.timeline = timeline
        self.sections = [[label, bars, 0] for label, bars in timeline.sections]
        self.index = 0
        self.state = "header"  # header -> group -> vocal -> vocal_done -> ins -> group ... -> done
        self.header = list(HEADER)
        self.line = ""
        self.target = 0

    @property
    def bars_done(self):
        return sum(done for _, _, done in self.sections)

    def next_forced(self):
        """Text to force now, or None to let the model sample. 'END' closes the score."""
        if self.state == "header":
            if not self.header:
                self.state = "group"
            elif self.header[0] is None:  # the model writes the rest of this line
                return None
            else:
                return self.header.pop(0).format(meter=self.timeline.meter, bpm=self.timeline.bpm)
        if self.state == "group":
            while self.index < len(self.sections) and self.sections[self.index][2] >= self.sections[self.index][1]:
                self.index += 1
            if self.index == len(self.sections):
                self.state = "done"
                return "END"
            label, bars, done = self.sections[self.index]
            prefix = f"% {label}\n" if done == 0 else ""
            n = min(4, bars - done)
            if label == "silence":
                rest = "Z" if n == 1 else f"Z{n}"
                self.sections[self.index][2] += n
                return prefix + f"V: Vocal\n{rest}|\nV: Ins\n{rest}|\n"
            self.state, self.target, self.line = "vocal", n, ""
            return prefix + "V: Vocal\n"
        if self.state == "vocal_done":
            self.state, self.line = "ins", ""
            return "V: Ins\n"
        return None

    def rewrite(self, text):
        """Cut a sampled token at the bar line that completes the current line."""
        if self.state not in ("vocal", "ins"):
            return text
        out = ""
        for ch in text:
            if ch == "\n" and self.state == "ins":  # the Ins line must match the Vocal line's bars
                return out
            out += ch
            if ch == "|" and _bars_in(self.line + out) >= self.target:
                return out + "\n"
            if ch == "\n":
                return out
        return out

    def feed(self, text):
        """Model-written text (after rewrite)."""
        self.line += text
        if "\n" not in text:
            return
        line = self.line.split("\n", 1)[0].strip()
        if self.state == "header":
            self.header.pop(0)
        elif self.state == "vocal":
            self.target = max(1, _bars_in(line))  # the Ins line must match the Vocal line
            self.state = "vocal_done"
        elif self.state == "ins":
            self.sections[self.index][2] += _bars_in(line)
            self.state = "group"
        self.line = ""

    def complete_bars(self):
        cut = self.line.rfind("|")
        return _bars_in(self.line[:cut + 1]) if cut >= 0 else 0


class TokenSets:
    """Token-id groups used for masking, computed once per tokenizer."""

    def __init__(self, tokenizer, device):
        newline, pipe_newline, start_newline, pipe, not_music = [], [], [], [], []
        music_start = set('zZABCDEFGabcdefg"^_=')
        for i in range(EOD):
            text = tokenizer._enc.decode_single_token_bytes(i).decode("utf-8", "ignore")
            if text.lstrip(" \t").startswith("|"):
                pipe.append(i)
            if not text or text[0] not in music_start:
                not_music.append(i)
            if "\n" in text:
                newline.append(i)
                if "|" in text and text.index("|") < text.index("\n"):
                    pipe_newline.append(i)
                if text.lstrip(" \t").startswith("\n"):
                    start_newline.append(i)
        as_tensor = lambda ids: torch.tensor(ids, dtype=torch.long, device=device)  # noqa: E731
        self.newline = as_tensor(newline)
        self.pipe = as_tensor(pipe)  # a bar line with nothing before it on the line
        # A music line must start with a note, rest, chord symbol or accidental. This rules out
        # meter/key changes (M:, K:), which would break the timeline's fixed timing.
        self.not_music = as_tensor(not_music)
        self.newline_not_after_bar = as_tensor(sorted(set(newline) - set(pipe_newline)))
        self.newline_mid_line = as_tensor(sorted(set(newline) - set(pipe_newline) - set(start_newline)))
        self.digits = {d: tokenizer.encode(str(d))[0] for d in range(10)}


_token_sets = {}


@torch.inference_mode()
def plan_score(pipe, request: SongRequest, timeline: Timeline, *, cancelled=None):
    """Sample a score that follows the timeline exactly. Returns (abc, info)."""
    import yue2.cuda_graph as cuda_graph
    from yue2.sampling import distribution

    tokenizer = pipe.tokenizer
    model = pipe._load_model()
    if pipe.device not in _token_sets:
        _token_sets[pipe.device] = TokenSets(tokenizer, pipe.device)
    sets = _token_sets[pipe.device]
    sampling = dataclasses.replace(pipe.generation_config.abc, max_tokens=fitted.ABC_BUDGET, min_tokens=0)
    generator = torch.Generator(device=pipe.device).manual_seed(request.seed)
    rails = Rails(timeline)
    ids, queue = [], []
    graph = cuda_graph.GraphAR(model, [token_prefixes(request, tokenizer)], sampling.max_tokens)
    seconds_per_bar = timeline.bar_quarters * 60 / timeline.bpm
    with pipe._status("Planning score", total=int(math.ceil(timeline.seconds)), unit="s") as stage:
        try:
            logits = graph.prefill()[:1]
            for step in range(sampling.max_tokens - 1):
                if cancelled is not None and cancelled():
                    raise InterruptedError("Cancelled during score planning")
                if not queue:
                    forced = rails.next_forced()
                    if forced == "END":
                        break
                    if forced is not None:
                        queue = tokenizer.encode(forced)
                if queue:  # forced text, or the rest of a cut token (rails already know about both)
                    token = queue.pop(0)
                else:
                    logits = logits.clone()
                    logits[..., ABC_END] = -torch.inf
                    if rails.state in ("vocal", "ins") and not rails.line:  # a line starts with music
                        logits[..., sets.not_music] = -torch.inf
                    elif rails.state == "ins":
                        # "|\n" stays allowed (it is how a line's last bar naturally closes); the
                        # rewrite drops the newline if the line still needs more bars.
                        logits[..., sets.newline_not_after_bar] = -torch.inf
                    elif rails.state == "vocal":
                        allowed_end = rails.line.endswith("|")
                        logits[..., sets.newline_mid_line if allowed_end else sets.newline_not_after_bar] = -torch.inf
                    rest = re.search(r"(?:^|\|)Z(\d?)$", rails.line) if rails.state in ("vocal", "ins") else None
                    if rest:  # a full-bar rest: only a count that fits, then the bar line
                        allowed = torch.zeros(logits.shape[-1], dtype=torch.bool, device=logits.device)
                        allowed[sets.pipe] = True
                        if not rest.group(1):
                            room = rails.target - rails.complete_bars()
                            for digit in range(2, min(4, room) + 1):
                                allowed[sets.digits[digit]] = True
                        logits[..., ~allowed] = -torch.inf
                    scores = distribution(logits, sampling, ids, step, "abc")
                    token = int(torch.multinomial(scores.softmax(-1), 1, generator=generator).item())
                    text = tokenizer._enc.decode_single_token_bytes(token).decode("utf-8", "replace")
                    rewritten = rails.rewrite(text)
                    rails.feed(rewritten)
                    if rewritten != text:
                        queue = tokenizer.encode(rewritten)
                        token = queue.pop(0)
                ids.append(token)
                stage.update(min(int(rails.bars_done * seconds_per_bar), int(timeline.seconds)))
                logits = graph.step(token)[:1]
            else:
                raise ValueError("The score did not fit in the planning budget; try fewer bars")
        finally:
            graph.close()
    return tokenizer.decode(ids), {"timeline": timeline.to_dict(), "score_tokens": len(ids)}


def _rest_line(line):
    n = _bars_in(line)
    return ("Z" if n == 1 else f"Z{n}") + "|"


def silence_bars(abc):
    """Replace the content of every line in a '% silence' section with full-bar rests (no chords)."""
    out, section, music_next = [], None, False
    for line in abc.splitlines():
        if line.startswith("% "):
            section = line[2:].strip()
        elif line in ("V: Vocal", "V: Ins"):
            music_next = True
        elif music_next and not line.startswith(("M:", "K:")):
            music_next = False
            if section == "silence":
                line = _rest_line(line)
        out.append(line)
    return "\n".join(out) + "\n"


def section_bars(abc):
    """[(label, bars)] in score order, merging consecutive groups of one section."""
    result, section, music_next, voice = [], None, False, None
    for line in abc.splitlines():
        if line.startswith("% "):
            section = line[2:].strip()
            result.append([section, 0])
        elif line in ("V: Vocal", "V: Ins"):
            voice, music_next = line[3:], True
        elif music_next and not line.startswith(("M:", "K:")):
            music_next = False
            if voice == "Ins" and result:
                result[-1][1] += _bars_in(line)
    merged = []
    for label, bars in result:
        if merged and merged[-1][0] == label:
            merged[-1][1] += bars
        else:
            merged.append([label, bars])
    return [tuple(x) for x in merged]


def _bar_list(line):
    bars = []
    for bar in line.strip().rstrip("|").split("|"):
        rest = re.fullmatch(r"\s*Z([2-4])?\s*", bar)
        bars += ["Z"] * int(rest.group(1) or 1) if rest else [bar.strip()]
    return bars


def _score_bars(abc):
    """(header lines, Vocal bars, Ins bars) with multi-bar rests expanded to single bars."""
    lines = abc.splitlines()
    key_line = next(i for i, line in enumerate(lines) if line.startswith("K:"))
    bars = {"Vocal": [], "Ins": []}
    voice, music_next = None, False
    for line in lines[key_line + 1:]:
        if line in ("V: Vocal", "V: Ins"):
            voice, music_next = line[3:], True
        elif music_next and not line.startswith(("%", "M:", "K:")):
            bars[voice].extend(_bar_list(line))
            music_next = False
    return lines[:key_line + 1], bars["Vocal"], bars["Ins"]


def bar_labels(timeline: Timeline):
    return [label for label, count in timeline.sections for _ in range(count)]


def slice_score(abc, timeline: Timeline, start, end):
    """A self-contained score for bars [start, end), keeping each bar's section label."""
    from compile_score import compress
    header, vocal, ins = _score_bars(abc)
    labels = bar_labels(timeline)
    if not len(vocal) == len(ins) == len(labels):
        raise ValueError("Score bars do not match the timeline")
    body, bar = [], start
    while bar < end:
        run = bar
        while run < end and labels[run] == labels[bar]:
            run += 1
        body.append(f"% {labels[bar]}")
        for group in range(bar, run, 4):
            stop = min(group + 4, run)
            body += ["V: Vocal", compress(vocal[group:stop]), "V: Ins", compress(ins[group:stop])]
        bar = run
    text = untie_into_rests("\n".join(header + body) + "\n")
    if len(parse_abc(text).voices["Ins"].bars) != end - start:
        raise ValueError("Score slice has the wrong bar count")
    return text


LEAD_BARS = 2  # bars of already-written song tokens each section continues from
LOOKAHEAD_BARS = 1  # bars of the next section shown in the score, so a section doesn't wind down


def section_spans(timeline: Timeline):
    """[(label, start, end)] in seconds, on the 25 tokens/s grid that sections are written on."""
    seconds_per_bar = timeline.bar_quarters * 60 / timeline.bpm
    spans, bar = [], 0
    for label, count in timeline.sections:
        spans.append((label, round(bar * seconds_per_bar * 25) / 25, round((bar + count) * seconds_per_bar * 25) / 25))
        bar += count
    return spans


@torch.inference_mode()
def chain_song_tokens(pipe, timeline: Timeline, abc, *, style, cot, seed, cfg_scale, sampling,
                      cancelled=None, on_section=None, tokens=None, first=0, attempt=0):
    """Write the song's tokens one section at a time, each held to exactly its length.

    Section k is prompted with the score of [2 lead-in bars + its bars + 1 lookahead bar] and
    continues from the song tokens already written for those lead-in bars, so it starts exactly
    at its downbeat in the same sound. Its own style text is added to the global style here (the
    tokens carry it); the audio is then rendered from all tokens in one pass, so there are no
    joins in the audio. Given the tokens of an earlier pass, sections before `first` are kept and
    the rest are written again with new seeds (+1000 per attempt). Returns (codec tokens, report
    for the sections written)."""
    from yue2.protocol import CODEC_OFFSET, negative_prefix, resolve_sampling
    tokenizer = pipe.tokenizer
    seconds_per_bar = timeline.bar_quarters * 60 / timeline.bpm
    to_tokens = lambda bar: int(round(bar * seconds_per_bar * 25))  # noqa: E731  (25 tokens/s)
    previous = list(tokens or [])
    tokens, report, bar = [], [], 0
    descriptions = timeline.descriptions or [""] * len(timeline.sections)
    for index, ((label, count), text) in enumerate(zip(timeline.sections, descriptions)):
        start, end = bar, bar + count
        bar = end
        if index < first:
            continue
        if index == first:
            tokens = previous[:to_tokens(start)]
        last = index == len(timeline.sections) - 1
        lead = min(LEAD_BARS, start)
        ahead = 0 if last else min(LOOKAHEAD_BARS, timeline.bars - end)
        score = fitted.render_labels(slice_score(abc, timeline, start - lead, end + ahead))
        section_style = fitted.instrumental_style(style.strip().rstrip(".,") + (". " + text if text else ""))
        request = SongRequest(style=section_style, lyrics=fitted.lyric_tags(score), cot=cot,
                              seed=seed + index + 1000 * attempt, abc=score, cfg_scale=cfg_scale)
        abc_ids = tokenizer.encode(score)
        context = [t + CODEC_OFFSET for t in tokens[to_tokens(start - lead):to_tokens(start)]]
        prefix = token_prefixes(request, tokenizer, abc_ids) + context
        negative = negative_prefix(request, tokenizer, abc_ids) + context if request.guidance != 1 else None
        want = to_tokens(end) - to_tokens(start)
        # Inner sections run exactly to their boundary; the last may finish up to a second early.
        rules = resolve_sampling({**sampling, "max_tokens": want,
                                  "min_tokens": max(1, want - 25) if last else want},
                                 pipe.generation_config.semantic)
        if on_section is not None:
            on_section(index, label)
        new, _, truncated = pipe._generate(prefix, rules, request.seed, "semantic", negative=negative,
                                           cfg_scale=request.guidance, legacy_off=False, cancelled=cancelled)
        tokens += [int(t) - CODEC_OFFSET for t in new]
        report.append({"label": label, "bars": count, "style": section_style, "tokens": len(new),
                       "target_tokens": want, "hit_cap": bool(truncated)})
    return tokens, report


def silence_audio(audio, sample_rate, timeline: Timeline, fade_out=0.15, fade_in=0.03):
    """Make "silence" sections truly silent. YuE2 renders rest bars as quiet, not silent, and its
    timing runs within ~1% of the score, so bar positions are scaled by the observed drift."""
    import numpy as np
    seconds_per_bar = timeline.bar_quarters * 60 / timeline.bpm
    drift = len(audio) / sample_rate / timeline.seconds
    audio = audio.copy()
    gain = np.ones(len(audio), dtype=audio.dtype)
    bar = 0
    for label, bars in timeline.sections:
        if label == "silence":
            start = int(bar * seconds_per_bar * drift * sample_rate)
            end = min(len(audio), int((bar + bars) * seconds_per_bar * drift * sample_rate))
            out = min(start, int(fade_out * sample_rate))
            gain[start - out:start] = np.minimum(gain[start - out:start], np.linspace(1, 0, out, dtype=audio.dtype))
            gain[start:end] = 0
            back = min(len(audio) - end, int(fade_in * sample_rate))
            gain[end:end + back] = np.minimum(gain[end:end + back], np.linspace(0, 1, back, dtype=audio.dtype))
        bar += bars
    return audio * gain[:, None]


def untie_into_rests(abc):
    """Drop ties that run into a rest or off the end of the score. The forced silence bars and the
    final bar cut make these possible, and the parser (rightly) rejects them."""
    lines = abc.splitlines()
    last_line = {}  # voice -> index of its previous music line
    voice, music_next = None, False
    for i, line in enumerate(lines):
        if line in ("V: Vocal", "V: Ins"):
            voice, music_next = line[3:], True
            continue
        if not music_next or line.startswith(("M:", "K:", "%")):
            continue
        music_next = False
        lines[i] = re.sub(r"-\|(?=\s*(?:\"[^\"]*\")?[zZ])", "|", line)  # within the line
        previous = last_line.get(voice)
        if previous is not None and re.match(r'\s*(?:"[^"]*")?[zZ]', line):
            lines[previous] = re.sub(r"-\|$", "|", lines[previous])
        last_line[voice] = i
    for i in last_line.values():
        lines[i] = re.sub(r"-\|$", "|", lines[i])
    return "\n".join(lines) + "\n"


def finish_score(abc, timeline: Timeline, keep_chords):
    """Melody to the instrument voice, silent bars without harmony, and structure checks."""
    abc = clean_abc(abc)
    info = {}
    abc = untie_into_rests(abc)
    try:
        converted, check = convert_score(abc, keep_chords=keep_chords)
        info["vocal_notes_moved"] = check["vocal_notes_before"]
        abc = converted
    except Exception as exc:
        info["conversion_skipped"] = f"{type(exc).__name__}: {exc}"
    abc = silence_bars(abc)
    score = parse_abc(abc)
    want = [tuple(s) for s in timeline.sections]
    merged_want = []
    for label, bars in want:
        if merged_want and merged_want[-1][0] == label:
            merged_want[-1] = (label, merged_want[-1][1] + bars)
        else:
            merged_want.append((label, bars))
    got = section_bars(abc)
    if got != merged_want or len(score.voices["Ins"].bars) != timeline.bars or score.bpm != timeline.bpm:
        raise ValueError(f"Planned structure {got} does not match the timeline {merged_want}")
    info.update(bpm=timeline.bpm, bars=timeline.bars, nominal_seconds=round(timeline.seconds, 3))
    return abc, info, bool(score.voices["Vocal"].chords)
