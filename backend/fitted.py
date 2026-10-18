"""Instrumental songs with a strict length.

YuE2's audio follows its planned ABC score closely (within ~1%), but the planner chooses the
score length itself. Here the score is sampled with the model's own sampler, but the plan is
steered to the requested length:

  1. After the model writes the tempo and meter header, the target length becomes a bar count.
  2. The score may not end before that bar count; near the end an "% outro" section is forced,
     and the score is closed at the first voice-group boundary that reaches the target.
  3. The tempo line is nudged so bars x beats / tempo equals the target exactly.
  4. Following YuE2's official instrumental recipe, the planned vocal melody moves to the
     instrument voice and the song is rendered with section tags instead of lyrics.
  5. Song tokens are capped at the target, and the audio is trimmed/padded to the exact length.
"""
from __future__ import annotations

import dataclasses
import re
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).with_name("vendor") / "yue2_instrumental"))
from abc_tools import parse_abc  # noqa: E402
from compile_score import SECTIONS  # noqa: E402
from instrumentalize import convert_score  # noqa: E402

from yue2.protocol import ABC_END, EOD, SongRequest, token_prefixes  # noqa: E402

ABC_BUDGET = 8192  # tokens; ~15-20 per bar, the stock 4096 can truncate long plans
MAX_TEMPO_CHANGE = 0.15
NO_VOICE = ("no vocals", "no singing", "no choir", "no spoken words")


def instrumental_style(style):
    """Same style conditioning as YuE2's instrumental skill."""
    style = style.strip().rstrip(".,")
    if not re.match(r"^instrumental\b", style, re.I):
        style = "Instrumental, " + style
    for condition in NO_VOICE:
        if condition not in style.lower():
            style += ", " + condition
    return style + "."


def planning_sections(seconds):
    """Planner-only section skeleton, scaled to the target so the natural form roughly fits."""
    if seconds <= 45:
        tags = ["Intro", "Verse", "Outro"]
    elif seconds <= 120:
        tags = ["Intro", "Verse", "Chorus", "Outro"]
    else:
        tags = ["Intro", "Verse", "Chorus", "Verse", "Chorus", "Bridge", "Chorus", "Outro"]
    return "\n\n".join(f"[{t}]" for t in tags) + "\n"


def lyric_tags(abc):
    labels = [line[2:] for line in abc.splitlines() if line.startswith("% ")]
    return "\n\n".join("[" + label.title() + "]" for label in labels) + ("\n" if labels else "")


def _bars_in(line):
    count = 0
    for bar in line.rstrip().rstrip("|").split("|"):
        rest = re.fullmatch(r"\s*Z([2-4])?\s*", bar)
        count += int(rest.group(1) or 1) if rest else (1 if bar.strip() else 0)
    return count


class ScoreTracker:
    """Follows the ABC text as it is sampled: header, sections, and completed bars."""

    def __init__(self, target_seconds):
        self.target_seconds = target_seconds
        self.buffer = b""
        self.lines_done = 0
        self.header_done = False
        self.meter = (4, 4)
        self.bpm = None
        self.target_bars = None
        self.bars = 0
        self.quarters = 0.0
        self.voice = None
        self.at_boundary = False
        self.outro = False

    @property
    def partial(self):
        return self.buffer.decode("utf-8", "replace").rsplit("\n", 1)[-1]

    @property
    def bar_quarters(self):
        n, d = self.meter
        return 4 * n / d

    @property
    def remaining(self):
        return None if self.target_bars is None else self.target_bars - self.bars

    @property
    def planned_seconds(self):
        return self.quarters * 60 / self.bpm if self.bpm else 0.0

    @property
    def outro_bars(self):
        return 4 if self.target_bars <= 24 else 8

    @property
    def tolerance(self):
        return 1 if self.target_bars < 40 else 2

    def feed(self, data: bytes):
        self.buffer += data
        lines = self.buffer.decode("utf-8", "replace").split("\n")
        for line in lines[self.lines_done:-1]:
            self._line(line.strip())
        self.lines_done = len(lines) - 1
        if self.partial:
            self.at_boundary = False

    def _line(self, line):
        self.at_boundary = False
        if line.startswith("M:"):
            match = re.fullmatch(r"M:(\d+)/(\d+)", line)
            if match:
                self.meter = (int(match.group(1)), int(match.group(2)))
            return
        if not self.header_done:
            match = re.fullmatch(r"Q:1/4=(\d+)", line)
            if match:
                self.bpm = int(match.group(1))
            elif line.startswith("K:"):
                self.header_done = True
                self._set_target()
            return
        if line.startswith("% "):
            self.outro = line[2:].strip() == "outro"
        elif line in ("V: Vocal", "V: Ins"):
            self.voice = line[3:]
        elif line.startswith("K:") or not line:
            pass
        elif self.voice == "Ins":
            bars = _bars_in(line)
            self.bars += bars
            self.quarters += bars * self.bar_quarters
            self.at_boundary = True
            self.voice = None

    def _set_target(self):
        bpm = self.bpm or 120
        self.bpm = bpm
        exact = self.target_seconds * bpm / 60 / self.bar_quarters
        # YuE2 writes voice groups of up to 4 bars; a multiple of 4 lets the score close cleanly.
        # Even short pieces get a whole number of groups so a 4-bar outro fits; the tempo fit absorbs
        # the rounding (<= 15%), anything beyond that is trimmed or padded.
        self.target_bars = max(4, round(exact / 4) * 4) if exact >= 7 else max(2, round(exact))


