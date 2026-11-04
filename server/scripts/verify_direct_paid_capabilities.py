from __future__ import annotations

import argparse
import hashlib
import json
import select
import socket
import socketserver
import ssl
import sys
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from urllib.parse import quote, urlsplit

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from sqlalchemy import func
from sqlalchemy import select as sql_select

from app.config import Settings  # noqa: E402
from app.database.session import build_engine, build_session_factory  # noqa: E402
from app.models.api_pool import ApiPoolKey, ApiPoolProvider  # noqa: E402
from app.paid_capabilities.api_pool_provider import (  # noqa: E402
    PooledPaidCapabilityProvider,
)
from app.paid_capabilities.providers import (  # noqa: E402
    HttpPaidCapabilityProvider,
    PaidProviderFailure,
)
from app.paid_capabilities.registry import get_paid_capability  # noqa: E402

DNS_HOST = "dns.alidns.com"
DNS_IPS = ("223.5.5.5", "223.6.6.6")
IP_UNICAST_IF = 31


def _interface_socket(interface_index: int, timeout: float) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.IPPROTO_IP, IP_UNICAST_IF, socket.htonl(interface_index))
    sock.settimeout(timeout)
    return sock


def _decode_http_body(headers: bytes, body: bytes) -> bytes:
    if b"transfer-encoding: chunked" not in headers.lower():
        return body
    decoded = bytearray()
    remaining = body
    while remaining:
        line, remaining = remaining.split(b"\r\n", 1)
        size = int(line.split(b";", 1)[0], 16)
        if size == 0:
            break
        decoded.extend(remaining[:size])
        remaining = remaining[size + 2 :]
    return bytes(decoded)


def resolve_a_direct(host: str, interface_index: int) -> list[str]:
    last_error: Exception | None = None
    for dns_ip in DNS_IPS:
        raw: socket.socket | None = None
        try:
            raw = _interface_socket(interface_index, 15)
            raw.connect((dns_ip, 443))
            tls = ssl.create_default_context().wrap_socket(raw, server_hostname=DNS_HOST)
            path = f"/resolve?name={quote(host)}&type=A"
            tls.sendall(
                (
                    f"GET {path} HTTP/1.1\r\n"
                    f"Host: {DNS_HOST}\r\n"
                    "Accept: application/dns-json\r\n"
                    "Connection: close\r\n\r\n"
                ).encode("ascii")
            )
            response = bytearray()
            while True:
                block = tls.recv(65_536)
                if not block:
                    break
                response.extend(block)
            headers, body = bytes(response).split(b"\r\n\r\n", 1)
            payload = json.loads(_decode_http_body(headers, body))
            addresses = [
                item["data"]
                for item in payload.get("Answer", [])
                if item.get("type") == 1 and isinstance(item.get("data"), str)
            ]
            if payload.get("Status") == 0 and addresses:
                return addresses
            raise RuntimeError(f"direct DNS returned status {payload.get('Status')}")
        except Exception as exc:  # noqa: BLE001 - try the secondary resolver
            last_error = exc
        finally:
            if raw is not None:
                raw.close()
    raise RuntimeError(f"direct DNS failed for {host}") from last_error


@dataclass
class ProxyState:
    interface_index: int
    allowed_hosts: set[str]
    addresses: dict[str, list[str]]
    lock: threading.Lock

    def resolve(self, host: str) -> list[str]:
        normalized = host.lower().rstrip(".")
        if normalized not in self.allowed_hosts:
            raise ValueError("proxy target is not allowlisted")
        with self.lock:
            cached = self.addresses.get(normalized)
        if cached:
            return cached
        resolved = resolve_a_direct(normalized, self.interface_index)
        with self.lock:
            self.addresses[normalized] = resolved
        return resolved


class DirectConnectProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, state: ProxyState) -> None:
        self.state = state
        super().__init__(("127.0.0.1", 0), DirectConnectHandler)


class DirectConnectHandler(socketserver.BaseRequestHandler):
    server: DirectConnectProxy

    def _reply(self, status: HTTPStatus) -> None:
        self.request.sendall(
            f"HTTP/1.1 {status.value} {status.phrase}\r\nConnection: close\r\n\r\n".encode(
                "ascii"
            )
        )

    def handle(self) -> None:
        request = bytearray()
        self.request.settimeout(10)
        while b"\r\n\r\n" not in request and len(request) < 16_384:
            block = self.request.recv(4096)
            if not block:
                return
            request.extend(block)
        try:
            method, authority, _version = request.split(b"\r\n", 1)[0].decode("ascii").split()
            host, port_text = authority.rsplit(":", 1)
            port = int(port_text)
            if method != "CONNECT" or port != 443:
                raise ValueError("only HTTPS CONNECT is supported")
            addresses = self.server.state.resolve(host)
        except (UnicodeError, ValueError, RuntimeError):
            self._reply(HTTPStatus.FORBIDDEN)
            return

        upstream: socket.socket | None = None
        for address in addresses:
            candidate = _interface_socket(self.server.state.interface_index, 20)
            try:
                candidate.connect((address, port))
                upstream = candidate
                break
            except OSError:
                candidate.close()
        if upstream is None:
            self._reply(HTTPStatus.BAD_GATEWAY)
            return

        try:
            self._reply(HTTPStatus.OK)
            self.request.setblocking(False)
            upstream.setblocking(False)
            sockets = [self.request, upstream]
            last_activity = time.monotonic()
            while time.monotonic() - last_activity < 240:
                readable, _, exceptional = select.select(sockets, [], sockets, 0.5)
                if exceptional:
                    return
                for source in readable:
                    try:
                        data = source.recv(65_536)
                    except BlockingIOError:
                        continue
                    if not data:
                        return
                    target = upstream if source is self.request else self.request
                    target.sendall(data)
                    last_activity = time.monotonic()
        finally:
            upstream.close()


