"""Concurrent-client load check for the light API path (no paid or model calls).

Simulates many desktop clients that are logged in at the same time and keep calling a
cheap authenticated endpoint, then prints latency percentiles and the error rate.
Run it against staging/production after a deploy, e.g.:

    python scripts/load_check.py --base-url https://license.example.com \
        --username load-test-user --password '...' --clients 300 --duration 60

It only ever calls POST /api/auth/login once and GET <--path> (default /api/auth/me),
so it never spends points, calls AI providers or touches customer shops.
"""

from __future__ import annotations

import argparse
import asyncio
import random
import statistics
import time

import httpx


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
    return ordered[index]


async def login(client: httpx.AsyncClient, username: str, password: str) -> str:
    response = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    response.raise_for_status()
    return response.json()["access_token"]


async def simulated_client(
    client: httpx.AsyncClient,
    path: str,
    headers: dict[str, str],
    deadline: float,
    interval: float,
    latencies: list[float],
    failures: dict[str, int],
    first_delay: float,
) -> None:
    # Real clients start at different moments; --burst makes them all fire together
    # (the worst case, e.g. everyone reconnecting right after a server restart).
    await asyncio.sleep(first_delay)
    while time.monotonic() < deadline:
        started = time.monotonic()
        try:
            response = await client.get(path, headers=headers)
            if response.status_code >= 400:
                key = f"HTTP {response.status_code}"
                failures[key] = failures.get(key, 0) + 1
            else:
                latencies.append(time.monotonic() - started)
        except httpx.HTTPError as exc:
            key = type(exc).__name__
            failures[key] = failures.get(key, 0) + 1
        await asyncio.sleep(max(0.0, interval - (time.monotonic() - started)))


async def run(args: argparse.Namespace) -> int:
    limits = httpx.Limits(max_connections=args.clients, max_keepalive_connections=args.clients)
    timeout = httpx.Timeout(args.timeout)
    async with httpx.AsyncClient(base_url=args.base_url, limits=limits, timeout=timeout) as client:
        token = await login(client, args.username, args.password)
        headers = {"Authorization": f"Bearer {token}"}
        latencies: list[float] = []
        failures: dict[str, int] = {}
        deadline = time.monotonic() + args.duration
        await asyncio.gather(
            *(
                simulated_client(
                    client,
                    args.path,
                    headers,
                    deadline,
                    args.interval,
                    latencies,
                    failures,
                    0.0 if args.burst else random.uniform(0, args.interval),
                )
                for _ in range(args.clients)
            )
        )
    total = len(latencies) + sum(failures.values())
    failure_rate = sum(failures.values()) / total if total else 1.0
    mode = "burst" if args.burst else "spread"
    print(f"clients={args.clients} duration={args.duration}s path={args.path} mode={mode}")
    print(f"requests={total} ok={len(latencies)} failures={failures or 0}")
    print(f"throughput={total / args.duration:.1f} req/s failure_rate={failure_rate:.2%}")
    if latencies:
        print(
            "latency_ms "
            f"p50={percentile(latencies, 0.5) * 1000:.0f} "
            f"p95={percentile(latencies, 0.95) * 1000:.0f} "
            f"p99={percentile(latencies, 0.99) * 1000:.0f} "
            f"max={max(latencies) * 1000:.0f} "
            f"mean={statistics.mean(latencies) * 1000:.0f}"
        )
    return 0 if failure_rate <= args.max_failure_rate else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--path", default="/api/auth/me")
    parser.add_argument("--clients", type=int, default=100)
    parser.add_argument("--duration", type=float, default=30.0)
    parser.add_argument("--interval", type=float, default=1.0, help="seconds between calls")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--max-failure-rate", type=float, default=0.01)
    parser.add_argument(
        "--burst", action="store_true", help="start every client at the same instant"
    )
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
