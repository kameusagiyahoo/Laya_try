from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.server.app import create_app
from backend.server.config import Settings
from backend.server.robot import parse_steps, resolve_robot_intent


DATASET = Path(__file__).parent / "fixtures" / "robot_intents_ja.json"


class RobotMockBackend:
    def __init__(self, choice: str = "forward", confidence: float = 0.95):
        self.ready = False
        self.choice = choice
        self.confidence = confidence
        self.calls = 0

    def start(self) -> None:
        self.ready = True

    def predict(self, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        self.calls += 1
        options = list(questions["command"]["criteria"])
        remainder = (1 - self.confidence) / (len(options) - 1)
        return {
            "model": "multilingual",
            "answers": {
                "command": {
                    "type": "choice",
                    "choice": self.choice,
                    "confidence": self.confidence,
                    "probabilities": {
                        option: self.confidence if option == self.choice else remainder
                        for option in options
                    },
                }
            },
        }


def robot_client(
    backend: RobotMockBackend | None = None, api_key: str | None = None
) -> tuple[TestClient, RobotMockBackend]:
    mock = backend or RobotMockBackend()
    settings = Settings(api_key=api_key, robot_confidence_threshold=0.80)
    return TestClient(create_app(mock, settings)), mock


def create_session(client: TestClient, headers: dict[str, str] | None = None) -> str:
    response = client.post("/api/robot/sessions", headers=headers or {})
    assert response.status_code == 200
    return response.json()["session_id"]


def test_robot_intent_dataset_is_balanced_and_unique() -> None:
    examples = json.loads(DATASET.read_text(encoding="utf-8"))
    counts = Counter(example["intent"] for example in examples)
    assert len(examples) == 105
    assert counts == {
        "forward": 15,
        "backward": 15,
        "turn_left": 15,
        "turn_right": 15,
        "stop": 15,
        "reset": 15,
        "unknown": 15,
    }
    assert len({example["utterance"] for example in examples}) == len(examples)


def test_explicit_intent_resolver_covers_dataset_safely() -> None:
    examples = json.loads(DATASET.read_text(encoding="utf-8"))
    for example in examples:
        resolution = resolve_robot_intent(example["utterance"], "forward", 0.99)
        assert resolution.intent == example["intent"], example
    compound = resolve_robot_intent("前へ進んでから右を向いて", "forward", 0.99)
    assert compound.intent == "unknown"
    assert compound.resolver == "ambiguous_command"


@pytest.mark.parametrize(
    ("utterance", "steps"),
    [("前へ3マス", 3), ("二マス戻って", 2), ("５マス進む", 5), ("前進", 1)],
)
def test_parse_steps(utterance: str, steps: int) -> None:
    assert parse_steps(utterance) == steps


def test_robot_session_and_manual_movement() -> None:
    client, _ = robot_client()
    with client:
        session_id = create_session(client)
        response = client.post(
            f"/api/robot/{session_id}/manual",
            json={"command_id": "manual-0001", "intent": "forward", "steps": 3},
        )
        state = client.get(f"/api/robot/{session_id}/state")
    assert response.status_code == 200
    assert response.json()["applied"] is True
    assert state.json()["x"] == 1
    assert state.json()["y"] == 5
    assert len(state.json()["trail"]) == 4


def test_collision_rejects_whole_movement() -> None:
    client, _ = robot_client()
    with client:
        session_id = create_session(client)
        response = client.post(
            f"/api/robot/{session_id}/manual",
            json={"command_id": "manual-0002", "intent": "forward", "steps": 5},
        )
    body = response.json()
    assert body["applied"] is False
    assert body["rejection_reason"] == "collision"
    assert (body["robot"]["x"], body["robot"]["y"]) == (1, 8)


def test_voice_command_uses_laya_and_parses_steps() -> None:
    client, _ = robot_client(RobotMockBackend(choice="forward"))
    with client:
        session_id = create_session(client)
        response = client.post(
            f"/api/robot/{session_id}/command",
            json={"command_id": "voice-0001", "utterance": "二マス進んで"},
        )
    body = response.json()
    assert body["intent"] == "forward"
    assert body["steps"] == 2
    assert body["applied"] is True
    assert body["robot"]["y"] == 6
    assert body["robot"]["x"] == 1
    assert body["rejection_reason"] is None


def test_low_confidence_and_out_of_range_do_not_move() -> None:
    low_client, _ = robot_client(RobotMockBackend(confidence=0.79))
    with low_client:
        low_session = create_session(low_client)
        low = low_client.post(
            f"/api/robot/{low_session}/command",
            json={"command_id": "voice-low1", "utterance": "少し動いて"},
        )
    assert low.json()["applied"] is False
    assert low.json()["rejection_reason"] == "low_confidence"
    assert low.json()["robot"]["y"] == 8

    range_client, _ = robot_client()
    with range_client:
        range_session = create_session(range_client)
        out_of_range = range_client.post(
            f"/api/robot/{range_session}/command",
            json={"command_id": "voice-range1", "utterance": "前へ6マス進んで"},
        )
    assert out_of_range.json()["applied"] is False
    assert out_of_range.json()["rejection_reason"] == "steps_out_of_range"
    assert out_of_range.json()["robot"]["y"] == 8


def test_command_id_is_idempotent() -> None:
    client, backend = robot_client()
    payload = {"command_id": "voice-same1", "utterance": "前へ1マス"}
    with client:
        session_id = create_session(client)
        first = client.post(f"/api/robot/{session_id}/command", json=payload)
        second = client.post(f"/api/robot/{session_id}/command", json=payload)
    assert first.json() == second.json()
    assert backend.calls == 1
    assert first.json()["robot"]["y"] == 7


def test_stop_blocks_commands_until_reset_and_undo_restores() -> None:
    client, _ = robot_client()
    with client:
        session_id = create_session(client)
        client.post(
            f"/api/robot/{session_id}/manual",
            json={"command_id": "manual-undo", "intent": "forward", "steps": 1},
        )
        undone = client.post(f"/api/robot/{session_id}/undo")
        stopped = client.post(f"/api/robot/{session_id}/stop")
        stopped_undo = client.post(f"/api/robot/{session_id}/undo")
        blocked = client.post(
            f"/api/robot/{session_id}/manual",
            json={"command_id": "manual-block", "intent": "forward", "steps": 1},
        )
        reset = client.post(f"/api/robot/{session_id}/reset")
    assert undone.json()["y"] == 8
    assert stopped.json()["emergency_stopped"] is True
    assert stopped.json()["can_undo"] is False
    assert stopped_undo.json()["emergency_stopped"] is True
    assert stopped_undo.json()["last_command"] == "stop"
    assert blocked.json()["applied"] is False
    assert blocked.json()["rejection_reason"] == "emergency_stopped"
    assert reset.json()["emergency_stopped"] is False


def test_robot_authentication_and_missing_session() -> None:
    client, _ = robot_client(api_key="robot-secret")
    headers = {"Authorization": "Bearer robot-secret"}
    with client:
        unauthorized = client.post("/api/robot/sessions")
        session_id = create_session(client, headers)
        missing = client.get("/api/robot/missing/state", headers=headers)
        valid = client.get(f"/api/robot/{session_id}/state", headers=headers)
    assert unauthorized.status_code == 401
    assert missing.status_code == 404
    assert valid.status_code == 200


def test_robot_benchmark_excludes_warmup() -> None:
    client, backend = robot_client()
    with client:
        response = client.post(
            "/api/robot/benchmark", json={"iterations": 5, "utterance": "前へ"}
        )
    body = response.json()
    assert response.status_code == 200
    assert backend.calls == 6
    assert body["iterations"] == 5
    assert body["min_ms"] <= body["p50_ms"] <= body["p95_ms"] <= body["max_ms"]
