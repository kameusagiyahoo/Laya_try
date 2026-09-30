from __future__ import annotations

import os
import time
from typing import Any, Protocol

from .config import Settings


class InferenceBackend(Protocol):
    ready: bool

    def start(self) -> None: ...
    def predict(self, state: Any, questions: dict[str, Any]) -> dict[str, Any]: ...


class LayaBackend:
    """Lazy import boundary so unit tests never import torch or download weights."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.router: Any | None = None
        self.ready = False
        self.startup_ms: float | None = None

    def start(self) -> None:
        started = time.perf_counter()
        os.environ["LAYA_DEVICE"] = self.settings.device
        os.environ["LAYA_THREADS"] = str(self.settings.threads)
        os.environ["LAYA_MAX_LOADED"] = str(self.settings.max_loaded)

        import torch
        from laya import Router

        torch.set_num_threads(self.settings.threads)
        self.router = Router(device=self.settings.device, max_loaded=self.settings.max_loaded)
        if self.settings.preload:
            self.router.preload([self.settings.model])
        self.startup_ms = (time.perf_counter() - started) * 1000
        self.ready = True

    def predict(self, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        if self.router is None:
            self.start()
        result = self.router.predict(state, questions, model=self.settings.model)
        return dict(result)


def _answer_confidence(answer: Any) -> float:
    if not isinstance(answer, dict):
        return 0.0
    for key in ("answer_confidence", "confidence"):
        if answer.get(key) is not None:
            return float(answer[key])
    probabilities = answer.get("probabilities")
    if isinstance(probabilities, dict) and probabilities:
        return float(max(probabilities.values()))
    return 0.0


def enrich_result(raw: dict[str, Any], settings: Settings, inference_ms: float) -> dict[str, Any]:
    answers = raw.get("answers") or {}
    probabilities: dict[str, Any] = {}
    confidences: list[float] = []
    for name, answer in answers.items():
        if isinstance(answer, dict):
            probabilities[name] = answer.get("probabilities", {})
            confidences.append(_answer_confidence(answer))
    result = dict(raw)
    result.update(
        answers=answers,
        probabilities=probabilities,
        confidence=min(confidences) if confidences else 0.0,
        model=str(raw.get("model") or settings.model),
        device=settings.device,
        inference_ms=round(inference_ms, 3),
    )
    return result
