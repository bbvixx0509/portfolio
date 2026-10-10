import json
from collections.abc import Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.domain.errors import InvitationEmailUnavailable

RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails"
INVITATION_SUBJECT = "NoDo 조직 초대가 도착했습니다"
INVITATION_TEXT = (
    "NoDo에서 함께 수업을 운영할 구성원으로 초대했습니다.\n"
    "아래 버튼에서 초대를 수락하거나 거절할 수 있습니다.\n"
    "초대는 7일 후 만료됩니다.\n\n"
    "초대 수락: {accept_url}\n"
    "초대 거절: {decline_url}"
)
INVITATION_HTML = """\
<p>NoDo에서 함께 수업을 운영할 구성원으로 초대했습니다.</p>
<p>아래 버튼에서 초대를 수락하거나 거절할 수 있습니다.<br>
초대는 7일 후 만료됩니다.</p>
<p>
  <a href="{accept_url}">초대 수락</a>
  &nbsp;
  <a href="{decline_url}">초대 거절</a>
</p>
"""
EMAIL_UNAVAILABLE_MESSAGE = (
    "초대 이메일 발송 설정이 준비되지 않았습니다. 관리자에게 문의해 주세요."
)


class DisabledInvitationEmailSender:
    def ensure_configured(self) -> None:
        raise InvitationEmailUnavailable(EMAIL_UNAVAILABLE_MESSAGE)

    def send_invitation(
        self,
        *,
        recipient: str,
        accept_url: str,
        decline_url: str,
        idempotency_key: str,
    ) -> None:
        del recipient, accept_url, decline_url, idempotency_key
        self.ensure_configured()


class ResendInvitationEmailSender:
    """Small server-only Resend adapter.

    Raw invitation tokens only occur inside the two message links.  Neither the
    response body nor raised errors include the provider response.
    """

    def __init__(
        self, *, api_key: str, sender: str, timeout_seconds: float = 10
    ) -> None:
        self.api_key = api_key.strip()
        self.sender = sender.strip()
        self.timeout_seconds = timeout_seconds

    def ensure_configured(self) -> None:
        if not self.api_key or not self.sender:
            raise InvitationEmailUnavailable(EMAIL_UNAVAILABLE_MESSAGE)

    def send_invitation(
        self,
        *,
        recipient: str,
        accept_url: str,
        decline_url: str,
        idempotency_key: str,
    ) -> None:
        self.ensure_configured()
        payload: Mapping[str, object] = {
            "from": self.sender,
            "to": [recipient],
            "subject": INVITATION_SUBJECT,
            "text": INVITATION_TEXT.format(
                accept_url=accept_url,
                decline_url=decline_url,
            ),
            "html": INVITATION_HTML.format(
                accept_url=accept_url,
                decline_url=decline_url,
            ),
        }
        request = Request(
            RESEND_EMAIL_ENDPOINT,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "User-Agent": "NoDo/02 invitation-email",
                "Idempotency-Key": idempotency_key,
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                if response.status < 200 or response.status >= 300:
                    raise InvitationEmailUnavailable(EMAIL_UNAVAILABLE_MESSAGE)
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            raise InvitationEmailUnavailable(EMAIL_UNAVAILABLE_MESSAGE) from error
