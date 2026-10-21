"""YuE2 wrapper sized for a 12 GB card (RTX 3060).

Memory strategy on top of the stock pipeline:
  * memory_budget_gib=12 -> torch is capped at 10 GiB and the VAE decodes in 512-frame tiles.
  * The MoT model has an AR half (~4.4 GB) and a NAR half (~2.8 GB); only one is on the GPU
    at a time. Token generation and the synthesis prefill use AR; the flow-matching solve
    swaps AR out for NAR (see _swap_ar_for_nar).
  * Between songs the whole model sits in system RAM; idle VRAM is just the CUDA context.
"""
from __future__ import annotations

import dataclasses
import json
import os
import random
import shutil
import threading
import time
import traceback
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import torch

import yue2.pipeline as yue2_pipeline
from yue2.pipeline import SemanticResult, SongResult, YuE2Pipeline
from yue2.protocol import SongRequest
from yue2.storage import MODEL_FILES, MODEL_LICENSES

import fitted
import timeline
import vocal_check

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"
OUTPUTS = ROOT / "outputs"
FRAME_RATE = 25  # 48 kHz audio / 1920-sample VAE hop
MAX_SECONDS = 360  # 9000 song tokens, the checkpoint's default ceiling
VOCAL_RETRIES = 2  # extra renders of an instrumental when the vocal check hears singing
REPOS = {"YuE2-3B": "m-a-p/YuE2-3B", "YuE2-Vae": "m-a-p/YuE2-Vae"}


# --- Hashing 7.3 GB of weights takes ~20 s; do it once per file change, not every launch. ---

_identity_cache_path = MODELS / ".identity-cache.json"
_original_identity = yue2_pipeline.model_identity


def _cached_identity(path, verify=True):
    path = Path(path)
    files = sorted(path.glob("*.safetensors")) + [path / "config.json"]
    stamp = [[f.name, f.stat().st_size, f.stat().st_mtime_ns] for f in files]
    key = str(path.resolve())
    try:
        cache = json.loads(_identity_cache_path.read_text())
    except (OSError, ValueError):
        cache = {}
    if cache.get(key, {}).get("stamp") == stamp:
        return cache[key]["identity"]
    result = _original_identity(path, verify=True)
    cache[key] = {"stamp": stamp, "identity": result}
    _identity_cache_path.write_text(json.dumps(cache, indent=2))
    return result


yue2_pipeline.model_identity = _cached_identity


# --- Windows PyTorch wheels are built without FlashAttention, but YuE2's CUDA-graph decoder
# picks it whenever the op schema exists. Choose the fastest backend that actually runs. ---

def _decode_attention_backend():
    if torch.backends.cuda.is_flash_attention_available():
        return "auto"
    try:
        import torch.nn.functional as F
        from torch.nn.attention import SDPBackend, sdpa_kernel
        q = torch.randn(2, 16, 1, 128, device="cuda", dtype=torch.bfloat16)
        kv = torch.randn(2, 8, 64, 128, device="cuda", dtype=torch.bfloat16)
        mask = torch.ones(2, 1, 1, 64, device="cuda", dtype=torch.bool)
        with sdpa_kernel(SDPBackend.CUDNN_ATTENTION):
            F.scaled_dot_product_attention(q, kv, kv, attn_mask=mask, enable_gqa=True)
        torch.cuda.synchronize()
        return "cudnn"
    except Exception:
        return "sdpa"


def _patch_graph_attention(backend):
    import yue2.cuda_graph as cuda_graph
    original = cuda_graph.GraphAR

    class GraphAR(original):
        def __init__(self, *args, attention_backend="auto", **kwargs):
            if attention_backend == "auto":
                attention_backend = backend
            super().__init__(*args, attention_backend=attention_backend, **kwargs)

    cuda_graph.GraphAR = GraphAR


