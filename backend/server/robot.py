from __future__ import annotations

import copy
import re
import threading
import unicodedata
import uuid
from dataclasses import dataclass, field
from typing import Any


GRID_SIZE = 10
HOME = (1, 8)
DIRECTIONS = ("north", "east", "south", "west")
DELTAS = {
    "north": (0, -1),
    "east": (1, 0),
    "south": (0, 1),
    "west": (-1, 0),
}
WALLS = {
    (1, 4),
    (3, 2),
    (3, 3),
    (3, 4),
    (5, 6),
    (6, 6),
    (7, 6),
    (8, 3),
}
ROBOT_INTENTS = {
    "forward",
    "backward",
    "turn_left",
    "turn_right",
    "stop",
    "reset",
    "unknown",
}
ROBOT_COMMAND_QUESTION: dict[str, dict[str, Any]] = {
    "command": {
        "type": "choice",
        "instructions": "日本語のロボット操作命令から、実行する主要動作を1つだけ分類してください",
        "criteria": {
            "forward": "前へ進む・前進・まっすぐ進む。向きは変えない",
            "backward": "後ろへ戻る・後退・バックする。向きは変えない",
            "turn_left": "その場で左を向く・左へ回る・反時計回りに90度回転する。位置は動かさない",
            "turn_right": "その場で右を向く・右へ回る・時計回りに90度回転する。位置は動かさない",
            "stop": "止まる・停止・ストップ・緊急停止",
            "reset": "最初・初期位置・ホームへ戻る・リセット",
            "unknown": "ロボット操作ではない、雑談、または意味が曖昧",
        },
    }
}


class StepsOutOfRange(ValueError):
    pass


def parse_steps(utterance: str) -> int:
    normalized = unicodedata.normalize("NFKC", utterance)
    digit = re.search(r"(?<!\d)(\d+)(?:\s*マス)?", normalized)
    if digit:
        steps = int(digit.group(1))
    else:
        words = {
            "一": 1,
            "二": 2,
            "三": 3,
            "四": 4,
            "五": 5,
            "六": 6,
            "七": 7,
            "八": 8,
            "九": 9,
            "十": 10,
            "ひとつ": 1,
            "ふたつ": 2,
            "みっつ": 3,
            "よっつ": 4,
            "いつつ": 5,
        }
        steps = next((value for word, value in words.items() if word in normalized), 1)
    if not 1 <= steps <= 5:
        raise StepsOutOfRange("movement steps must be between 1 and 5")
    return steps


@dataclass
class RobotSnapshot:
    x: int
    y: int
    direction: str
    emergency_stopped: bool
    trail: list[tuple[int, int]]


@dataclass
class RobotSession:
    session_id: str
    x: int = HOME[0]
    y: int = HOME[1]
    direction: str = "north"
    emergency_stopped: bool = False
    trail: list[tuple[int, int]] = field(default_factory=lambda: [HOME])
    history: list[RobotSnapshot] = field(default_factory=list)
    responses: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_command: str | None = None

    def snapshot(self) -> RobotSnapshot:
        return RobotSnapshot(
            x=self.x,
            y=self.y,
            direction=self.direction,
            emergency_stopped=self.emergency_stopped,
            trail=list(self.trail),
        )

    def restore(self, snapshot: RobotSnapshot) -> None:
        self.x = snapshot.x
        self.y = snapshot.y
        self.direction = snapshot.direction
        self.emergency_stopped = snapshot.emergency_stopped
        self.trail = list(snapshot.trail)


