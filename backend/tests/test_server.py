from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.server.app import create_app
from backend.server.config import Settings


class MockLayaBackend:
    def __init__(self, confidence: float = 0.91, choice: str = "billing"):
        self.ready = False
        self.confidence = confidence
        self.choice = choice
        self.calls = 0

    def start(self) -> None:
        self.ready = True

    def predict(self, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        self.calls += 1
        answers: dict[str, Any] = {}
        for name, question in questions.items():
            if question["type"] == "choice":
                options = list(question["criteria"])
                selected = self.choice if self.choice in options else options[0]
                remainder = (1 - self.confidence) / max(1, len(options) - 1)
                answers[name] = {
                    "choice": selected,
                    "confidence": self.confidence,
                    "probabilities": {option: self.confidence if option == selected else remainder for option in options},
                }
            elif question["type"] == "score":
                answers[name] = {"score": 1.5, "confidence": self.confidence}
            else:
                answers[name] = {"probability": 0.2, "confidence": self.confidence}
        return {"model": "multilingual", "answers": answers}


@pytest.fixture
def questions() -> dict[str, Any]:
    return {
        "department": {
            "type": "choice",
            "instructions": "どの担当へ送るべきか",
            "criteria": {"billing": "請求", "technical": "障害", "other": "その他"},
        }
    }


def make_client(backend: MockLayaBackend | None = None, api_key: str | None = None) -> tuple[TestClient, MockLayaBackend]:
    mock = backend or MockLayaBackend()
    settings = Settings(api_key=api_key)
    return TestClient(create_app(mock, settings)), mock


def test_health_reports_cpu_preloaded() -> None:
    client, _ = make_client()
    with client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "model": "multilingual",
        "device": "cpu",
        "preloaded": True,
        "threads": 4,
    }


def test_predict_has_required_observability_fields(questions: dict[str, Any]) -> None:
    client, _ = make_client()
    with client:
        response = client.post("/api/predict", json={"state": "返金してください", "questions": questions})
    body = response.json()
    assert response.status_code == 200
    assert body["answers"]["department"]["choice"] == "billing"
    assert body["probabilities"]["department"]["billing"] == pytest.approx(0.91)
    assert body["confidence"] == pytest.approx(0.91)
    assert body["model"] == "multilingual"
    assert body["device"] == "cpu"
    assert body["inference_ms"] >= 0


def test_low_confidence_falls_back_to_human(questions: dict[str, Any]) -> None:
    client, _ = make_client(MockLayaBackend(confidence=0.69))
    with client:
        response = client.post("/api/adk/run", json={"state": "曖昧な相談", "questions": questions})
    assert response.status_code == 200
    assert response.json()["route"] == "human"
    assert response.json()["selected_skill"] == "human_fallback"


def test_adk_routes_choice_to_skill(questions: dict[str, Any]) -> None:
    client, _ = make_client(MockLayaBackend(confidence=0.9, choice="technical"))
    with client:
        response = client.post("/api/adk/run", json={"state": "APIが停止", "questions": questions})
    body = response.json()
    assert body["route"] == "technical"
    assert body["selected_skill"] == "technical_skill"
    assert [item["stage"] for item in body["trace"]] == ["Input", "Laya", "Event(route)", "selected Skill", "result"]
    assert body["trace"][1]["value"]["answers"]["department"]["choice"] == "technical"
    assert body["trace"][1]["value"]["routing"]["question"] == "department"


def test_benchmark_excludes_warmup_and_reports_statistics() -> None:
    client, backend = make_client()
    with client:
        response = client.post("/api/benchmark", json={"iterations": 10})
    body = response.json()
    assert response.status_code == 200
    assert backend.calls == 11
    assert body["iterations"] == 10
    assert body["failures"] == 0
    assert body["min_ms"] <= body["p50_ms"] <= body["p95_ms"] <= body["max_ms"]
    assert body["warmup_ms"] >= 0


@pytest.mark.parametrize(
    "payload",
    [
        {"state": "", "questions": {}},
        {"state": "test", "questions": {}},
        {"state": "test", "questions": {"bad": {"type": "unknown", "instructions": "x"}}},
    ],
)
def test_invalid_predict_input_returns_422(payload: dict[str, Any]) -> None:
    client, _ = make_client()
    with client:
        response = client.post("/api/predict", json=payload)
    assert response.status_code == 422


def test_bearer_authentication(questions: dict[str, Any]) -> None:
    client, _ = make_client(api_key="test-secret")
    payload = {"state": "返金", "questions": questions}
    with client:
        missing = client.post("/api/predict", json=payload)
        wrong = client.post("/api/predict", json=payload, headers={"Authorization": "Bearer wrong"})
        valid = client.post("/api/predict", json=payload, headers={"Authorization": "Bearer test-secret"})
        health = client.get("/health")
    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert valid.status_code == 200
    assert health.status_code == 200
