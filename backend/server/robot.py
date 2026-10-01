from __future__ import annotations

import copy
import hashlib
import hmac
import math
import re
import secrets
import threading
import time
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


class RobotControllerDenied(PermissionError):
    pass


class RobotLeaseConflict(RuntimeError):
    pass


@dataclass(frozen=True)
class RobotIntentResolution:
    intent: str
    confidence: float
    resolver: str


INTENT_PATTERNS = {
    "forward": re.compile(r"(?<![名午以])前|前進|直進|正面|まっすぐ|向いている方"),
    "backward": re.compile(r"後ろ|後方|後退|バック|下が|向きを変えずに戻|向きのまま戻"),
    "turn_left": re.compile(r"左|反時計"),
    "turn_right": re.compile(r"右|(?<!反)時計"),
    "stop": re.compile(r"止|停止|ストップ|中止|待機|動かない|やめ"),
    "reset": re.compile(r"初期|リセット|最初|ホーム|スタート|原点|元の|開始位置|復帰|帰還"),
}
COMMAND_CUE = re.compile(r"動|進|回|向|戻|止|旋回|ターン|バック|下が|待機|復帰|帰還")


def resolve_robot_intent(
    utterance: str, laya_intent: str, laya_confidence: float
) -> RobotIntentResolution:
    normalized = unicodedata.normalize("NFKC", utterance)
    matches = [intent for intent, pattern in INTENT_PATTERNS.items() if pattern.search(normalized)]
    if len(matches) == 1:
        return RobotIntentResolution(matches[0], 1.0, "explicit_command")
    if len(matches) > 1:
        return RobotIntentResolution("unknown", 1.0, "ambiguous_command")
    if not COMMAND_CUE.search(normalized):
        return RobotIntentResolution("unknown", 1.0, "safety_gate")
    intent = laya_intent if laya_intent in ROBOT_INTENTS else "unknown"
    return RobotIntentResolution(intent, laya_confidence, "laya")


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
    created_at: float
    last_accessed_at: float
    x: int = HOME[0]
    y: int = HOME[1]
    direction: str = "north"
    emergency_stopped: bool = False
    trail: list[tuple[int, int]] = field(default_factory=lambda: [HOME])
    history: list[RobotSnapshot] = field(default_factory=list)
    responses: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_command: str | None = None
    controller_id: str | None = None
    controller_token_hash: str | None = None
    lease_expires_at: float = 0.0

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
    def __init__(
        self,
        *,
        session_ttl_seconds: int = 3600,
        lease_seconds: int = 30,
        max_sessions: int = 100,
        clock: Any = time.monotonic,
    ) -> None:
        self._sessions: dict[str, RobotSession] = {}
        self._lock = threading.Lock()
        self._session_ttl_seconds = session_ttl_seconds
        self._lease_seconds = lease_seconds
        self._max_sessions = max_sessions
        self._clock = clock

    def create(self, controller_id: str) -> dict[str, Any]:
        with self._lock:
            now = self._clock()
            self._cleanup(now)
            if len(self._sessions) >= self._max_sessions:
                oldest = min(self._sessions.values(), key=lambda item: item.last_accessed_at)
                del self._sessions[oldest.session_id]
            session = RobotSession(
                session_id=uuid.uuid4().hex,
                created_at=now,
                last_accessed_at=now,
            )
            self._sessions[session.session_id] = session
            token = self._grant(session, controller_id, now)
            result = self._serialize(session, token, now)
            result["controller_token"] = token
            return result

    def state(self, session_id: str, controller_token: str | None = None) -> dict[str, Any]:
        with self._lock:
            now = self._clock()
            session = self._require(session_id, now)
            return self._serialize(session, controller_token, now)

    def acquire(self, session_id: str, controller_id: str) -> dict[str, Any]:
        with self._lock:
            now = self._clock()
            session = self._require(session_id, now)
            self._expire_lease(session, now)
            if session.controller_token_hash is not None:
                raise RobotLeaseConflict("robot controller lease is already held")
            token = self._grant(session, controller_id, now)
            result = self._serialize(session, token, now)
            result["controller_token"] = token
            return result

    def heartbeat(self, session_id: str, controller_token: str) -> dict[str, Any]:
        with self._lock:
            now = self._clock()
            session = self._require_controller(session_id, controller_token, now)
            session.lease_expires_at = now + self._lease_seconds
            return self._serialize(session, controller_token, now)

    def release(self, session_id: str, controller_token: str) -> dict[str, Any]:
        with self._lock:
            now = self._clock()
            session = self._require_controller(session_id, controller_token, now)
            session.controller_id = None
            session.controller_token_hash = None
            session.lease_expires_at = 0.0
            return self._serialize(session, None, now)

    def cleanup(self) -> int:
        with self._lock:
            return self._cleanup(self._clock())

    def stats(self) -> dict[str, int]:
        with self._lock:
            now = self._clock()
            self._cleanup(now)
            for session in self._sessions.values():
                self._expire_lease(session, now)
            return {
                "active_sessions": len(self._sessions),
                "controlled_sessions": sum(
                    session.controller_token_hash is not None for session in self._sessions.values()
                ),
            }

    def cached(
        self, session_id: str, command_id: str, controller_token: str
    ) -> dict[str, Any] | None:
        with self._lock:
            session = self._require_controller(session_id, controller_token, self._clock())
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
        resolver: str = "manual",
        inference: dict[str, Any] | None = None,
        forced_rejection: str | None = None,
        controller_token: str,
    ) -> dict[str, Any]:
        with self._lock:
            session = self._require_controller(session_id, controller_token, self._clock())
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
                "resolver": resolver,
                "applied": applied,
                "rejection_reason": rejection,
                "robot": self._serialize(session, controller_token),
                "inference": inference,
            }
            session.responses[command_id] = copy.deepcopy(response)
            while len(session.responses) > 100:
                session.responses.pop(next(iter(session.responses)))
            return response

    def emergency_stop(self, session_id: str, controller_token: str) -> dict[str, Any]:
        with self._lock:
            session = self._require_controller(session_id, controller_token, self._clock())
            if not session.emergency_stopped:
                self._remember(session)
            session.emergency_stopped = True
            session.last_command = "stop"
            return self._serialize(session, controller_token)

    def reset(self, session_id: str, controller_token: str) -> dict[str, Any]:
        with self._lock:
            session = self._require_controller(session_id, controller_token, self._clock())
            self._remember(session)
            self._reset(session)
            session.last_command = "reset"
            return self._serialize(session, controller_token)

    def undo(self, session_id: str, controller_token: str) -> dict[str, Any]:
        with self._lock:
            session = self._require_controller(session_id, controller_token, self._clock())
            if session.emergency_stopped:
                return self._serialize(session, controller_token)
            if session.history:
                session.restore(session.history.pop())
                session.last_command = "undo"
            return self._serialize(session, controller_token)

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

    def _require(self, session_id: str, now: float) -> RobotSession:
        self._cleanup(now)
        try:
            session = self._sessions[session_id]
        except KeyError as exc:
            raise KeyError("robot session not found") from exc
        session.last_accessed_at = now
        self._expire_lease(session, now)
        return session

    def _require_controller(
        self, session_id: str, controller_token: str, now: float
    ) -> RobotSession:
        session = self._require(session_id, now)
        if not self._is_controller(session, controller_token, now):
            raise RobotControllerDenied("robot controller lease is missing or expired")
        return session

    def _grant(self, session: RobotSession, controller_id: str, now: float) -> str:
        token = secrets.token_urlsafe(32)
        session.controller_id = controller_id[:128]
        session.controller_token_hash = self._token_hash(token)
        session.lease_expires_at = now + self._lease_seconds
        return token

    @staticmethod
    def _token_hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8", "surrogateescape")).hexdigest()

    def _is_controller(
        self, session: RobotSession, controller_token: str | None, now: float
    ) -> bool:
        self._expire_lease(session, now)
        if not controller_token or session.controller_token_hash is None:
            return False
        return hmac.compare_digest(
            session.controller_token_hash,
            self._token_hash(controller_token),
        )

    @staticmethod
    def _expire_lease(session: RobotSession, now: float) -> None:
        if session.controller_token_hash is not None and session.lease_expires_at <= now:
            session.controller_id = None
            session.controller_token_hash = None
            session.lease_expires_at = 0.0

    def _cleanup(self, now: float) -> int:
        expired = [
            session_id
            for session_id, session in self._sessions.items()
            if now - session.last_accessed_at >= self._session_ttl_seconds
        ]
        for session_id in expired:
            del self._sessions[session_id]
        return len(expired)

    def _serialize(
        self, session: RobotSession, controller_token: str | None = None, now: float | None = None
    ) -> dict[str, Any]:
        now = self._clock() if now is None else now
        self._expire_lease(session, now)
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
            "can_undo": bool(session.history) and not session.emergency_stopped,
            "last_command": session.last_command,
            "control": {
                "available": session.controller_token_hash is None,
                "is_controller": self._is_controller(session, controller_token, now),
                "controller_id": session.controller_id,
                "expires_in_seconds": max(0, math.ceil(session.lease_expires_at - now))
                if session.controller_token_hash is not None
                else 0,
            },
        }
