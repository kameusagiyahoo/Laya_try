from __future__ import annotations

import json
import os
import statistics
import time
from collections import Counter
from pathlib import Path

import pytest

from backend.server.config import Settings
from backend.server.inference import LayaBackend, _answer_confidence
from backend.server.robot import ROBOT_COMMAND_QUESTION, resolve_robot_intent
from backend.server.routing import DEFAULT_ROUTE_QUESTION


pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(os.getenv("RUN_LAYA_E2E") != "1", reason="set RUN_LAYA_E2E=1 to load the real model"),
]


@pytest.fixture(scope="module")
def real_backend() -> LayaBackend:
    settings = Settings(device="cpu", model="multilingual", preload=True, threads=4, max_loaded=1)
    backend = LayaBackend(settings)
    backend.start()
    return backend


def test_real_multilingual_cpu_prediction(real_backend: LayaBackend) -> None:
    result = real_backend.predict(
        "二重請求されています。返金してください。", DEFAULT_ROUTE_QUESTION
    )

    assert real_backend.ready is True
    assert result["answers"]["department"]["choice"] in {"billing", "technical", "sales", "other"}


def test_real_robot_japanese_intent_accuracy(real_backend: LayaBackend) -> None:
    dataset_path = Path(__file__).parents[1] / "fixtures" / "robot_intents_ja.json"
    examples = json.loads(dataset_path.read_text(encoding="utf-8"))
    raw_correct = Counter()
    resolved_correct = Counter()
    totals = Counter()
    high_confidence_errors: list[dict[str, object]] = []
    errors: list[dict[str, object]] = []
    timings: list[float] = []

    for example in examples:
        started = time.perf_counter()
        result = real_backend.predict(example["utterance"], ROBOT_COMMAND_QUESTION)
        timings.append((time.perf_counter() - started) * 1000)
        answer = result["answers"]["command"]
        predicted = answer["choice"]
        confidence = _answer_confidence(answer)
        resolution = resolve_robot_intent(example["utterance"], predicted, confidence)
        expected = example["intent"]
        totals[expected] += 1
        if predicted == expected:
            raw_correct[expected] += 1
        if resolution.intent == expected:
            resolved_correct[expected] += 1
        else:
            error = {
                "utterance": example["utterance"],
                "expected": expected,
                "predicted": resolution.intent,
                "confidence": round(resolution.confidence, 4),
                "resolver": resolution.resolver,
                "raw_intent": predicted,
                "raw_confidence": round(confidence, 4),
            }
            errors.append(error)
            if resolution.confidence >= 0.80:
                high_confidence_errors.append(error)

    raw_accuracy = sum(raw_correct.values()) / len(examples)
    accuracy = sum(resolved_correct.values()) / len(examples)
    per_intent = {intent: resolved_correct[intent] / total for intent, total in totals.items()}
    ordered = sorted(timings)
    p95_ms = ordered[max(0, int(len(ordered) * 0.95) - 1)]
    summary = {
        "examples": len(examples),
        "raw_laya_accuracy": round(raw_accuracy, 4),
        "accuracy": round(accuracy, 4),
        "per_intent": {key: round(value, 4) for key, value in sorted(per_intent.items())},
        "high_confidence_errors": high_confidence_errors,
        "mean_ms": round(statistics.fmean(timings), 3),
        "p95_ms": round(p95_ms, 3),
        "errors": errors,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    assert accuracy >= 0.90, summary
    assert min(per_intent.values()) >= 0.80, summary
    assert high_confidence_errors == [], summary
    assert p95_ms <= 750, summary