_label_ids = {}


def _label_token_ids(tokenizer, label):
    """Tokens that would start spelling a section label right after '%'."""
    if label not in _label_ids:
        ids = []
        for i in range(EOD):
            text = tokenizer._enc.decode_single_token_bytes(i).decode("utf-8", "ignore").lstrip()
            if text and (label.startswith(text) or text.startswith(label)):
                ids.append(i)
        _label_ids[label] = torch.tensor(ids, dtype=torch.long)
    return _label_ids[label]


@torch.inference_mode()
def plan_score(pipe, request: SongRequest, target_seconds, *, cancelled=None):
    """Sample an ABC score whose length is steered to target_seconds. Returns (abc, info)."""
    import yue2.cuda_graph as cuda_graph
    from yue2.sampling import distribution

    tokenizer = pipe.tokenizer
    model = pipe._load_model()
    sampling = dataclasses.replace(pipe.generation_config.abc, max_tokens=ABC_BUDGET, min_tokens=0)
    prefix = token_prefixes(request, tokenizer)
    outro_ids = _label_token_ids(tokenizer, "outro").to(pipe.device)
    # YuE2 sometimes plans a "% silence" section; that would eat into the requested length.
    silence_ids = _label_token_ids(tokenizer, "silence").to(pipe.device)
    section_ids = _label_token_ids(tokenizer, "%").to(pipe.device)
    generator = torch.Generator(device=pipe.device).manual_seed(request.seed)
    tracker = ScoreTracker(target_seconds)
    ids, forced, forced_count = [], [], 0
    graph = cuda_graph.GraphAR(model, [prefix], sampling.max_tokens)
    with pipe._status("Planning score", total=int(target_seconds), unit="s") as stage:
        try:
            logits = graph.prefill()[:1]
            for step in range(sampling.max_tokens):
                if cancelled is not None and cancelled():
                    raise InterruptedError("Cancelled during score planning")
                remaining = tracker.remaining
                near_budget = step >= sampling.max_tokens - 256
                if forced:
                    token = forced.pop(0)
                elif tracker.at_boundary and remaining is not None and (remaining <= 0 or near_budget):
                    token = ABC_END
                elif (tracker.at_boundary and remaining is not None and not tracker.outro
                      and tracker.tolerance < remaining <= tracker.outro_bars):
                    forced = tokenizer.encode("% outro\n")
                    forced_count += 1
                    token = forced.pop(0)
                else:
                    # Mask before top-k/top-p: masking afterwards can leave no candidates at all.
                    logits = logits.clone()
                    unparsed = remaining is None and step > 200  # unexpected header: don't steer
                    # Inside the outro, an early ending within the tempo-fit range is fine; a new
                    # section after the outro is not (the outro just continues instead).
                    slack = tracker.tolerance if remaining is not None else 0
                    if tracker.outro and remaining is not None:
                        slack = max(slack, int(MAX_TEMPO_CHANGE * 0.8 * tracker.target_bars))
                        if tracker.at_boundary:
                            logits[..., section_ids] = -torch.inf
                    end_ok = unparsed or (tracker.at_boundary and remaining is not None and remaining <= slack)
                    if not end_ok:
                        logits[..., ABC_END] = -torch.inf
                    if tracker.partial in ("%", "% "):
                        logits[..., silence_ids] = -torch.inf
                        if remaining is not None and remaining > tracker.outro_bars + 4:
                            logits[..., outro_ids] = -torch.inf
                    scores = distribution(logits, sampling, ids, step, "abc")
                    token = int(torch.multinomial(scores.softmax(-1), 1, generator=generator).item())
                if token == ABC_END:
                    break
                ids.append(token)
                tracker.feed(tokenizer._enc.decode_single_token_bytes(token))
                stage.update(min(int(tracker.planned_seconds), int(target_seconds)))
                if step + 1 >= sampling.max_tokens:
                    break
                logits = graph.step(token)[:1]
        finally:
            graph.close()
    info = {"model_bpm": tracker.bpm, "meter": "%d/%d" % tracker.meter, "target_bars": tracker.target_bars,
            "planned_bars": tracker.bars, "planned_quarters": tracker.quarters, "score_tokens": len(ids),
            "forced_outro": bool(forced_count)}
    return tokenizer.decode(ids), info


