import json
from typing import Any

import pytest

import app.adapters.invitation_email as email_module
from app.adapters.invitation_email import ResendInvitationEmailSender
from app.core.config import Settings
from app.domain.errors import InvitationEmailUnavailable


class FakeResponse:
    status = 200

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


def test_resend_adapter_uses_server_headers_and_idempotency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_urlopen(request: Any, *, timeout: float) -> FakeResponse:
        captured["request"] = request
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(email_module, "urlopen", fake_urlopen)
    sender = ResendInvitationEmailSender(
        api_key="secret-key",
        sender="NoDo <noreply@nodo-company.test>",
    )

    sender.send_invitation(
        recipient="member@nodo-company.test",
        accept_url="https://example.test/accept/token",
        decline_url="https://example.test/decline/token",
        idempotency_key="organization-invitation-email-id-r1",
    )

    request = captured["request"]
    payload = json.loads(request.data)
    assert request.full_url == "https://api.resend.com/emails"
    assert request.get_header("Authorization") == "Bearer secret-key"
    assert request.get_header("User-agent") == "NoDo/02 invitation-email"
    assert request.get_header("Idempotency-key") == (
        "organization-invitation-email-id-r1"
    )
    assert payload["to"] == ["member@nodo-company.test"]
    assert "https://example.test/accept/token" in payload["text"]
    assert "https://example.test/decline/token" in payload["text"]
    assert 'href="https://example.test/accept/token"' in payload["html"]
    assert 'href="https://example.test/decline/token"' in payload["html"]
    assert "초대 수락" in payload["html"]
    assert "초대 거절" in payload["html"]


def test_resend_adapter_missing_secret_fails_before_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        email_module,
        "urlopen",
        lambda *_args, **_kwargs: pytest.fail("network must not be called"),
    )
    sender = ResendInvitationEmailSender(api_key="", sender="noreply@nodo-company.test")

    with pytest.raises(InvitationEmailUnavailable):
        sender.send_invitation(
            recipient="member@nodo-company.test",
            accept_url="https://example.test/accept",
            decline_url="https://example.test/decline",
            idempotency_key="safe",
        )


def test_settings_repr_never_contains_resend_secret() -> None:
    runtime_settings = Settings(resend_api_key="resend-secret-must-stay-private")

    assert "resend-secret-must-stay-private" not in repr(runtime_settings)
