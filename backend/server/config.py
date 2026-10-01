from __future__ import annotations

import os
from dataclasses import dataclass


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(minimum, value)


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    device: str = "cpu"
    model: str = "multilingual"
    preload: bool = True
    threads: int = 4
    max_loaded: int = 1
    max_concurrent: int = 4
    confidence_threshold: float = 0.70
    robot_confidence_threshold: float = 0.80
    robot_session_ttl_seconds: int = 3600
    robot_lease_seconds: int = 30
    robot_max_sessions: int = 100
    api_key: str | None = None
    host: str = "127.0.0.1"
    port: int = 8000

    @classmethod
    def from_env(cls) -> "Settings":
        models = [x.strip() for x in os.getenv("LAYA_MODELS", "multilingual").split(",") if x.strip()]
        model = models[0] if models else "multilingual"
        return cls(
            device=os.getenv("LAYA_DEVICE", "cpu").strip() or "cpu",
            model=model,
            preload=_bool_env("LAYA_PRELOAD", True),
            threads=_int_env("LAYA_THREADS", 4),
            max_loaded=_int_env("LAYA_MAX_LOADED", 1),
            max_concurrent=_int_env("LAYA_MAX_CONCURRENT", 4),
            confidence_threshold=min(1.0, max(0.0, _float_env("LAYA_CONFIDENCE_THRESHOLD", 0.70))),
            robot_confidence_threshold=min(
                1.0, max(0.0, _float_env("LAYA_ROBOT_CONFIDENCE_THRESHOLD", 0.80))
            ),
            robot_session_ttl_seconds=_int_env("LAYA_ROBOT_SESSION_TTL_SECONDS", 3600, 60),
            robot_lease_seconds=_int_env("LAYA_ROBOT_LEASE_SECONDS", 30, 10),
            robot_max_sessions=_int_env("LAYA_ROBOT_MAX_SESSIONS", 100),
            api_key=os.getenv("LAYA_API_KEY") or None,
            host=os.getenv("LAYA_HOST", "127.0.0.1"),
            port=_int_env("LAYA_PORT", 8000),
        )
