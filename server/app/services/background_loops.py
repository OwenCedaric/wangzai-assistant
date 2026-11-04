"""In-process background loops: recovery/order maintenance and the smart-reply worker.

Only the role with ``BACKGROUND_LOOPS_ENABLED=true`` (the dedicated worker service in
production) starts them. Durable task state lives in the database, so a failed cycle
is simply retried by the next one.
"""

from __future__ import annotations

import asyncio
import logging

from redis import Redis
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.services.order_service import close_expired_orders
from app.services.recovery_service import purge_expired_staged_objects
from app.services.smart_reply_cycle import run_smart_reply_cycle
from app.services.worker_liveness import mark_smart_reply_worker_alive

logger = logging.getLogger(__name__)

MAINTENANCE_INTERVAL_SECONDS = 60


class BackgroundLoops:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        settings: Settings,
        redis_client: Redis | None,
    ) -> None:
        self._session_factory = session_factory
        self._settings = settings
        self._redis = redis_client
        self._maintenance_stop = asyncio.Event()
        self._smart_reply_stop = asyncio.Event()
        self._maintenance_task: asyncio.Task[None] | None = None
        self.smart_reply_task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._maintenance_task = asyncio.create_task(self._maintenance_reaper())
        self.smart_reply_task = asyncio.create_task(self._smart_reply_worker())

    async def stop(self) -> None:
        self._smart_reply_stop.set()
        if self.smart_reply_task is not None:
            await self.smart_reply_task
        self.smart_reply_task = None
        self._maintenance_stop.set()
        if self._maintenance_task is not None:
            await self._maintenance_task
        self._maintenance_task = None

    def _purge_recovery_staging_once(self) -> None:
        with self._session_factory() as db:
            try:
                purge_expired_staged_objects(db)
                db.commit()
            except Exception:
                db.rollback()
                raise

    def _close_expired_orders_once(self) -> None:
        with self._session_factory() as db:
            close_expired_orders(db, self._settings)

    async def _maintenance_reaper(self) -> None:
        while not self._maintenance_stop.is_set():
            try:
                await asyncio.gather(
                    asyncio.to_thread(self._purge_recovery_staging_once),
                    asyncio.to_thread(self._close_expired_orders_once),
                )
            except Exception:
                # Request paths still enforce expiry and staging limits. A
                # transient maintenance failure must not block startup.
                logger.warning("maintenance reaper cycle failed", exc_info=True)
            try:
                await asyncio.wait_for(
                    self._maintenance_stop.wait(), timeout=MAINTENANCE_INTERVAL_SECONDS
                )
            except TimeoutError:
                continue

    async def _smart_reply_worker(self) -> None:
        interval = self._settings.smart_reply_worker_interval_seconds
        while not self._smart_reply_stop.is_set():
            try:
                await asyncio.to_thread(
                    run_smart_reply_cycle, self._session_factory, self._settings
                )
            except Exception:
                # Durable event/task states are retried by the next cycle.
                # A transient Ozon or database failure must not stop the API.
                logger.warning("smart reply worker cycle failed", exc_info=True)
            else:
                mark_smart_reply_worker_alive(self._redis, interval)
            try:
                await asyncio.wait_for(self._smart_reply_stop.wait(), timeout=interval)
            except TimeoutError:
                continue