def _patch_gqa_attention():
    """Without FlashAttention, SDPA with enable_gqa=True falls back to the math kernel, which
    materializes the full attention matrix (GBs for long songs). Expanding K/V heads first lets
    the exact memory-efficient kernel run instead."""
    import torch.nn.functional as F
    import yue2.modeling_yue2 as modeling
    import yue2.nar as nar

    def sdpa(query, key, value, *, attn_mask=None, is_causal=False):  # [B, heads, T, D]
        if query.shape[1] != key.shape[1]:
            groups = query.shape[1] // key.shape[1]
            key, value = key.repeat_interleave(groups, 1), value.repeat_interleave(groups, 1)
        return F.scaled_dot_product_attention(query, key, value, attn_mask=attn_mask, is_causal=is_causal)

    original = nar.attention

    def attention(q, k, v, **kwargs):  # [T, heads, D]
        if q.shape[1] != k.shape[1]:
            groups = q.shape[1] // k.shape[1]
            k, v = k.repeat_interleave(groups, 1), v.repeat_interleave(groups, 1)
        return original(q, k, v, **kwargs)

    modeling.sdpa = sdpa
    nar.attention = attention


# --- Progress hook: the pipeline reports stages through _status(); we capture them. ---

class _Stage:
    def __init__(self, owner, label, total=None, unit=None):
        self.owner, self.label, self.total, self.unit, self.completed = owner, label, total, unit, 0
        owner._on_stage(self)

    def advance(self, count=1):
        self.completed += count

    def update(self, completed, total=None):
        self.completed = completed
        if total is not None:
            self.total = total

    def set_total(self, total):
        self.total = total

    def token(self, phase, token):
        self.advance()

    def finish(self, status="completed"):
        pass


def _ar_modules(model):
    parts = [model.model.embed_tokens, model.model.norm, model.model.rotary_emb, model.lm_head]
    for layer in model.model.layers:
        parts += [layer.input_layernorm, layer.self_attn, layer.post_attention_layernorm, layer.mlp]
    return parts


def _nar_aux_modules(model):
    return [model.llm2vae, model.vae2llm, model.time_embedder, model.latent_pos_embed]


def _nar_layer_modules(model):
    parts = []
    for layer in model.model.layers:
        parts += [layer.nar_input_layernorm, layer.nar_self_attn, layer.nar_pre_mlp_layernorm, layer.nar_mlp]
    return parts


def _move(modules, device):
    for module in modules:
        module.to(device)
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


@contextmanager
def _swap_ar_for_nar(model, enabled):
    """Replaces yue2.nar._offload_ar. The stock version only evicts AR weights during the
    flow-matching solve; here the NAR layers also stay in RAM during the AR prefill, so the
    two 2.8-4.4 GB halves are never on the GPU together."""
    device = next(model.vae2llm.parameters()).device
    ar = [m for m in _ar_modules(model) if m not in (model.model.norm, model.model.rotary_emb)]
    _move(ar, "cpu")
    _move(_nar_layer_modules(model), device)
    try:
        yield
    finally:
        _move(_nar_layer_modules(model), "cpu")
        _move(ar, device)


import yue2.nar as yue2_nar  # noqa: E402

yue2_nar._offload_ar = _swap_ar_for_nar


class LowVramPipeline(YuE2Pipeline):
    stage_listener = None

    @contextmanager
    def _status(self, label, *, total=None, unit=None):
        yield _Stage(self, label, total, unit)

    def _on_stage(self, stage):
        if self.stage_listener is not None:
            self.stage_listener(stage)

    def load_weights_to_ram(self):
        if self._model is None:
            from yue2.modeling_yue2 import YuE2ForCausalLM
            self._model = YuE2ForCausalLM.from_pretrained(
                self.model_dir, local_files_only=True, dtype=torch.bfloat16,
                low_cpu_mem_usage=True).eval()
        return self._model

    def _load_model(self, for_nar=False):
        model = self.load_weights_to_ram()
        with self._status("Loading model"):
            # AR prefill for synthesis also needs the small NAR helpers (embeddings, projections).
            _move(_nar_layer_modules(model) + ([] if for_nar else _nar_aux_modules(model)), "cpu")
            _move(_ar_modules(model) + (_nar_aux_modules(model) if for_nar else []), self.device)
        return model


