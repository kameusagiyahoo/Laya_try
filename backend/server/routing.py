from __future__ import annotations

from typing import Any

from .inference import _answer_confidence


ROUTES = {"billing", "technical", "sales", "other"}

DEFAULT_ROUTE_QUESTION: dict[str, dict[str, Any]] = {
    "department": {
        "type": "choice",
        "instructions": "どの担当へ送るべきか",
        "criteria": {
            "billing": "請求・支払い・返金・二重請求",
            "technical": "障害・ログイン・API・技術問題",
            "sales": "料金・見積・契約・導入相談",
            "other": "その他",
        },
    }
}


SKILL_RESULTS = {
    "billing": "Billing Skill selected. 請求・返金担当へ引き継ぎます。",
    "technical": "Technical Skill selected. 技術担当へ引き継ぎます。",
    "sales": "Sales Skill selected. 営業担当へ引き継ぎます。",
    "other": "Other Skill selected. 一般窓口へ引き継ぎます。",
    "human": "Human fallback selected. 担当者が内容を確認します。",
}


def select_route(result: dict[str, Any], threshold: float) -> tuple[str, str, float]:
    department = (result.get("answers") or {}).get("department") or {}
    choice = str(department.get("choice", "other"))
    confidence = _answer_confidence(department)
    route = choice if choice in ROUTES and confidence >= threshold else "human"
    return route, choice, confidence


def build_trace(state: str, result: dict[str, Any], threshold: float) -> dict[str, Any]:
    route, choice, confidence = select_route(result, threshold)
    return {
        "route": route,
        "selected_skill": f"{route}_skill" if route != "human" else "human_fallback",
        "result": SKILL_RESULTS[route],
        "trace": [
            {"stage": "Input", "value": state},
            {"stage": "Laya", "value": {"choice": choice, "confidence": confidence}},
            {"stage": "Event(route)", "value": route},
            {"stage": "selected Skill", "value": f"{route}_skill" if route != "human" else "human_fallback"},
            {"stage": "result", "value": SKILL_RESULTS[route]},
        ],
        "laya": result,
    }
