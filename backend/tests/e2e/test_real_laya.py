from __future__ import annotations

import os

import pytest

from backend.server.config import Settings
from backend.server.inference import LayaBackend
from backend.server.routing import DEFAULT_ROUTE_QUESTION


pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(os.getenv("RUN_LAYA_E2E") != "1", reason="set RUN_LAYA_E2E=1 to load the real model"),
]


def test_real_multilingual_cpu_prediction() -> None:
    settings = Settings(device="cpu", model="multilingual", preload=True, threads=4, max_loaded=1)
    backend = LayaBackend(settings)
    backend.start()
    result = backend.predict("二重請求されています。返金してください。", DEFAULT_ROUTE_QUESTION)

    assert backend.ready is True
    assert result["answers"]["department"]["choice"] in {"billing", "technical", "sales", "other"}
