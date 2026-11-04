import httpx

from app.services.smart_reply_ozon import (
    SmartReplyOzonClient,
    SmartReplyOzonFailure,
    history_confirms_message,
)


def test_ozon_client_reads_order_starts_chat_sends_and_reads_back() -> None:
    requests: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = __import__("json").loads(request.content)
        requests.append((request.url.path, body))
        assert request.headers["Client-Id"] == "10001"
        assert request.headers["Api-Key"] == "secret-key"
        responses = {
            "/v3/posting/fbs/get": {"result": {"posting_number": "POST-1", "status": "delivering"}},
            "/v1/returns/list": {"returns": []},
            "/v1/chat/start": {"result": {"chat_id": "chat-1"}},
            "/v1/chat/send/message": {"result": "message-1"},
            "/v3/chat/history": {"messages": [{"message_id": "message-1", "data": "hello"}]},
        }
        return httpx.Response(200, json=responses[request.url.path])

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        with SmartReplyOzonClient(
            client_id="10001",
            api_key="secret-key",
            base_url="https://api-seller.ozon.ru",
            timeout_seconds=15,
            client=http,
        ) as ozon:
            posting, source = ozon.read_posting("POST-1")
            assert ozon.has_return_or_refund("POST-1") is False
            chat_id = ozon.start_chat("POST-1")
            message_id = ozon.send_message(chat_id, "hello")
            messages = ozon.history(chat_id)
    assert posting["status"] == "delivering"
    assert source == "FBS"
    assert history_confirms_message(messages, message_id=message_id, text="hello") == (
        True,
        "message-1",
    )
    assert [path for path, _body in requests] == [
        "/v3/posting/fbs/get",
        "/v1/returns/list",
        "/v1/chat/start",
        "/v1/chat/send/message",
        "/v3/chat/history",
    ]


def test_history_text_fallback_only_accepts_seller_messages() -> None:
    assert history_confirms_message(
        [{"message_id": "buyer-1", "data": ["same text"], "user": {"type": "buyer"}}],
        message_id=None,
        text="same text",
    ) == (False, None)
    assert history_confirms_message(
        [{"message_id": "seller-1", "data": ["same", "text"], "user": {"type": "seller"}}],
        message_id=None,
        text="same\ntext",
    ) == (True, "seller-1")


def test_ambiguous_send_network_failure_is_never_marked_retryable() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timeout")

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        with SmartReplyOzonClient(
            client_id="10001",
            api_key="secret-key",
            base_url="https://api-seller.ozon.ru",
            timeout_seconds=15,
            client=http,
        ) as ozon:
            try:
                ozon.send_message("chat-1", "hello")
            except SmartReplyOzonFailure as exc:
                assert exc.ambiguous_write is True
                assert exc.retryable is False
            else:
                raise AssertionError("failure was not raised")
