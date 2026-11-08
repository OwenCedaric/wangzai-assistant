"""Authentication API for License Center."""

from __future__ import annotations

from .errors import ConfigurationError
from .models import AuthSession
from .transport import Transport


class AuthClient:
    """Perform login without retaining the submitted password."""

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    def login(self, username: str, password: str) -> AuthSession:
        clean_username = username.strip()
        if not clean_username:
            raise ConfigurationError("username must not be empty")
        if not password:
            raise ConfigurationError("password must not be empty")
        response = self._transport.request(
            "POST",
            "/api/auth/login",
            json_body={"username": clean_username, "password": password},
        )
        # The password exists only in the request object above and is never assigned to the client.
        return AuthSession.from_response(response)