class RobotStore:
    def __init__(self) -> None:
        self._sessions: dict[str, RobotSession] = {}
        self._lock = threading.Lock()

    def create(self) -> dict[str, Any]:
        with self._lock:
            session = RobotSession(session_id=uuid.uuid4().hex)
            self._sessions[session.session_id] = session
            return self._serialize(session)

    def state(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            return self._serialize(self._require(session_id))

    def cached(self, session_id: str, command_id: str) -> dict[str, Any] | None:
        with self._lock:
            session = self._require(session_id)
            response = session.responses.get(command_id)
            return copy.deepcopy(response) if response is not None else None

    def apply(
        self,
        session_id: str,
        *,
        command_id: str,
        utterance: str,
        intent: str,
        steps: int,
        confidence: float,
        threshold: float,
        source: str,
        inference: dict[str, Any] | None = None,
        forced_rejection: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            session = self._require(session_id)
            if command_id in session.responses:
                return copy.deepcopy(session.responses[command_id])

            rejection = forced_rejection
            if rejection is None and confidence < threshold:
                rejection = "low_confidence"
            if rejection is None and intent not in ROBOT_INTENTS:
                rejection = "unknown_command"
            if rejection is None and intent == "unknown":
                rejection = "unknown_command"
            if (
                rejection is None
                and session.emergency_stopped
                and intent not in {"stop", "reset"}
            ):
                rejection = "emergency_stopped"

            applied = False
            if rejection is None:
                rejection = self._apply_safe(session, intent, steps)
                applied = rejection is None

            response = {
                "command_id": command_id,
                "utterance": utterance,
                "intent": intent,
                "steps": steps,
                "confidence": round(confidence, 4),
                "source": source,
                "applied": applied,
                "rejection_reason": rejection,
                "robot": self._serialize(session),
                "inference": inference,
            }
            session.responses[command_id] = copy.deepcopy(response)
            while len(session.responses) > 100:
                session.responses.pop(next(iter(session.responses)))
            return response

    def emergency_stop(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._require(session_id)
            if not session.emergency_stopped:
                self._remember(session)
            session.emergency_stopped = True
            session.last_command = "stop"
            return self._serialize(session)

    def reset(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._require(session_id)
            self._remember(session)
            self._reset(session)
            session.last_command = "reset"
            return self._serialize(session)

    def undo(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._require(session_id)
            if session.history:
                session.restore(session.history.pop())
                session.last_command = "undo"
            return self._serialize(session)

    def _apply_safe(self, session: RobotSession, intent: str, steps: int) -> str | None:
        if intent == "stop":
            if not session.emergency_stopped:
                self._remember(session)
            session.emergency_stopped = True
            session.last_command = intent
            return None
        if intent == "reset":
            self._remember(session)
            self._reset(session)
            session.last_command = intent
            return None
        if intent in {"turn_left", "turn_right"}:
            self._remember(session)
            offset = -1 if intent == "turn_left" else 1
            session.direction = DIRECTIONS[(DIRECTIONS.index(session.direction) + offset) % 4]
            session.last_command = intent
            return None
        if intent not in {"forward", "backward"}:
            return "unknown_command"

        dx, dy = DELTAS[session.direction]
        if intent == "backward":
            dx, dy = -dx, -dy
        path = [(session.x + dx * step, session.y + dy * step) for step in range(1, steps + 1)]
        if any(not self._inside(x, y) for x, y in path):
            return "out_of_bounds"
        if any((x, y) in WALLS for x, y in path):
            return "collision"
        self._remember(session)
        session.x, session.y = path[-1]
        session.trail.extend(path)
        session.last_command = intent
        return None

    @staticmethod
    def _inside(x: int, y: int) -> bool:
        return 0 <= x < GRID_SIZE and 0 <= y < GRID_SIZE

    @staticmethod
    def _reset(session: RobotSession) -> None:
        session.x, session.y = HOME
        session.direction = "north"
        session.emergency_stopped = False
        session.trail = [HOME]

    @staticmethod
    def _remember(session: RobotSession) -> None:
        session.history.append(session.snapshot())
        if len(session.history) > 50:
            session.history.pop(0)

    def _require(self, session_id: str) -> RobotSession:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise KeyError("robot session not found") from exc

    @staticmethod
    def _serialize(session: RobotSession) -> dict[str, Any]:
        return {
            "session_id": session.session_id,
            "grid_size": GRID_SIZE,
            "x": session.x,
            "y": session.y,
            "direction": session.direction,
            "emergency_stopped": session.emergency_stopped,
            "home": {"x": HOME[0], "y": HOME[1]},
            "walls": [{"x": x, "y": y} for x, y in sorted(WALLS)],
            "trail": [{"x": x, "y": y} for x, y in session.trail],
            "can_undo": bool(session.history),
            "last_command": session.last_command,
        }