def clean_abc(text):
    """Tidy a pasted score into YuE2's exact header layout: Windows line endings, blank lines,
    trailing spaces, a title on T:, or a missing X:/T: line would otherwise be rejected."""
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    lines = [line for line in lines if line]
    while lines and lines[0].startswith(("X:", "T:")):
        lines.pop(0)
    return "\n".join(["X:1", "T:"] + lines) + "\n"


def _set_tempo(abc, bpm):
    return re.sub(r"^Q:1/4=\d+$", f"Q:1/4={bpm}", abc, count=1, flags=re.M)


def fit_score(abc, target_seconds, keep_chords, planned_quarters=None):
    """Move the vocal melody to the instrument voice and fit the tempo to the target length.
    Returns (abc, info, has_chords)."""
    info = {}
    try:
        instrumental_ready = not parse_abc(abc).voices["Vocal"].notes
    except Exception:
        instrumental_ready = False
    if instrumental_ready:  # e.g. a hand-written score: keep it exactly, including its labels
        info["vocal_notes_moved"] = 0
    else:
        # The converter only knows the documented section labels; drop any others (the bars keep
        # the previous section's label).
        known = [line for line in abc.splitlines(keepends=True)
                 if not line.startswith("% ") or line[2:].strip() in SECTIONS]
        if len(known) != len(abc.splitlines(keepends=True)):
            info["dropped_labels"] = sorted({line[2:].strip() for line in abc.splitlines()
                                             if line.startswith("% ") and line[2:].strip() not in SECTIONS})
            abc = "".join(known)
        try:
            converted, check = convert_score(abc, keep_chords=keep_chords)
            info["vocal_notes_moved"] = check["vocal_notes_before"]
            abc = converted
        except Exception as exc:  # unusual notation: keep the model's score rather than fail
            info["conversion_skipped"] = f"{type(exc).__name__}: {exc}"
    try:
        score = parse_abc(abc)
        quarters, bpm, has_chords = float(score.voices["Ins"].time), score.bpm, bool(score.voices["Vocal"].chords)
    except Exception as exc:
        if not planned_quarters:
            raise ValueError(f"The score isn't in YuE2's ABC format: {exc}") from exc
        tempo = re.search(r"^Q:1/4=(\d+)$", abc, re.M)
        quarters, bpm, has_chords = planned_quarters, int(tempo.group(1)) if tempo else 120, '"' in abc
    exact = quarters * 60 / target_seconds
    fitted = round(min(max(exact, bpm * (1 - MAX_TEMPO_CHANGE)), bpm * (1 + MAX_TEMPO_CHANGE)))
    abc = _set_tempo(abc, fitted)
    info.update(bpm_before=bpm, bpm=fitted, nominal_seconds=round(quarters * 60 / fitted, 2))
    return abc, info, has_chords


def exact_length(audio, sample_rate, seconds, truncated):
    """Trim/pad to exactly `seconds`; fade the tail if the token cap cut the music."""
    target = int(round(seconds * sample_rate))
    audio = audio[:target]
    if truncated:
        fade = min(len(audio), int(1.5 * sample_rate))
        audio = audio.copy()
        audio[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=audio.dtype)[:, None]
    if len(audio) < target:
        audio = np.concatenate([audio, np.zeros((target - len(audio), audio.shape[1]), audio.dtype)])
    return audio
