from __future__ import annotations

import asyncio
import hmac
import math
import statistics
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings
from .inference import InferenceBackend, LayaBackend, _answer_confidence, enrich_result
from .robot import (
    ROBOT_COMMAND_QUESTION,
    ROBOT_INTENTS,
    RobotControllerDenied,
    RobotLeaseConflict,
    RobotStore,
    StepsOutOfRange,
    parse_steps,
    resolve_robot_intent,
)
from .routing import DEFAULT_ROUTE_QUESTION
from .schemas import (
    AdkRunRequest,
    BenchmarkRequest,
    PredictRequest,
    RobotBenchmarkRequest,
    RobotCommandRequest,
    RobotManualRequest,
)


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
    robot_store = RobotStore(
        session_ttl_seconds=settings.robot_session_ttl_seconds,
        lease_seconds=settings.robot_lease_seconds,
        max_sessions=settings.robot_max_sessions,
    )
    inference_lock = asyncio.Lock()
    admission_lock = asyncio.Lock()
    admitted_requests = 0

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await asyncio.to_thread(backend.start)
        async def cleanup_robot_sessions() -> None:
            while True:
                await asyncio.sleep(60)
                await asyncio.to_thread(robot_store.cleanup)

        cleanup_task = asyncio.create_task(cleanup_robot_sessions())
        try:
            yield
        finally:
            cleanup_task.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup_task

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
        robot_sessions = robot_store.stats()
        return {
            "status": "ready" if backend.ready else "starting",
            "model": settings.model,
            "device": settings.device,
            "preloaded": settings.preload and backend.ready,
            "threads": settings.threads,
            "max_concurrent": settings.max_concurrent,
            "robot_sessions": robot_sessions,
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

    def controller_header(value: str | None) -> str:
        if not value:
            raise HTTPException(status_code=403, detail="robot controller lease is required")
        return value

    def robot_state(
        session_id: str, robot_controller: str | None = None
    ) -> dict[str, Any]:
        try:
            return robot_store.state(session_id, robot_controller)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="robot session not found") from exc

    def robot_error(exc: Exception) -> HTTPException:
        if isinstance(exc, KeyError):
            return HTTPException(status_code=404, detail="robot session not found")
        if isinstance(exc, RobotLeaseConflict):
            return HTTPException(
                status_code=409,
                detail="robot controller lease is already held",
                headers={"Retry-After": str(settings.robot_lease_seconds)},
            )
        return HTTPException(status_code=403, detail="robot controller lease is missing or expired")

    @app.post("/api/robot/sessions", dependencies=[Depends(authorize)])
    async def create_robot_session(
        robot_controller_id: str | None = Header(default=None, alias="X-Robot-Controller-ID"),
    ) -> dict[str, Any]:
        return robot_store.create(robot_controller_id or "anonymous-controller")

    @app.get("/api/robot/{session_id}/state", dependencies=[Depends(authorize)])
    async def get_robot_state(
        session_id: str,
        robot_controller: str | None = Header(default=None, alias="X-Robot-Controller"),
    ) -> dict[str, Any]:
        return robot_state(session_id, robot_controller)

    @app.post("/api/robot/{session_id}/lease/acquire", dependencies=[Depends(authorize)])
    async def acquire_robot_lease(
        session_id: str,
        robot_controller_id: str | None = Header(default=None, alias="X-Robot-Controller-ID"),
    ) -> dict[str, Any]:
        try:
            return robot_store.acquire(session_id, robot_controller_id or "anonymous-controller")
        except (KeyError, RobotLeaseConflict) as exc:
            raise robot_error(exc) from exc

    @app.post("/api/robot/{session_id}/lease/heartbeat", dependencies=[Depends(authorize)])
    async def heartbeat_robot_lease(
        session_id: str,
        robot_controller: str | None = Header(default=None, alias="X-Robot-Controller"),
    ) -> dict[str, Any]:
        try:
            return robot_store.heartbeat(session_id, controller_header(robot_controller))
        except (KeyError, RobotControllerDenied) as exc:
            raise robot_error(exc) from exc

    @app.post("/api/robot/{session_id}/lease/release", dependencies=[Depends(authorize)])
    async def release_robot_lease(
        session_id: str,
        robot_controller: str | None = Header(default=None, alias="X-Robot-Controller"),
    ) -> dict[str, Any]:
        try:
            return robot_store.release(session_id, controller_header(robot_controller))
        except (KeyError, RobotControllerDenied) as exc:
            raise robot_error(exc) from exc

    @app.post("/api/robot/{session_id}/command", dependencies=[Depends(authorize)])
    async def robot_command(
        session_id: str,
        request: RobotCommandRequest,
        robot_controller: str | None = Header(default=None, alias="X-Robot-Controller"),
    ) -> dict[str, Any]:
        server_started = time.perf_counter()
        controller = controller_header(robot_controller)
        try:
            cached = robot_store.cached(session_id, request.command_id, controller)
        except (KeyError, RobotControllerDenied) as exc:
            raise robot_error(exc) from exc
        if cached is not None:
            cached["timing"] = {
                "server_ms": round((time.perf_counter() - server_started) * 1000, 3),
                "cached": True,
            }
            return cached

        async with admission_slot():
            result = await infer(request.utterance, ROBOT_COMMAND_QUESTION)
        answer = (result.get("answers") or {}).get("command") or {}
        intent = str(answer.get("choice", "unknown"))
        if intent not in ROBOT_INTENTS:
            intent = "unknown"
        laya_confidence = _answer_confidence(answer)
        resolution = resolve_robot_intent(request.utterance, intent, laya_confidence)
        intent = resolution.intent
        confidence = resolution.confidence
        forced_rejection = None
        steps = 1
        if intent in {"forward", "backward"}:
            try:
                steps = parse_steps(request.utterance)
            except StepsOutOfRange:
                forced_rejection = "steps_out_of_range"
        inference = {
            "model": result.get("model", settings.model),
            "device": result.get("device", settings.device),
            "inference_ms": result.get("inference_ms", 0.0),
            "probabilities": answer.get("probabilities", {}),
            "raw_intent": str(answer.get("choice", "unknown")),
            "raw_confidence": round(laya_confidence, 4),
            "resolver": resolution.resolver,
        }
        try:
            response = robot_store.apply(
                session_id,
                command_id=request.command_id,
                utterance=request.utterance,
                intent=intent,
                steps=steps,
                confidence=confidence,
                threshold=settings.robot_confidence_threshold,
                source="voice",
                resolver=resolution.resolver,
                inference=inference,
                forced_rejection=forced_rejection,
                controller_token=controller,
            )
            response["timing"] = {
                "server_ms": round((time.perf_counter() - server_started) * 1000, 3),
                "cached": False,
            }
            return response
        except (KeyError, RobotControllerDenied) as exc:
            raise robot_error(exc) from exc

    @app.post("/api/robot/{session_id}/manual", dependencies=[Depends(authorize)])
    async def robot_manual(
        session_id: str,
        request: RobotManualRequest,
        robot_controller: str | None = Header(default=None, alias="X-Robot-Controller"),
    ) -> dict[str, Any]:
        controller = controller_header(robot_controller)
        try:
            return robot_store.apply(
                session_id,
                command_id=request.command_id,
                utterance=request.intent,
                intent=request.intent,
                steps=request.steps,
                confidence=1.0,
                threshold=0.0,
                source="manual",
                controller_token=controller,
            )
        except (KeyError, RobotControllerDenied) as exc:
            raise robot_error(exc) from exc

    @app.post("/api/robot/{session_id}/stop", dependencies=[Depends(authorize)])
    async def robot_stop(
        session_id: str,
        robot_controller: str | None = Header(default=None, alias="X-Robot-Controller"),
    ) -> dict[str, Any]:
        try:
            return robot_store.emergency_stop(session_id, controller_header(robot_controller))
        except (KeyError, RobotControllerDenied) as exc:
            raise robot_error(exc) from exc

    @app.post("/api/robot/{session_id}/undo", dependencies=[Depends(authorize)])
    async def robot_undo(
        session_id: str,
        robot_controller: str | None = Header(default=None, alias="X-Robot-Controller"),
    ) -> dict[str, Any]:
        try:
            return robot_store.undo(session_id, controller_header(robot_controller))
        except (KeyError, RobotControllerDenied) as exc:
            raise robot_error(exc) from exc

    @app.post("/api/robot/{session_id}/reset", dependencies=[Depends(authorize)])
    async def robot_reset(
        session_id: str,
        robot_controller: str | None = Header(default=None, alias="X-Robot-Controller"),
    ) -> dict[str, Any]:
        try:
            return robot_store.reset(session_id, controller_header(robot_controller))
        except (KeyError, RobotControllerDenied) as exc:
            raise robot_error(exc) from exc

    @app.post("/api/robot/benchmark", dependencies=[Depends(authorize)])
    async def robot_benchmark(request: RobotBenchmarkRequest) -> dict[str, Any]:
        async with admission_slot():
            warmup_started = time.perf_counter()
            await infer(request.utterance, ROBOT_COMMAND_QUESTION)
            warmup_ms = (time.perf_counter() - warmup_started) * 1000
            samples: list[float] = []
            failures = 0
            for _ in range(request.iterations):
                try:
                    result = await infer(request.utterance, ROBOT_COMMAND_QUESTION)
                    samples.append(float(result["inference_ms"]))
                except Exception:
                    failures += 1
            if not samples:
                raise HTTPException(status_code=500, detail="all robot benchmark iterations failed")
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

    return app