# --- Model download ---

def model_dir(name):
    return MODELS / name


def models_present():
    return all(any(model_dir(n).glob("*.safetensors")) and (model_dir(n) / "config.json").exists()
               for n in REPOS)


def download_models():
    from huggingface_hub import snapshot_download
    patterns = sorted(MODEL_FILES) + ["model-?????-of-?????.safetensors"] + \
        ["licenses/" + n for n in sorted(MODEL_LICENSES)]
    for name, repo in REPOS.items():
        snapshot_download(repo, local_dir=model_dir(name), allow_patterns=patterns)


# --- Jobs ---

@dataclasses.dataclass
class Job:
    id: str
    params: dict
    state: str = "queued"  # queued | running | done | error | cancelled
    stage: str = "Queued"
    completed: int = 0
    total: int | None = None
    unit: str | None = None
    audio_seconds: float = 0.0  # song tokens so far / 25
    error: str | None = None
    track: dict | None = None
    started: float = dataclasses.field(default_factory=time.time)
    cancel: bool = False
    part: str | None = None  # "Section 2 of 3: chorus" while rendering sections separately
    source: str = "studio"  # "studio" (this app's page) or "mcp" (another app, which decides playback)
    _stage: _Stage | None = None

    def view(self):
        stage = self._stage
        if stage is not None:
            self.stage, self.completed, self.total, self.unit = stage.label, stage.completed, stage.total, stage.unit
            if stage.label == "Generating song":
                self.audio_seconds = stage.completed / FRAME_RATE
        return {"id": self.id, "state": self.state, "stage": self.stage, "completed": self.completed,
                "total": self.total, "unit": self.unit, "audio_seconds": round(self.audio_seconds, 1),
                "max_seconds": self.params["max_seconds"], "elapsed": round(time.time() - self.started, 1),
                "error": self.error, "track": self.track, "part": self.part, "source": self.source}


def _float(params, key, default, lo, hi):
    value = params.get(key)
    value = default if value is None else float(value)
    if not lo <= value <= hi:
        raise ValueError(f"{key} must be between {lo} and {hi}")
    return value


def normalize_params(raw):
    style = str(raw.get("style", "")).strip()
    if not style:
        raise ValueError("Style description is required")
    instrumental = bool(raw.get("instrumental"))
    lyrics = "" if instrumental else str(raw.get("lyrics", ""))
    if not instrumental and not lyrics.strip():
        raise ValueError("Add lyrics, or switch on Instrumental")
    cot = raw.get("cot", "full")
    if cot not in {"full", "melody", "off"}:
        raise ValueError("cot must be full, melody or off")
    if instrumental and cot == "off":
        raise ValueError("Instrumental length fitting needs planning mode Full or Melody")
    seed = raw.get("seed")
    seed = random.randrange(0, 2**31) if seed in (None, "", -1) else int(seed)
    abc = (raw.get("abc") or "").strip() or None
    if abc:
        abc = fitted.clean_abc(abc)
    if abc and cot == "off":
        raise ValueError("A custom score needs planning mode Full or Melody")
    cfg = raw.get("cfg_scale")
    layout = None
    if instrumental and not abc and raw.get("timeline"):
        layout = timeline.Timeline.parse(raw["timeline"])
        # Chord symbols in every bar are what keep YuE2's audio on the timeline's beat grid; with
        # melody-only planning it drifts ~1 bar early and the last section ends up as padding.
        cot = "full"
    return {
        "style": style, "lyrics": lyrics, "instrumental": instrumental, "cot": cot, "seed": seed, "abc": abc,
        "timeline": layout.to_dict() if layout else None,
        "vocal_check": instrumental and bool(raw.get("vocal_check", True)),
        "cfg_scale": None if cfg in (None, "") else _float(raw, "cfg_scale", 1.0, 0.0, 5.0),
        "max_seconds": round(layout.seconds, 2) if layout else int(_float(raw, "max_seconds", 240, 10, MAX_SECONDS)),
        "temperature": _float(raw, "temperature", 1.0, 0.05, 2.0),
        "top_p": _float(raw, "top_p", 0.95, 0.05, 1.0),
        "top_k": int(_float(raw, "top_k", 100, 1, 1000)),
        "repetition_penalty": _float(raw, "repetition_penalty", 1.2, 0.8, 2.0),
        "ode_steps": int(_float(raw, "ode_steps", 32, 4, 64)),
    }


