from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import google.auth
from google.auth.transport.requests import Request as GoogleAuthRequest

from app.core.config import Settings
from app.services.cloud_material_course_draft_service import GeminiCourseDraftAdapter

VERTEX_AI_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


class VertexAIGeminiCourseDraftAdapter(GeminiCourseDraftAdapter):
    """ADC-only Vertex AI adapter; no browser credentials or API key are used."""

    def __init__(self, runtime_settings: Settings) -> None:
        runtime_settings.ensure_vertex_ai_drafts_enabled()
        self.settings = runtime_settings
        self.model_id = runtime_settings.vertex_ai_model

    def generate_course_draft(self, *, prompt: str) -> str:
        credentials, project_id = google.auth.default(scopes=[VERTEX_AI_SCOPE])
        if project_id != self.settings.google_cloud_project:
            raise RuntimeError("The ADC project is not allowed for NoDo Vertex AI")
        credentials.refresh(GoogleAuthRequest())
        token = credentials.token
        if not isinstance(token, str) or not token:
            raise RuntimeError("NoDo Vertex AI ADC token is unavailable")
        request = Request(
            self._endpoint(),
            data=json.dumps(self._payload(prompt)).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=45) as response:  # nosec B310 - fixed HTTPS endpoint
                payload = json.loads(response.read().decode("utf-8"))
        except (
            HTTPError,
            URLError,
            OSError,
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as error:
            raise RuntimeError("NoDo Vertex AI request failed") from error
        return _response_text(payload)

    def _endpoint(self) -> str:
        return (
            "https://aiplatform.googleapis.com/v1/projects/"
            f"{self.settings.google_cloud_project}/locations/"
            f"{self.settings.vertex_ai_location}/publishers/google/models/"
            f"{self.model_id}:generateContent"
        )

    @staticmethod
    def _payload(prompt: str) -> dict[str, Any]:
        return {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "candidateCount": 1,
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "OBJECT",
                    "required": [
                        "suggestedTitle",
                        "summary",
                        "chapters",
                    ],
                    "properties": {
                        "suggestedTitle": {"type": "STRING"},
                        "summary": {"type": "STRING"},
                        "chapters": {
                            "type": "ARRAY",
                            "items": {
                                "type": "OBJECT",
                                "required": ["title", "items"],
                                "properties": {
                                    "title": {"type": "STRING"},
                                    "items": {
                                        "type": "ARRAY",
                                        "items": {
                                            "type": "OBJECT",
                                            "required": [
                                                "title",
                                                "description",
                                                "sourcePageOrSlideNumbers",
                                            ],
                                            "properties": {
                                                "title": {"type": "STRING"},
                                                "description": {"type": "STRING"},
                                                "sourcePageOrSlideNumbers": {
                                                    "type": "ARRAY",
                                                    "items": {"type": "INTEGER"},
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        }


class VertexAIGeminiStudentAssistantAdapter:
    """Server-only Gemini adapter for short learner-assistant replies."""

    def __init__(self, runtime_settings: Settings) -> None:
        runtime_settings.ensure_vertex_ai_student_assistant_enabled()
        self.settings = runtime_settings
        self.model_id = runtime_settings.vertex_ai_model

    def generate_student_assistant_reply(self, *, prompt: str) -> str:
        if len(prompt) > self.settings.vertex_ai_max_input_characters:
            raise RuntimeError(
                "NoDo Vertex AI learner prompt exceeds the configured limit"
            )
        credentials, project_id = google.auth.default(scopes=[VERTEX_AI_SCOPE])
        if project_id != self.settings.google_cloud_project:
            raise RuntimeError("The ADC project is not allowed for NoDo Vertex AI")
        credentials.refresh(GoogleAuthRequest())
        token = credentials.token
        if not isinstance(token, str) or not token:
            raise RuntimeError("NoDo Vertex AI ADC token is unavailable")
        request = Request(
            self._endpoint(),
            data=json.dumps(self._payload(prompt)).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=45) as response:  # nosec B310 - fixed HTTPS endpoint
                payload = json.loads(response.read().decode("utf-8"))
        except (
            HTTPError,
            URLError,
            OSError,
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as error:
            raise RuntimeError("NoDo Vertex AI request failed") from error
        return _response_text(payload)

    def _endpoint(self) -> str:
        return (
            "https://aiplatform.googleapis.com/v1/projects/"
            f"{self.settings.google_cloud_project}/locations/"
            f"{self.settings.vertex_ai_location}/publishers/google/models/"
            f"{self.model_id}:generateContent"
        )

    @staticmethod
    def _payload(prompt: str) -> dict[str, Any]:
        return {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "candidateCount": 1,
                "maxOutputTokens": 700,
            },
        }


def _response_text(payload: object) -> str:
    if not isinstance(payload, dict):
        raise RuntimeError("NoDo Vertex AI response is invalid")
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise RuntimeError("NoDo Vertex AI response has no candidate")
    candidate = candidates[0]
    if not isinstance(candidate, dict):
        raise RuntimeError("NoDo Vertex AI response is invalid")
    content = candidate.get("content")
    if not isinstance(content, dict):
        raise RuntimeError("NoDo Vertex AI response is invalid")
    parts = content.get("parts")
    if not isinstance(parts, list):
        raise RuntimeError("NoDo Vertex AI response is invalid")
    text = "".join(
        part.get("text", "")
        for part in parts
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    )
    if not text.strip():
        raise RuntimeError("NoDo Vertex AI response has no JSON")
    return text
