from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


MAX_STATE_CHARS = 50_000
MAX_QUESTIONS = 64
MAX_QUESTIONS_CHARS = 100_000
MAX_CRITERIA_PER_QUESTION = 100
MAX_TOTAL_CRITERIA = 512


def _validate_state_size(value: Any) -> Any:
    size = len(value) if isinstance(value, str) else len(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    )
    if size > MAX_STATE_CHARS:
        raise ValueError(f"state must be at most {MAX_STATE_CHARS} characters")
    return value


def _validate_questions(value: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    if not value:
        raise ValueError("at least one question is required")
    if len(value) > MAX_QUESTIONS:
        raise ValueError(f"at most {MAX_QUESTIONS} questions are allowed")
    serialized_size = len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    if serialized_size > MAX_QUESTIONS_CHARS:
        raise ValueError(f"questions must be at most {MAX_QUESTIONS_CHARS} characters")

    total_criteria = 0
    for name, question in value.items():
        kind = question.get("type")
        if kind not in {"choice", "score", "noul"}:
            raise ValueError(f"question {name!r} has unsupported type {kind!r}")
        if not str(question.get("instructions", "")).strip():
            raise ValueError(f"question {name!r} requires instructions")
        criteria = question.get("criteria")
        if kind in {"choice", "score"} and not criteria:
            raise ValueError(f"question {name!r} requires criteria")
        if criteria is not None:
            if kind == "choice" and not isinstance(criteria, dict):
                raise ValueError(f"choice question {name!r} criteria must be an object")
            if kind == "score" and not isinstance(criteria, (dict, list)):
                raise ValueError(f"score question {name!r} criteria must be an object or array")
            criteria_count = len(criteria) if isinstance(criteria, (dict, list)) else 0
            if criteria_count > MAX_CRITERIA_PER_QUESTION:
                raise ValueError(
                    f"question {name!r} allows at most {MAX_CRITERIA_PER_QUESTION} criteria"
                )
            total_criteria += criteria_count
    if total_criteria > MAX_TOTAL_CRITERIA:
        raise ValueError(f"at most {MAX_TOTAL_CRITERIA} total criteria are allowed")
    return value


class PredictRequest(BaseModel):
    state: str | dict[str, Any] | list[Any]
    questions: dict[str, dict[str, Any]]

    @field_validator("state")
    @classmethod
    def state_must_not_be_empty(cls, value: Any) -> Any:
        if value is None or value == "" or value == {} or value == []:
            raise ValueError("state must not be empty")
        return _validate_state_size(value)

    @field_validator("questions")
    @classmethod
    def questions_must_be_valid(cls, value: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        return _validate_questions(value)


class BenchmarkRequest(BaseModel):
    iterations: int = Field(default=100, ge=1, le=1000)
    state: str = Field(default="二重請求されています。返金してください。", max_length=MAX_STATE_CHARS)
    questions: dict[str, dict[str, Any]] | None = None

    @field_validator("questions")
    @classmethod
    def questions_must_be_valid(
        cls, value: dict[str, dict[str, Any]] | None
    ) -> dict[str, dict[str, Any]] | None:
        return _validate_questions(value) if value is not None else None


class AdkRunRequest(BaseModel):
    state: str = Field(min_length=1, max_length=MAX_STATE_CHARS)
    questions: dict[str, dict[str, Any]] | None = None
    route_question: str = Field(default="department", min_length=1, max_length=128)

    @field_validator("questions")
    @classmethod
    def questions_must_be_valid(
        cls, value: dict[str, dict[str, Any]] | None
    ) -> dict[str, dict[str, Any]] | None:
        return _validate_questions(value) if value is not None else None

    @model_validator(mode="after")
    def route_question_must_be_a_choice(self) -> "AdkRunRequest":
        questions = self.questions or {"department": {"type": "choice"}}
        question = questions.get(self.route_question)
        if question is None:
            raise ValueError("route_question must reference an enabled question")
        if question.get("type") != "choice":
            raise ValueError("route_question must reference a choice question")
        return self


class RobotCommandRequest(BaseModel):
    command_id: str = Field(min_length=8, max_length=128)
    utterance: str = Field(min_length=1, max_length=2_000)


class RobotManualRequest(BaseModel):
    command_id: str = Field(min_length=8, max_length=128)
    intent: Literal["forward", "backward", "turn_left", "turn_right"]
    steps: int = Field(default=1, ge=1, le=5)


class RobotBenchmarkRequest(BaseModel):
    iterations: int = Field(default=50, ge=1, le=500)
    utterance: str = Field(default="前へ進んで", min_length=1, max_length=2_000)


class RobotFeedbackRequest(BaseModel):
    command_id: str = Field(min_length=8, max_length=128)
    verdict: Literal["correct", "incorrect"]
    expected_intent: Literal[
        "forward", "backward", "turn_left", "turn_right", "stop", "reset", "unknown"
    ] | None = None

    @model_validator(mode="after")
    def incorrect_feedback_requires_expected_intent(self) -> "RobotFeedbackRequest":
        if self.verdict == "incorrect" and self.expected_intent is None:
            raise ValueError("incorrect feedback requires expected_intent")
        return self


RouteName = Literal["billing", "technical", "sales", "other", "human"]
