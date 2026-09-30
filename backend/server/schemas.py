from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class PredictRequest(BaseModel):
    state: str | dict[str, Any] | list[Any]
    questions: dict[str, dict[str, Any]]

    @field_validator("state")
    @classmethod
    def state_must_not_be_empty(cls, value: Any) -> Any:
        if value is None or value == "" or value == {} or value == []:
            raise ValueError("state must not be empty")
        return value

    @field_validator("questions")
    @classmethod
    def questions_must_be_valid(cls, value: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        if not value:
            raise ValueError("at least one question is required")
        for name, question in value.items():
            kind = question.get("type")
            if kind not in {"choice", "score", "noul"}:
                raise ValueError(f"question {name!r} has unsupported type {kind!r}")
            if not str(question.get("instructions", "")).strip():
                raise ValueError(f"question {name!r} requires instructions")
            if kind in {"choice", "score"} and not question.get("criteria"):
                raise ValueError(f"question {name!r} requires criteria")
        return value


class BenchmarkRequest(BaseModel):
    iterations: int = Field(default=100, ge=1, le=1000)
    state: str = "二重請求されています。返金してください。"
    questions: dict[str, dict[str, Any]] | None = None


class AdkRunRequest(BaseModel):
    state: str = Field(min_length=1)
    questions: dict[str, dict[str, Any]] | None = None


RouteName = Literal["billing", "technical", "sales", "other", "human"]