class Engine:
    def __init__(self):
        self.pipe: LowVramPipeline | None = None
        self.status = "starting"  # starting | downloading | loading | ready | error
        self.status_detail = ""
        self.job: Job | None = None
        self.lock = threading.Lock()
        self.last_peak_gib: float | None = None
        OUTPUTS.mkdir(parents=True, exist_ok=True)

    # Startup ---------------------------------------------------------------
    def start(self):
        threading.Thread(target=self._boot, name="yue2-boot", daemon=True).start()

    def _boot(self):
        try:
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA is not available to PyTorch")
            self.attention = _decode_attention_backend()
            if self.attention != "auto":
                _patch_graph_attention(self.attention)
                _patch_gqa_attention()
            print(f"Decode attention backend: {self.attention}", flush=True)
            if not models_present():
                self.status, self.status_detail = "downloading", "Downloading YuE2 weights (~7.8 GB)"
                download_models()
            self.status, self.status_detail = "loading", "Verifying and loading weights"
            pipe = LowVramPipeline(model_dir("YuE2-3B"), model_dir("YuE2-Vae"), device="cuda",
                                   memory_budget_gib=12, offload_ar=True, progress=True)
            pipe.load_weights_to_ram()
            self.pipe = pipe
            self.status, self.status_detail = "ready", ""
        except Exception as exc:  # surfaced in the UI
            traceback.print_exc()
            self.status, self.status_detail = "error", f"{type(exc).__name__}: {exc}"

    # Status ----------------------------------------------------------------
    def gpu(self):
        try:
            free, total = torch.cuda.mem_get_info()
        except Exception:  # no CUDA, or a crashed CUDA context (reported via the job error)
            return None
        return {"name": torch.cuda.get_device_name(0), "total_gib": round(total / 2**30, 1),
                "used_gib": round((total - free) / 2**30, 1), "last_peak_gib": self.last_peak_gib}

    def snapshot(self):
        return {"status": self.status, "detail": self.status_detail, "gpu": self.gpu(),
                "job": self.job.view() if self.job else None}

    # Generation ------------------------------------------------------------
    def submit(self, raw):
        return self.start_job(raw).view()

    def busy(self):
        return bool(self.job and self.job.state in {"queued", "running"})

    def start_job(self, raw, source="studio") -> Job:
        if self.status != "ready":
            raise RuntimeError("Model is not ready yet")
        params = normalize_params(raw)
        with self.lock:
            if self.busy():
                raise RuntimeError("A song is already generating")
            job = self.job = Job(id=uuid.uuid4().hex[:12], params=params, source=source)
        threading.Thread(target=self._run, args=(job,), name="yue2-job", daemon=True).start()
        return job

    def cancel(self):
        if self.job and self.job.state in {"queued", "running"}:
            self.job.cancel = True

    def _run(self, job: Job):
        pipe = self.pipe
        p = job.params
        job.state = "running"
        pipe.stage_listener = lambda stage: setattr(job, "_stage", stage)
        base_config = pipe.generation_config
        pipe.generation_config = dataclasses.replace(base_config, ode_steps=p["ode_steps"])
        max_tokens = p["max_seconds"] * FRAME_RATE
        semantic = {"temperature": p["temperature"], "top_p": p["top_p"], "top_k": p["top_k"],
                    "repetition_penalty": p["repetition_penalty"], "max_tokens": max_tokens,
                    "min_tokens": min(200, max_tokens)}
        torch.cuda.reset_peak_memory_stats()
        try:
            if p["instrumental"]:
                song, extra = self._instrumental(job, pipe, p, semantic)
            else:
                song, extra = pipe(style=p["style"], lyrics=p["lyrics"], cot=p["cot"], seed=p["seed"],
                                   abc=p["abc"], cfg_scale=p["cfg_scale"], semantic_sampling=semantic,
                                   cancelled=lambda: job.cancel), {}
            job._stage = None
            job.stage = "Saving"
            job.track = self._save(job, song, extra)
            job.state, job.stage = "done", "Done"
        except InterruptedError:
            job._stage = None
            job.state, job.stage = "cancelled", "Cancelled"
        except Exception as exc:
            traceback.print_exc()
            job._stage = None
            job.state, job.stage = "error", "Failed"
            if isinstance(exc, torch.OutOfMemoryError):
                job.error = "Ran out of GPU memory. Try a shorter max length or close other GPU apps."
            elif isinstance(exc, torch.AcceleratorError):  # CUDA context is unusable from here on
                job.error = f"GPU error: {exc}".splitlines()[0]
                self.status, self.status_detail = "error", "GPU error. Close and relaunch YuE2 Studio."
            else:
                job.error = f"{type(exc).__name__}: {exc}"
        finally:
            pipe.generation_config = base_config
            pipe.stage_listener = None
            self.last_peak_gib = round(torch.cuda.max_memory_reserved() / 2**30, 2)
            # Weights go back to system RAM so idle VRAM is near zero.
            try:
                if pipe._model is not None:
                    pipe._model.to("cpu")
                torch.cuda.empty_cache()
            except Exception:
                traceback.print_exc()

    def _instrumental(self, job, pipe, p, semantic):
        """Strict-length instrumental: fitted score plan, vocal line moved to the instrument voice."""
        target = p["max_seconds"]
        cancelled = lambda: job.cancel  # noqa: E731
        style = fitted.instrumental_style(p["style"])
        plan_info, planned_quarters, layout = {}, None, None
        raw = p["abc"]
        if p.get("timeline"):
            layout = timeline.Timeline.parse(p["timeline"])
            for attempt in range(3):  # YuE2 occasionally writes notation the parser rejects; re-plan
                seed = p["seed"] + attempt
                request = SongRequest(style=style, lyrics=layout.planning_lyrics(), cot=p["cot"], seed=seed)
                raw, plan_info = timeline.plan_score(pipe, request, layout, cancelled=cancelled)
                try:
                    abc, fit_info, has_chords = timeline.finish_score(raw, layout, keep_chords=p["cot"] == "full")
                    break
                except ValueError as exc:
                    print(f"Planned score rejected (seed {seed}): {exc}\n{raw}", flush=True)
                    if attempt == 2:
                        raise
            plan_info["plan_seed"] = seed
        else:
            if raw is None:
                request = SongRequest(style=style, lyrics=fitted.planning_sections(target), cot=p["cot"],
                                      seed=p["seed"])
                raw, plan_info = fitted.plan_score(pipe, request, target, cancelled=cancelled)
                planned_quarters = plan_info["planned_quarters"]
            abc, fit_info, has_chords = fitted.fit_score(raw, target, keep_chords=p["cot"] == "full",
                                                         planned_quarters=planned_quarters)
        # YuE2 tends to finish a few % ahead of the score's nominal length; hold the song open until
        # the last second so the music fills the target instead of trailing into padding.
        tokens = int(round(target * FRAME_RATE))
        semantic = {**semantic, "max_tokens": tokens, "min_tokens": tokens - FRAME_RATE}
        if layout and layout.strict:
            song, sections, check = self._render_sections(job, pipe, p, layout, abc, has_chords, semantic, cancelled)
        else:
            render = fitted.render_labels(abc)

            def whole(attempt, first):  # a single-pass render always starts over, with a new seed
                job.part = f"Vocal retry {attempt} of {VOCAL_RETRIES}" if attempt else None
                return pipe(style=style, lyrics=fitted.lyric_tags(render), cot="full" if has_chords else "melody",
                            seed=p["seed"] + 1000 * attempt, abc=render, cfg_scale=p["cfg_scale"],
                            semantic_sampling=semantic, cancelled=cancelled), None

            song, sections, check = self._render_checked(job, pipe, p, layout, whole)
        if layout:
            song.audio = timeline.silence_audio(song.audio, song.sample_rate, layout)
        song.audio = fitted.exact_length(song.audio, song.sample_rate, target, song.truncated["semantic"])
        return song, {"plan": plan_info, "fit": fit_info, "raw_score": raw, "sections": sections, "vocal_check": check}

    def _render_sections(self, job, pipe, p, layout, abc, has_chords, semantic, cancelled):
        """Exact section timing without seams: song tokens are written section by section, each
        continuing from the previous section's tokens and held to exactly its length (a one-pass
        render drifts up to ~1 bar); then the whole token stream becomes audio in one pass."""
        start = time.perf_counter()
        cot = "full" if has_chords else "melody"
        sampling = {key: semantic[key] for key in ("temperature", "top_p", "top_k", "repetition_penalty")}
        render = fitted.render_labels(abc)
        request = SongRequest(style=fitted.instrumental_style(p["style"]), lyrics=fitted.lyric_tags(render), cot=cot,
                              seed=p["seed"], abc=render, cfg_scale=p["cfg_scale"])
        plan = pipe.plan(request=request)
        previous = {"tokens": None, "report": []}

        def sections(attempt, first):  # (re)write the tokens from section `first` on, then render all
            retry = f"Vocal retry {attempt} of {VOCAL_RETRIES}" if attempt else ""

            def on_section(index, label):
                job.part = (f"{retry} · " if retry else "") + f"Section {index + 1} of {len(layout.sections)}: {label}"

            tokens, report = timeline.chain_song_tokens(
                pipe, layout, abc, style=p["style"], cot=cot, seed=p["seed"], cfg_scale=p["cfg_scale"],
                sampling=sampling, cancelled=cancelled, on_section=on_section,
                tokens=previous["tokens"], first=first, attempt=attempt)
            report = previous["report"][:first] + report
            previous.update(tokens=tokens, report=report)
            job.part = retry or None
            result = SemanticResult(plan, tokens, {"sections": report}, report[-1]["hit_cap"])
            latents = pipe.synthesize(result, cancelled=cancelled)
            if cancelled():
                raise InterruptedError("Cancelled before VAE")
            audio = pipe.decode(latents)
            song = SongResult(audio, 48000, result, latents, pipe.effective_config(request), pipe.weights,
                              {"e2e_seconds": time.perf_counter() - start}, "timeline-sections")
            return song, report

        return self._render_checked(job, pipe, p, layout, sections)

    def _render_checked(self, job, pipe, p, layout, render):
        """Render; with the vocal check on, listen for singing and render again from the first
        section that has it (up to VOCAL_RETRIES more times), keeping the render with the least.
        render(attempt, first) -> (song, report) writes the song from section index `first` on.
        Returns (song, report, check report for meta.json, or None with the check off)."""
        start = time.perf_counter()
        song, report = render(0, 0)
        if not p.get("vocal_check"):
            return song, report, None
        if not vocal_check.available():
            return song, report, {"skipped": "The vocal check isn't installed. Run Install.cmd again."}
        spans = timeline.section_spans(layout) if layout else [("song", 0.0, len(song.audio) / song.sample_rate)]
        check, best = {"threshold": vocal_check.THRESHOLD, "attempts": []}, None
        for attempt in range(VOCAL_RETRIES + 1):
            if attempt:
                song, report = render(attempt, first)
            try:
                heard = self._listen(pipe, song, layout, spans)
            except Exception as exc:  # e.g. no network for the first weights download
                traceback.print_exc()
                check["skipped"] = f"{type(exc).__name__}: {exc}"
                break
            check["attempts"].append({"from": spans[first][0] if attempt else None,
                                      "sections": [{"label": label, "singing": score}
                                                   for (label, _, _), score in zip(spans, heard)]})
            if best is None or max(heard) < best[0]:
                best = (max(heard), song, report, attempt)
            singing = [i for i, score in enumerate(heard) if score >= vocal_check.THRESHOLD]
            if not singing:
                break
            first = singing[0]
        job.part = None
        if best is None:
            return song, report, check
        _, song, report, check["kept"] = best
        check["clean"] = best[0] < vocal_check.THRESHOLD
        song.timing["e2e_seconds"] = max(song.timing["e2e_seconds"], time.perf_counter() - start)  # all attempts
        return song, report, check

    def _listen(self, pipe, song, layout, spans):
        """Singing probability per (label, start, end) span of the song, as it will be saved."""
        audio = timeline.silence_audio(song.audio, song.sample_rate, layout) if layout else song.audio
        if not vocal_check.loaded():
            label = "Loading vocal check" if vocal_check.downloaded() else "Downloading vocal check (~410 MB)"
            with pipe._status(label):
                vocal_check.load()
        with pipe._status("Checking for vocals"):
            rows = vocal_check.windows(audio, song.sample_rate, device=pipe.device)
        return vocal_check.span_scores(rows, [(start, end) for _, start, end in spans])


    def _save(self, job, song, extra):
        directory = OUTPUTS / f"{datetime.now():%Y%m%d-%H%M%S}-{job.id[:6]}"
        song.save_artifacts(directory)
        if extra.get("raw_score"):
            (directory / "score-planned.abc").write_text(extra["raw_score"], encoding="utf-8")
        p = job.params
        meta = {"id": directory.name, "created": datetime.now(timezone.utc).isoformat(),
                "duration": round(len(song.audio) / song.sample_rate, 2),
                "truncated": bool(song.truncated["semantic"]),
                "seconds_taken": round(song.timing["e2e_seconds"], 1),
                "has_score": song.abc is not None, "params": p,
                "plan": extra.get("plan"), "fit": extra.get("fit"), "sections": extra.get("sections"),
                "vocal_check": extra.get("vocal_check")}
        (directory / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
        return meta

    # Library ---------------------------------------------------------------
    def tracks(self):
        items = []
        for meta in OUTPUTS.glob("*/meta.json"):
            try:
                items.append(json.loads(meta.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        return sorted(items, key=lambda m: m["created"], reverse=True)

    def track_dir(self, track_id):
        directory = (OUTPUTS / track_id).resolve()
        if directory.parent != OUTPUTS.resolve() or not (directory / "meta.json").exists():
            raise FileNotFoundError(track_id)
        return directory

    def delete(self, track_id):
        shutil.rmtree(self.track_dir(track_id))


_mp3_lock = threading.Lock()


def ensure_mp3(directory: Path) -> Path:
    """320 kbps MP3 next to audio.flac, encoded on first use and re-encoded if the FLAC is newer."""
    flac = directory / "audio.flac"
    mp3 = flac.with_suffix(".mp3")
    with _mp3_lock:  # the REST route and MCP may ask for the same file at once
        if mp3.is_file() and mp3.stat().st_mtime >= flac.stat().st_mtime:
            return mp3
        import soundfile as sf
        audio, sample_rate = sf.read(flac, dtype="float32")
        partial = mp3.with_suffix(".mp3.part")
        sf.write(partial, audio, sample_rate, format="MP3", subtype="MPEG_LAYER_III",
                 bitrate_mode="CONSTANT", compression_level=0.0)
        os.replace(partial, mp3)
    return mp3
