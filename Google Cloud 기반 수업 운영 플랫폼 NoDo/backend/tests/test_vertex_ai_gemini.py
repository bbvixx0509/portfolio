from __future__ import annotations

import pytest

from app.adapters.vertex_ai_gemini import (
    VertexAIGeminiCourseDraftAdapter,
    _response_text,
)
from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    EXPECTED_CLOUD_STORAGE_BUCKET,
    Settings,
)


def vertex_settings() -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        google_cloud_project=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        storage_mode="cloud",
        storage_bucket=EXPECTED_CLOUD_STORAGE_BUCKET,
        vertex_ai_mode="vertex",
        vertex_ai_location="global",
        vertex_ai_model="gemini-2.5-flash",
    )


def test_vertex_adapter_uses_fixed_global_gemini_endpoint_and_json_schema() -> None:
    adapter = VertexAIGeminiCourseDraftAdapter(vertex_settings())

    endpoint = adapter._endpoint()
    payload = adapter._payload("normalised private text")

    assert endpoint.endswith(
        "/locations/global/publishers/google/models/gemini-2.5-flash:generateContent"
    )
    assert payload["generationConfig"]["responseMimeType"] == "application/json"
    assert "apiKey" not in str(payload)


def test_vertex_response_text_accepts_only_candidate_text() -> None:
    assert (
        _response_text({"candidates": [{"content": {"parts": [{"text": "{}"}]}}]})
        == "{}"
    )
    with pytest.raises(RuntimeError):
        _response_text({"candidates": []})
