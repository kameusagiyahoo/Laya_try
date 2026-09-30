from __future__ import annotations

import asyncio
import hmac
import math
import statistics
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings
from .inference import InferenceBackend, LayaBackend, enrich_result
from .routing import DEFAULT_ROUTE_QUESTION, build_trace
from .schemas import AdkRunRequest, BenchmarkRequest, PredictRequest


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def create_app(
    backend: InferenceBackend | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    backend = backend or LayaBackend(settings)
    inference_lock = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await asyncio.to_thread(backend.start)
        yield

    app = FastAPI(title="Laya Try Server Mode", version="1.0.0", lifespan=lifespan)
    static_dir = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    async def authorize(authorization: str | None = Header(default=None)) -> None:
        if settings.api_key is None:
            return
        expected = f"Bearer {settings.api_key}"
        if not hmac.compare_digest(authorization or "", expected):
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    async def infer(state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        async with inference_lock:
            started = time.perf_counter()
            raw = await asyncio.to_thread(backend.predict, state, questions)
            elapsed = (time.perf_counter() - started) * 1000
        return enrich_result(raw, settings, elapsed)

    @app.get("/", include_in_schema=False)
    async def ui() -> FileResponse:
        return FileResponse(static_dir / "index.html")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ready" if backend.ready else "starting",
            "model": settings.model,
            "device": settings.device,
            "preloaded": settings.preload and backend.ready,
            "threads": settings.threads,
        }

    @app.post("/api/predict", dependencies=[Depends(authorize)])
    @app.post("/v1/systemone", dependencies=[Depends(authorize)])
    async def predict(request: PredictRequest) -> dict[str, Any]:
        return await infer(request.state, request.questions)

    @app.post("/api/benchmark", dependencies=[Depends(authorize)])
    async def benchmark(request: BenchmarkRequest) -> dict[str, Any]:
        questions = request.questions or DEFAULT_ROUTE_QUESTION
        warmup_started = time.perf_counter()
        try:
            await infer(request.state, questions)
        except Exception as exc:
            raise HTTPException(status_code=500, detail="benchmark warmup failed") from exc
        warmup_ms = (time.perf_counter() - warmup_started) * 1000

        samples: list[float] = []
        failures = 0
        for _ in range(request.iterations):
            try:
                result = await infer(request.state, questions)
                samples.append(float(result["inference_ms"]))
            except Exception:
                failures += 1
        if not samples:
            raise HTTPException(status_code=500, detail="all benchmark iterations failed")
        return {
            "warmup_ms": round(warmup_ms, 3),
            "mean_ms": round(statistics.fmean(samples), 3),
            "p50_ms": round(_percentile(samples, 0.50), 3),
            "p95_ms": round(_percentile(samples, 0.95), 3),
            "min_ms": round(min(samples), 3),
            "max_ms": round(max(samples), 3),
            "failures": failures,
            "iterations": request.iterations,
            "model": settings.model,
            "device": settings.device,
        }

    @app.post("/api/adk/run", dependencies=[Depends(authorize)])
    async def adk_run(request: AdkRunRequest) -> dict[str, Any]:
        questions = request.questions or DEFAULT_ROUTE_QUESTION
        result = await infer(request.state, questions)
        return build_trace(request.state, result, settings.confidence_threshold)

    return app
