from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from google.adk import Event, Workflow
from google.adk.runners import InMemoryRunner
from google.adk.workflow import START
from google.genai import types

from .routing import SKILL_RESULTS, select_route


Infer = Callable[[Any, dict[str, Any]], Awaitable[dict[str, Any]]]


class AdkRuntime:
    """Real ADK 2 workflow sharing FastAPI's resident Laya backend."""

    def __init__(self, infer: Infer, confidence_threshold: float):
        self.infer = infer
        self.confidence_threshold = confidence_threshold
        self.workflow = self._build_workflow()
        self.runner = InMemoryRunner(node=self.workflow, app_name="laya_server")

    def _build_workflow(self) -> Workflow:
        async def laya_route(
            node_input: str, questions: dict[str, Any], route_question: str
        ) -> Event:
            result = await self.infer(node_input, questions)
            route, choice, confidence = select_route(
                result, self.confidence_threshold, route_question
            )
            return Event(
                route=route,
                output={
                    "input": node_input,
                    "laya": result,
                    "choice": choice,
                    "confidence": confidence,
                    "route": route,
                    "route_question": route_question,
                },
                state={"selected_route": route},
            )

        def skill_output(node_input: dict[str, Any], route: str) -> dict[str, Any]:
            return {
                **node_input,
                "selected_skill": f"{route}_skill" if route != "human" else "human_fallback",
                "result": SKILL_RESULTS[route],
            }

        def billing_skill(node_input: dict[str, Any]) -> dict[str, Any]:
            return skill_output(node_input, "billing")

        def technical_skill(node_input: dict[str, Any]) -> dict[str, Any]:
            return skill_output(node_input, "technical")

        def sales_skill(node_input: dict[str, Any]) -> dict[str, Any]:
            return skill_output(node_input, "sales")

        def other_skill(node_input: dict[str, Any]) -> dict[str, Any]:
            return skill_output(node_input, "other")

        def human_fallback(node_input: dict[str, Any]) -> dict[str, Any]:
            return skill_output(node_input, "human")

        return Workflow(
            name="laya_server_workflow",
            edges=[
                (
                    START,
                    laya_route,
                    {
                        "billing": billing_skill,
                        "technical": technical_skill,
                        "sales": sales_skill,
                        "other": other_skill,
                        "human": human_fallback,
                    },
                )
            ],
        )

    async def run(
        self, state: str, questions: dict[str, Any], route_question: str = "department"
    ) -> dict[str, Any]:
        user_id = "laya-api"
        session_id = uuid.uuid4().hex
        await self.runner.session_service.create_session(
            app_name=self.runner.app_name,
            user_id=user_id,
            session_id=session_id,
            state={"questions": questions, "route_question": route_question},
        )
        events: list[Event] = []
        try:
            message = types.Content(role="user", parts=[types.Part.from_text(text=state)])
            async for event in self.runner.run_async(
                user_id=user_id,
                session_id=session_id,
                new_message=message,
            ):
                events.append(event)
        finally:
            await self.runner.session_service.delete_session(
                app_name=self.runner.app_name,
                user_id=user_id,
                session_id=session_id,
            )

        routed = next(
            (event for event in events if getattr(event.actions, "route", None) is not None),
            None,
        )
        skill_event = next(
            (
                event
                for event in reversed(events)
                if isinstance(event.output, dict) and event.output.get("selected_skill")
            ),
            None,
        )
        if routed is None or skill_event is None:
            raise RuntimeError("ADK workflow completed without route or skill output")

        route = str(routed.actions.route)
        output = dict(skill_event.output)
        laya = output["laya"]
        event_trace = [
            {
                "author": event.author,
                "node": event.node_info.path,
                "route": getattr(event.actions, "route", None),
            }
            for event in events
            if event.author or event.node_info.path or getattr(event.actions, "route", None) is not None
        ]
        return {
            "runtime": "google-adk-2",
            "route": route,
            "selected_skill": output["selected_skill"],
            "result": output["result"],
            "trace": [
                {"stage": "Input", "value": state},
                {
                    "stage": "Laya",
                    "value": {
                        "answers": laya.get("answers", {}),
                        "routing": {
                            "question": output["route_question"],
                            "choice": output["choice"],
                            "confidence": output["confidence"],
                        },
                    },
                },
                {"stage": "Event(route)", "value": route},
                {"stage": "selected Skill", "value": output["selected_skill"]},
                {"stage": "result", "value": output["result"]},
            ],
            "adk_events": event_trace,
            "laya": laya,
        }
