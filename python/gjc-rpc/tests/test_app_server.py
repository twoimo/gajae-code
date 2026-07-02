from __future__ import annotations

import json
import queue
import threading
import unittest
from typing import Any

from gjc_rpc.app_server import (
    AgentMessageDeltaNotification,
    AppServerClient,
    GjcEventNotification,
    TurnCompletedNotification,
    TurnStartedNotification,
)
from gjc_rpc.protocol import UnknownNotification


class _QueueStdout:
    def __init__(self) -> None:
        self._lines: queue.Queue[str | None] = queue.Queue()

    def push(self, payload: dict[str, Any]) -> None:
        self._lines.put(json.dumps(payload) + "\n")

    def close(self) -> None:
        self._lines.put(None)

    def __iter__(self) -> "_QueueStdout":
        return self

    def __next__(self) -> str:
        line = self._lines.get()
        if line is None:
            raise StopIteration
        return line


class _EmptyStderr:
    def __iter__(self) -> "_EmptyStderr":
        return self

    def __next__(self) -> str:
        raise StopIteration


class _FakeStdin:
    def __init__(self, transport: "FakeAppServerTransport") -> None:
        self._transport = transport
        self._buffer = ""

    def write(self, value: str) -> int:
        self._buffer += value
        return len(value)

    def flush(self) -> None:
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            if line.strip():
                self._transport.receive(json.loads(line))


class FakeAppServerTransport:
    def __init__(self) -> None:
        self.stdin = _FakeStdin(self)
        self.stdout = _QueueStdout()
        self.stderr = _EmptyStderr()
        self.frames: list[dict[str, Any]] = []
        self._returncode: int | None = None
        self._held: dict[str, dict[str, Any]] = {}

    def receive(self, frame: dict[str, Any]) -> None:
        self.frames.append(frame)
        method = frame.get("method")
        request_id = frame.get("id")
        if request_id is None:
            return
        if method == "initialize":
            self.stdout.push({"id": request_id, "result": {"capabilities": {}}})
        elif method == "thread/start":
            self.stdout.push({"id": request_id, "result": {"thread": {"id": "thread-1"}}})
        elif method == "turn/start":
            self.stdout.push({"method": "turn/started", "params": {"threadId": "thread-1", "turnId": "turn-1"}})
            self.stdout.push({"method": "item/agentMessage/delta", "params": {"itemId": "item-1", "delta": "hello"}})
            self.stdout.push({"method": "turn/completed", "params": {"threadId": "thread-1", "turnId": "turn-1"}})
            self.stdout.push({"id": request_id, "result": {"turn": {"id": "turn-1", "status": "completed"}}})
        elif method == "gjc/state/read":
            self.stdout.push({"id": request_id, "result": {"state": {"cwd": "/tmp/project"}}})
        elif method == "slow":
            self._held["slow"] = {"id": request_id, "result": {"name": "slow"}}
        elif method == "fast":
            self.stdout.push({"id": request_id, "result": {"name": "fast"}})
            held = self._held.pop("slow", None)
            if held is not None:
                self.stdout.push(held)
        else:
            self.stdout.push({"id": request_id, "result": {"method": method}})

    def push_notification(self, payload: dict[str, Any]) -> None:
        self.stdout.push(payload)

    def poll(self) -> int | None:
        return self._returncode

    def terminate(self) -> None:
        self._returncode = 0
        self.stdout.close()

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def kill(self) -> None:
        self._returncode = -9
        self.stdout.close()


class AppServerClientTests(unittest.TestCase):
    def make_client(self) -> tuple[AppServerClient, FakeAppServerTransport]:
        transport = FakeAppServerTransport()
        client = AppServerClient(transport=transport, request_timeout=1.0, startup_timeout=1.0)
        return client, transport

    def test_start_performs_initialize_initialized_handshake(self) -> None:
        client, transport = self.make_client()
        client.start()
        try:
            self.assertEqual(
                [{"id": "req_1", "method": "initialize", "params": {}}, {"method": "initialized", "params": {}}],
                transport.frames[:2],
            )
        finally:
            client.stop()

    def test_correlates_responses_by_json_rpc_id(self) -> None:
        client, _transport = self.make_client()
        client.start()
        results: dict[str, dict[str, Any]] = {}
        try:
            slow_thread = threading.Thread(target=lambda: results.update(slow=client.request("slow")))
            fast_thread = threading.Thread(target=lambda: results.update(fast=client.request("fast")))
            slow_thread.start()
            fast_thread.start()
            slow_thread.join(timeout=2.0)
            fast_thread.join(timeout=2.0)
            self.assertEqual({"name": "slow"}, results["slow"])
            self.assertEqual({"name": "fast"}, results["fast"])
        finally:
            client.stop()

    def test_parses_turn_notifications_and_delta(self) -> None:
        client, _transport = self.make_client()
        notifications: list[object] = []
        client.on_notification(notifications.append)
        client.start()
        try:
            turn = client.start_turn("thread-1", "hello")
            self.assertEqual("turn-1", turn.id)
            self.assertTrue(any(isinstance(item, TurnStartedNotification) for item in notifications))
            delta = next(item for item in notifications if isinstance(item, AgentMessageDeltaNotification))
            self.assertEqual("hello", delta.params["delta"])
            self.assertTrue(any(isinstance(item, TurnCompletedNotification) for item in notifications))
        finally:
            client.stop()

    def test_parses_gjc_event_passthrough(self) -> None:
        client, transport = self.make_client()
        notifications: list[object] = []
        client.on_notification(notifications.append)
        client.start()
        try:
            transport.push_notification({"method": "gjc/event", "params": {"type": "agent_start", "seq": 1}})
            event = self._wait_for(notifications, GjcEventNotification)
            self.assertEqual({"type": "agent_start", "seq": 1}, event.params)
        finally:
            client.stop()

    def test_unknown_notification_fallback_preserves_payload(self) -> None:
        client, transport = self.make_client()
        notifications: list[object] = []
        client.on_notification(notifications.append)
        client.start()
        try:
            payload = {"method": "new/serverNotification", "params": {"value": 42}}
            transport.push_notification(payload)
            unknown = self._wait_for(notifications, UnknownNotification)
            self.assertEqual(payload, unknown.payload)
        finally:
            client.stop()

    def _wait_for(self, notifications: list[object], cls: type[Any]) -> Any:
        for _ in range(100):
            for item in notifications:
                if isinstance(item, cls):
                    return item
            threading.Event().wait(0.01)
        self.fail(f"did not receive {cls.__name__}")


if __name__ == "__main__":
    unittest.main()
