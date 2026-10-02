from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
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


class BlockingMockLayaBackend(MockLayaBackend):
    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def predict(self, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        self.started.set()
        if not self.release.wait(timeout=5):
            raise TimeoutError("test did not release blocked inference")
        return super().predict(state, questions)


@pytest.fixture
def questions() -> dict[str, Any]:
    return {
        "department": {
            "type": "choice",
            "instructions": "どの担当へ送るべきか",
            "criteria": {"billing": "請求", "technical": "障害", "other": "その他"},
        }
    }


def make_client(
    backend: MockLayaBackend | None = None,
    api_key: str | None = None,
    max_concurrent: int = 4,
) -> tuple[TestClient, MockLayaBackend]:
    mock = backend or MockLayaBackend()
    settings = Settings(api_key=api_key, max_concurrent=max_concurrent)
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
        "max_concurrent": 4,
        "robot_sessions": {"active_sessions": 0, "controlled_sessions": 0},
    }


def test_ui_serves_dynamic_question_builder() -> None:
    client, _ = make_client()
    with client:
        launcher = client.get("/")
        page = client.get("/decision-lab")
        robot = client.get("/robot")
        robot_script = client.get("/static/robot.js?v=6")
        script = client.get("/static/server.js?v=9")
    assert launcher.status_code == 200
    assert 'href="/decision-lab"' in launcher.text
    assert 'href="/robot"' in launcher.text
    assert page.status_code == 200
    assert robot.status_code == 200
    assert 'id="robot-map"' in robot.text
    assert 'id="voice"' in robot.text
    assert 'id="emergency-stop"' in robot.text
    assert 'id="decision-resolver"' in robot.text
    assert 'id="control-status"' in robot.text
    assert 'id="acquire-control"' in robot.text
    assert 'id="latency-total"' in robot.text
    assert 'id="latency-roundtrip"' in robot.text
    assert 'id="latency-overhead"' in robot.text
    assert 'id="map-update"' in robot.text
    assert 'id="feedback-correct"' in robot.text
    assert 'data-feedback-intent="unknown"' in robot.text
    assert "/static/robot.js?v=6" in robot.text
    assert robot_script.status_code == 200
    assert "window.webkitSpeechRecognition" in robot_script.text
    assert "/command`" in robot_script.text
    assert "/lease/heartbeat`" in robot_script.text
    assert "recordLatency" in robot_script.text
    assert "data.timing?.server_ms" in robot_script.text
    assert "animateMap" in robot_script.text
    assert "MOVED · X" in robot_script.text
    assert "/feedback`" in robot_script.text
    assert "submitFeedback" in robot_script.text
    assert 'id="add-question"' in page.text
    assert 'id="primary-question"' in page.text
    assert 'id="route-question"' in page.text
    assert 'id="voice-input"' in page.text
    assert 'id="voice-status"' in page.text
    assert "/static/server.js?v=9" in page.text
    assert script.status_code == 200
    assert "route_question:routeQuestion" in script.text
    assert "laya-decision-config-v1" in script.text
    assert "window.webkitSpeechRecognition" in script.text
    assert 'recognition.lang = "ja-JP"' in script.text


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


def test_predict_accepts_score_level_list() -> None:
    client, _ = make_client()
    with client:
        response = client.post(
            "/api/predict",
            json={
                "state": "至急対応してください",
                "questions": {
                    "urgency": {
                        "type": "score",
                        "instructions": "緊急度はどの程度か",
                        "criteria": ["急がない", "早めの対応", "緊急"],
                    }
                },
            },
        )
    assert response.status_code == 200
    assert response.json()["answers"]["urgency"]["score"] == pytest.approx(1.5)


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
    assert body["runtime"] == "google-adk-2"
    assert body["route"] == "technical"
    assert body["selected_skill"] == "technical_skill"
    assert [item["stage"] for item in body["trace"]] == ["Input", "Laya", "Event(route)", "selected Skill", "result"]
    assert body["trace"][1]["value"]["answers"]["department"]["choice"] == "technical"
    assert body["trace"][1]["value"]["routing"]["question"] == "department"
    assert any(event["route"] == "technical" for event in body["adk_events"])
    assert any("technical_skill" in event["node"] for event in body["adk_events"])


def test_adk_routes_with_selected_question() -> None:
    route_questions = {
        "destination": {
            "type": "choice",
            "instructions": "どこへ送るか",
            "criteria": {"billing": "請求", "technical": "技術", "other": "その他"},
        }
    }
    client, _ = make_client(MockLayaBackend(confidence=0.9, choice="technical"))
    with client:
        response = client.post(
            "/api/adk/run",
            json={
                "state": "APIが停止",
                "questions": route_questions,
                "route_question": "destination",
            },
        )
    body = response.json()
    assert response.status_code == 200
    assert body["route"] == "technical"
    assert body["trace"][1]["value"]["routing"]["question"] == "destination"


def test_adk_rejects_invalid_route_question(questions: dict[str, Any]) -> None:
    client, _ = make_client()
    with client:
        missing = client.post(
            "/api/adk/run",
            json={"state": "test", "questions": questions, "route_question": "missing"},
        )
        wrong_type = client.post(
            "/api/adk/run",
            json={
                "state": "test",
                "questions": {
                    "urgency": {
                        "type": "score",
                        "instructions": "緊急度",
                        "criteria": {"0": "低", "1": "高"},
                    }
                },
                "route_question": "urgency",
            },
        )
    assert missing.status_code == 422
    assert wrong_type.status_code == 422


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


def test_oversized_predict_input_returns_422(questions: dict[str, Any]) -> None:
    too_many_options = {
        "department": {
            "type": "choice",
            "instructions": "分類してください",
            "criteria": {f"option-{index}": "説明" for index in range(101)},
        }
    }
    client, _ = make_client()
    with client:
        state_response = client.post(
            "/api/predict", json={"state": "x" * 50_001, "questions": questions}
        )
        options_response = client.post(
            "/api/predict", json={"state": "test", "questions": too_many_options}
        )
    assert state_response.status_code == 422
    assert options_response.status_code == 422


def test_busy_server_returns_retryable_503(questions: dict[str, Any]) -> None:
    backend = BlockingMockLayaBackend()
    client, _ = make_client(backend, max_concurrent=1)
    payload = {"state": "返金", "questions": questions}

    with client, ThreadPoolExecutor(max_workers=1) as executor:
        first_request = executor.submit(client.post, "/api/predict", json=payload)
        assert backend.started.wait(timeout=2)
        busy_response = client.post("/api/predict", json=payload)
        backend.release.set()
        first_response = first_request.result(timeout=2)

    assert first_response.status_code == 200
    assert busy_response.status_code == 503
    assert busy_response.headers["Retry-After"] == "1"


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