def _provider_key_totals(session_factory, provider_code: str) -> tuple[int, int, int]:
    with session_factory() as db:
        provider_id = db.scalar(
            sql_select(ApiPoolProvider.id).where(ApiPoolProvider.code == provider_code)
        )
        if provider_id is None:
            raise RuntimeError(f"provider {provider_code} is missing")
        values = db.execute(
            sql_select(
                func.sum(ApiPoolKey.request_count),
                func.sum(ApiPoolKey.success_count),
                func.sum(ApiPoolKey.failure_count),
            ).where(ApiPoolKey.provider_id == provider_id)
        ).one()
        return tuple(int(item or 0) for item in values)


def run_image_test(interface_index: int) -> None:
    settings = Settings()
    engine = build_engine(settings.database_url, echo=False)
    session_factory = build_session_factory(engine)
    allowed_hosts = set(settings.paid_provider_allowed_host_set)
    allowed_hosts.update(settings.paid_source_image_allowed_host_set)
    state = ProxyState(interface_index, allowed_hosts, {}, threading.Lock())
    proxy = DirectConnectProxy(state)
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    proxy_url = f"http://127.0.0.1:{proxy.server_address[1]}"
    client = httpx.Client(
        proxy=proxy_url,
        timeout=settings.paid_provider_timeout_seconds,
        follow_redirects=False,
        trust_env=False,
    )
    http_provider = HttpPaidCapabilityProvider(settings, client=client)
    pooled = PooledPaidCapabilityProvider(
        settings,
        session_factory,
        http_provider=http_provider,
    )
    before = _provider_key_totals(session_factory, "codesonline-2")
    try:
        descriptor = get_paid_capability("image.generate", 1)
        payload = descriptor.normalize(
            {
                "prompt": "A small blue circle centered on a plain white background. No text.",
                "size": "1024x1024",
                "quality": "standard",
                "count": 1,
                "shopId": "direct-network-test",
            }
        )
        started = time.perf_counter()
        result = pooled.execute(
            descriptor,
            payload,
            provider_code="codesonline-2",
            provider_model="gpt-image-2",
        )
        generation_ms = round((time.perf_counter() - started) * 1000)
        image = result.result.get("images", [{}])[0]
        image_url = image.get("url") if isinstance(image, dict) else None
        if not isinstance(image_url, str):
            raise RuntimeError("image provider did not return a URL")
        image_host = (urlsplit(image_url).hostname or "").lower()
        if image_host not in allowed_hosts:
            raise RuntimeError("image relay host is outside the configured allowlist")
        started = time.perf_counter()
        response = client.get(image_url, timeout=120)
        download_ms = round((time.perf_counter() - started) * 1000)
        content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
        if response.status_code != 200:
            raise RuntimeError(f"image relay returned HTTP {response.status_code}")
        if content_type not in {"image/jpeg", "image/png", "image/webp"}:
            raise RuntimeError(f"image relay returned {content_type or 'unknown MIME'}")
        if not 1 <= len(response.content) <= 20_000_000:
            raise RuntimeError("image relay returned an invalid byte count")
        after = _provider_key_totals(session_factory, "codesonline-2")
        print(
            json.dumps(
                {
                    "route": "WLAN interface-bound socket",
                    "generation": {
                        "ok": True,
                        "httpStatus": 200,
                        "elapsedMs": generation_ms,
                        "model": "gpt-image-2",
                        "providerCostMicros": result.actual_provider_cost_micros,
                        "costSource": result.provider_cost_source,
                        "usageUnits": result.usage.units,
                    },
                    "relayDownload": {
                        "ok": True,
                        "httpStatus": response.status_code,
                        "elapsedMs": download_ms,
                        "host": image_host,
                        "contentType": content_type,
                        "bytes": len(response.content),
                        "sha256Prefix": hashlib.sha256(response.content).hexdigest()[:16],
                    },
                    "apiPoolDelta": {
                        "requests": after[0] - before[0],
                        "successes": after[1] - before[1],
                        "failures": after[2] - before[2],
                    },
                },
                ensure_ascii=False,
            )
        )
    except PaidProviderFailure as exc:
        print(
            json.dumps(
                {
                    "generation": {"ok": False, "code": exc.code},
                    "billable": exc.billable,
                    "upstreamStatus": exc.upstream_status,
                },
                ensure_ascii=False,
            )
        )
        raise
    finally:
        client.close()
        proxy.shutdown()
        proxy.server_close()
        thread.join(timeout=2)
        engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify paid image generation over a specific Windows interface."
    )
    parser.add_argument("--interface-index", type=int, required=True)
    args = parser.parse_args()
    run_image_test(args.interface_index)


if __name__ == "__main__":
    main()
