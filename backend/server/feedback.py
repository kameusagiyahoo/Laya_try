from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class RobotFeedbackStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def record(self, payload: dict[str, Any]) -> str:
        feedback_id = uuid.uuid4().hex
        entry = {
            "feedback_id": feedback_id,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            **payload,
        }
        encoded = (json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            existed = self.path.exists()
            descriptor = os.open(
                self.path,
                os.O_WRONLY | os.O_CREAT | os.O_APPEND,
                0o600,
            )
            with os.fdopen(descriptor, "ab") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            if not existed:
                os.chmod(self.path, 0o600)
        return feedback_id
