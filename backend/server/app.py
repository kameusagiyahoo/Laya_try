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
from .routing import DEFAULT_ROUTE_QUESTION
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
    admission_lock = asyncio.Lock()
    admitted_requests = 0

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
        expected = f"Bearer {settings.api_key}".encode("utf-8", "surrogateescape")
        supplied = (authorization or "").encode("utf-8", "surrogateescape")
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    async def infer(state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        async with inference_lock:
            started = time.perf_counter()
            raw = await asyncio.to_thread(backend.predict, state, questions)
            elapsed = (time.perf_counter() - started) * 1000
        return enrich_result(raw, settings, elapsed)

    @asynccontextmanager
    async def admission_slot():
        nonlocal admitted_requests
        async with admission_lock:
            if admitted_requests >= settings.max_concurrent:
                raise HTTPException(
                    status_code=503,
                    detail="server is busy; retry shortly",
                    headers={"Retry-After": "1"},
                )
            admitted_requests += 1
        try:
            yield
        finally:
            async with admission_lock:
                admitted_requests -= 1

    from .adk_runtime import AdkRuntime

    adk_runtime = AdkRuntime(infer, settings.confidence_threshold)

    @app.get("/", include_in_schema=False)
    async def ui() -> FileResponse:
        return FileResponse(static_dir / "launcher.html")

    @app.get("/decision-lab", include_in_schema=False)
    async def decision_lab() -> FileResponse:
        return FileResponse(static_dir / "index.html")

    @app.get("/robot", include_in_schema=False)
    async def robot_ui() -> FileResponse:
        return FileResponse(static_dir / "robot.html")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ready" if backend.ready else "starting",
            "model": settings.model,
            "device": settings.device,
            "preloaded": settings.preload and backend.ready,
            "threads": settings.threads,
            "max_concurrent": settings.max_concurrent,
        }

    @app.post("/api/predict", dependencies=[Depends(authorize)])
    @app.post("/v1/systemone", dependencies=[Depends(authorize)])
    async def predict(request: PredictRequest) -> dict[str, Any]:
        async with admission_slot():
            return await infer(request.state, request.questions)

    @app.post("/api/benchmark", dependencies=[Depends(authorize)])
    async def benchmark(request: BenchmarkRequest) -> dict[str, Any]:
        async with admission_slot():
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
        async with admission_slot():
            questions = request.questions or DEFAULT_ROUTE_QUESTION
            return await adk_runtime.run(request.state, questions, request.route_question)

    return app
