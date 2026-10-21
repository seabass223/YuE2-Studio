"""Vocal check for instrumentals: does the audio have singing in it?

YuE2 sometimes sings over an instrumental anyway. The mix is split with Demucs (htdemucs) and the
AudioSet AST classifier listens to the isolated vocal stem in 5 s windows. Neither works alone: AST
on the full mix barely reacts to singing, and the vocal stem also picks up flute, violin and synth
leads. Together they separate well. Songs with real vocals score 0.2-0.6, clean instrumentals 0-0.05.

Weights (~430 MB) live in models/vocal-check and are downloaded on first use.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

WEIGHTS = Path(__file__).resolve().parents[1] / "models" / "vocal-check"
AST = "MIT/ast-finetuned-audioset-10-10-0.4593"
THRESHOLD = 0.15  # singing probability on the vocal stem
WINDOW, HOP = 5.0, 2.5  # seconds
QUIET = 0.003  # RMS below which a stem window has nothing in it to classify
# AudioSet classes for a voice that sings, raps or chants (speech is not counted).
SINGING = {27: "Singing", 28: "Choir", 30: "Chant", 32: "Male singing", 33: "Female singing",
           34: "Child singing", 35: "Synthetic singing", 36: "Rapping", 255: "A capella"}

_models = None


def available():
    try:
        import demucs  # noqa: F401
        import torchaudio  # noqa: F401
    except ImportError:
        return False
    return True


def loaded():
    return _models is not None


def downloaded():
    return WEIGHTS.is_dir() and any(WEIGHTS.rglob("*.th")) and any(WEIGHTS.rglob("*.safetensors"))


def load():
    """(demucs, feature extractor, AST), loaded once and kept in system RAM."""
    global _models
    if _models is None:
        from demucs.pretrained import get_model
        from transformers import ASTFeatureExtractor, ASTForAudioClassification
        WEIGHTS.mkdir(parents=True, exist_ok=True)
        previous = torch.hub.get_dir()
        torch.hub.set_dir(str(WEIGHTS))  # demucs fetches its weights through torch.hub
        try:
            separator = get_model("htdemucs").eval()
        finally:
            torch.hub.set_dir(previous)
        # A public model: token=False keeps a stale saved Hugging Face login from failing the download.
        extractor = ASTFeatureExtractor.from_pretrained(AST, cache_dir=WEIGHTS, token=False)
        classifier = ASTForAudioClassification.from_pretrained(AST, cache_dir=WEIGHTS, token=False).eval()
        _models = separator, extractor, classifier
    return _models


@torch.inference_mode()
def windows(audio, sample_rate, device="cuda"):
    """[(start, end, singing probability)] for 5 s windows every 2.5 s of audio [samples, channels]."""
    import julius
    from demucs.apply import apply_model
    separator, extractor, classifier = load()
    mix = torch.from_numpy(np.ascontiguousarray(np.asarray(audio, dtype=np.float32).T))
    if mix.shape[0] == 1:
        mix = mix.repeat(2, 1)
    mix = julius.resample_frac(mix, sample_rate, separator.samplerate)
    reference = mix.mean(0)
    mean, std = reference.mean(), reference.std() + 1e-8
    try:
        separator.to(device)
        classifier.to(device)
        stems = apply_model(separator, ((mix - mean) / std)[None].to(device), split=True, overlap=0.25,
                            progress=False)[0]
        vocals = (stems[separator.sources.index("vocals")] * std + mean).mean(0)
        voice = julius.resample_frac(vocals, separator.samplerate, 16000).cpu().numpy()
        total = len(voice) / 16000
        spans = [(t, min(total, t + WINDOW)) for t in np.arange(0, max(total - 1.0, 0), HOP)]
        segments = [voice[int(a * 16000):int(b * 16000)] for a, b in spans]
        loud = [i for i, seg in enumerate(segments) if np.sqrt(np.mean(seg ** 2)) >= QUIET]
        scores = [0.0] * len(spans)
        for batch in range(0, len(loud), 8):
            index = loud[batch:batch + 8]
            inputs = extractor([segments[i] for i in index], sampling_rate=16000, return_tensors="pt")
            probs = torch.sigmoid(classifier(inputs["input_values"].to(device)).logits)[:, list(SINGING)]
            for i, p in zip(index, probs.max(-1).values.tolist()):
                scores[i] = p
    finally:
        separator.to("cpu")
        classifier.to("cpu")
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    return [(float(a), float(b), round(p, 3)) for (a, b), p in zip(spans, scores)]


def span_scores(rows, spans, overlap=0.5):
    """Highest window score over each (start, end) span, counting windows that overlap it by > 0.5 s."""
    return [max((p for a, b, p in rows if min(b, end) - max(a, start) > overlap), default=0.0)
            for start, end in spans]
