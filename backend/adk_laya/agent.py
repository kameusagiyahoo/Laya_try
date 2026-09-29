"""Google ADK 2 + Laya local routing example.

This intentionally keeps the first runnable version simple:
- ADK 2 Workflow Runtime owns orchestration.
- Laya performs typed decisions locally.
- Laya's choice result becomes Event(route=...).
- Low-confidence decisions fall back to a human route.
- Skill nodes are deterministic functions, so no cloud LLM is required.

Run from the backend directory:
    python -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
    adk run adk_laya

Or launch the ADK developer UI:
    adk web
"""

from __future__ import annotations

from typing import Any

from google.adk import Event
from google.adk import Workflow
from laya import Router


CONFIDENCE_THRESHOLD = 0.70

# Lazy loading keeps import/startup light. The checkpoint is downloaded/loaded
# on the first predict call.
laya_router = Router(preload=False)

QUESTIONS: dict[str, dict[str, Any]] = {
    "department": {
        "type": "choice",
        "instructions": "Which specialist should handle this request?",
        "criteria": {
            "billing": "billing, invoices, payments, refunds, duplicate charges",
            "technical": "bugs, outages, login problems, API or system errors",
            "sales": "pricing, plans, quotes, contracts, purchase or rollout questions",
            "other": "requests that do not clearly match the other specialists",
        },
    },
    "urgency": {
        "type": "score",
        "instructions": "How urgent is this request?",
        "criteria": [
            "not urgent",
            "should be handled soon",
            "critical, blocking, or requires immediate handling",
        ],
    },
    "churn_risk": {
        "type": "noul",
        "instructions": "Does the user indicate they may cancel, leave, or stop using the service?",
    },
}


def _confidence(answer: dict[str, Any]) -> float:
    """Read confidence across current Laya result field names."""
    for key in ("answer_confidence", "confidence"):
        value = answer.get(key)
        if value is not None:
            return float(value)
    return 0.0


def laya_route(node_input: str):
    """Use local Laya as the System-1 routing node."""
    state = {"ticket": node_input}
    result = laya_router.predict(state, QUESTIONS)

    department = result["answers"]["department"]
    choice = str(department["choice"])
    confidence = _confidence(department)

    route = choice if confidence >= CONFIDENCE_THRESHOLD else "human"

    # ADK 2 graph routing is driven by Event(route=...).
    # Keep the full Laya result in workflow state for observability/debugging.
    yield Event(
        route=route,
        state={
            "ticket": node_input,
            "laya_result": result,
            "laya_choice": choice,
            "laya_confidence": confidence,
            "selected_route": route,
        },
    )


def billing_skill():
    yield Event(message="Billing skill selected. No external side effect is executed in this demo.")


def technical_skill():
    yield Event(message="Technical skill selected. No external side effect is executed in this demo.")


def sales_skill():
    yield Event(message="Sales skill selected. No external side effect is executed in this demo.")


def other_skill():
    yield Event(message="General skill selected. No external side effect is executed in this demo.")


def human_fallback():
    yield Event(message="Human fallback selected because Laya confidence was below the threshold.")


root_agent = Workflow(
    name="laya_adk_router",
    edges=[
        ("START", laya_route),
        (
            laya_route,
            {
                "billing": billing_skill,
                "technical": technical_skill,
                "sales": sales_skill,
                "other": other_skill,
                "human": human_fallback,
            },
        ),
    ],
)
