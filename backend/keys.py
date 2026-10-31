"""Musical keys: parse a requested key, and write it into the score YuE2 plans.

Left to itself, YuE2 almost always plans in E or A minor over i-VI-VII chords, whatever the style
asks for. A requested key goes on the header's K: line instead, so the model never picks it:
  * timelines force it with the rest of their header (timeline.Rails),
  * free-running plans (plain-length instrumentals, songs with lyrics) let the model write the
    header as usual and fill in the K: value once it has written "K:" (KeyHeader).
The key sets the score's key signature; the model still writes the melody and chords.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import torch

VENDOR = str(Path(__file__).with_name("vendor") / "yue2_instrumental")
if VENDOR not in sys.path:
    sys.path.insert(0, VENDOR)
from abc_tools import KEYS  # noqa: E402

from yue2.protocol import ABC_END, token_prefixes  # noqa: E402


def parse_key(value):
    """'A', 'Em', 'Bb', 'F#m', 'a minor', 'C major' -> the K: value the score parser accepts.
    None, '' or 'auto' -> None (YuE2 picks)."""
    text = " ".join(str(value or "").split())
    if text.lower() in ("", "auto"):
        return None
    match = re.fullmatch(r"([A-Ga-g])([#b]?)\s*((?i:m|min|minor|maj|major))?", text)
    key = None
    if match:
        minor = (match.group(3) or "").lower() in ("m", "min", "minor")
        key = match.group(1).upper() + match.group(2) + ("m" if minor else "")
    if key not in KEYS:
        raise ValueError(f"Unsupported key {text!r}; use a major or minor key such as A, Em, Bb or F#m")
    return key


class KeyHeader:
    """Fills in the header's K: line of a score the model is writing freely."""

    def __init__(self, key):
        self.key = key
        self.text = ""
        self.done = key is None

    def rewrite(self, text):
        """For a sampled token: (text to keep, text to force right after it). Once the token
        completes a "K:" at the start of a line, the rest of it is replaced by the key."""
        if self.done:
            return text, ""
        before = len(self.text)
        self.text += text
        at = re.search(r"(?:^|\n)K:", self.text)
        if at is None:
            return text, ""
        self.done = True
        return text[:at.end() - before], self.key + "\n"


@torch.inference_mode()
def plan_score(pipe, request, key, *, cancelled=None):
    """YuE2's own score planning (its sampler, budget and seed), with the K: line set to `key`.
    Returns (abc, info); the abc is then given to the pipeline as the song's score."""
    import yue2.cuda_graph as cuda_graph
    from yue2.sampling import distribution

    tokenizer = pipe.tokenizer
    model = pipe._load_model()
    sampling = pipe.generation_config.abc
    header = KeyHeader(key)
    generator = torch.Generator(device=pipe.device).manual_seed(request.seed)
    ids, queue, truncated = [], [], True
    graph = cuda_graph.GraphAR(model, [token_prefixes(request, tokenizer)], sampling.max_tokens)
    with pipe._status("Planning score", unit="tokens") as stage:
        try:
            logits = graph.prefill()[:1]
            for step in range(sampling.max_tokens):
                if cancelled is not None and cancelled():
                    raise InterruptedError("Cancelled during score planning")
                if queue:  # the forced key
                    token = queue.pop(0)
                else:
                    scores = distribution(logits, sampling, ids, step, "abc")
                    token = int(torch.multinomial(scores.softmax(-1), 1, generator=generator).item())
                    if token == ABC_END:
                        truncated = False
                        break
                    text = tokenizer._enc.decode_single_token_bytes(token).decode("utf-8", "replace")
                    kept, forced = header.rewrite(text)
                    if forced:
                        queue = tokenizer.encode(kept + forced)
                        token = queue.pop(0)
                ids.append(token)
                stage.advance()
                if step + 1 < sampling.max_tokens:
                    logits = graph.step(token)[:1]
        finally:
            graph.close()
    if not header.done:
        raise ValueError("The planned score has no K: line to set the key on")
    return tokenizer.decode(ids), {"key": key, "score_tokens": len(ids), "truncated": truncated}
