from __future__ import annotations

import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Callable
from unittest.mock import patch

from gjc_rpc import GjcFrameDecoder, RpcClient, RpcCommandError, RpcConcurrencyError, RpcError, RpcProcessExitError, read_frame, write_frame


def frame(*, kind: str, frame_type: str, payload: dict[str, Any], correlation_id: str | None = None, direction: str = "server_to_client") -> dict[str, Any]:
    out: dict[str, Any] = {
        "protocolVersion": 1,
        "frameId": f"test-{kind}-{frame_type}-{time.time_ns()}",
        "sessionId": "default",
        "seq": 1,
        "direction": direction,
        "kind": kind,
        "type": frame_type,
        "replay": False,
        "payload": payload,
    }
    if correlation_id is not None:
        out["correlationId"] = correlation_id
    return out


class UdsServer:
    def __init__(self, handler: Callable[[dict[str, Any], socket.socket], None]) -> None:
        self.socket_path = Path(tempfile.mkdtemp(prefix="gjc-rpc-test-", dir="/tmp")) / "daemon.sock"
        self.handler = handler
        self.ready = threading.Event()
        self.seen: list[dict[str, Any]] = []
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        assert self.ready.wait(1.0)

    def _run(self) -> None:
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(self.socket_path))
        listener.listen(1)
        self.ready.set()
        conn, _ = listener.accept()
        decoder = GjcFrameDecoder()
        try:
            hello = read_frame(conn, decoder)
            if hello is None:
                return
            self.seen.append(hello)
            write_frame(conn, frame(kind="ready", frame_type="hello_accepted", payload={"sessions": 1}))
            while True:
                inbound = read_frame(conn, decoder)
                if inbound is None:
                    return
                self.seen.append(inbound)
                self.handler(inbound, conn)
        finally:
            conn.close()
            listener.close()

    def client(self, **kwargs: Any) -> RpcClient:
        return RpcClient(socket_path=self.socket_path, startup_timeout=1.0, request_timeout=1.0, **kwargs)

    def join(self) -> None:
        self.thread.join(timeout=1.0)


def respond(conn: socket.socket, inbound: dict[str, Any], data: dict[str, Any] | None = None, *, success: bool = True, error: str | None = None, command: str | None = None, include_id: bool = True) -> None:
    payload: dict[str, Any] = {"success": success, "command": command or str(inbound.get("type", ""))}
    if include_id:
        payload["id"] = inbound.get("correlationId")
    if data is not None:
        payload["data"] = data
    if error is not None:
        payload["error"] = error
    write_frame(conn, frame(kind="response", frame_type=payload["command"], correlation_id=str(inbound.get("correlationId")), payload=payload))


def emit_event(conn: socket.socket, event: dict[str, Any]) -> None:
    write_frame(conn, frame(kind="event", frame_type="event", payload={"type": "event", "protocol_version": 2, "session_id": "uds-session", "seq": time.time_ns(), "frame_id": f"frame-{time.time_ns()}", "payload": {"event_type": event.get("type"), "event": event}}))


class RpcClientTests(unittest.TestCase):
    def test_command_builder_supports_daemon_worker_options(self) -> None:
        client = RpcClient(
            executable="gjc",
            model="openrouter/anthropic/claude-sonnet-4.6",
            cwd="/tmp/workspace",
            thinking="high",
            append_system_prompt="extra instructions",
            provider_session_id="provider-session-1",
            tools=("read", "edit", "write"),
            no_session=True,
            no_skills=True,
            no_rules=True,
            extra_args=("--foo", "bar"),
        )
        self.assertEqual(client.command, ("gjc", "--mode", "rpc-daemon-worker", "--model", "openrouter/anthropic/claude-sonnet-4.6", "--thinking", "high", "--append-system-prompt", "extra instructions", "--provider-session-id", "provider-session-1", "--tools", "read,edit,write", "--no-session", "--no-skills", "--no-rules", "--no-title", "--foo", "bar"))

    def test_default_route_does_not_spawn_subprocess(self) -> None:
        client = RpcClient(socket_path="/tmp/missing-gjc-rpc.sock", startup_timeout=0.01)
        with patch("gjc_rpc.client.subprocess.Popen") as mock_popen:
            with self.assertRaises(RpcProcessExitError):
                client.start()
        mock_popen.assert_not_called()
        self.assertIsNone(client._process)

    def test_subprocess_command_is_allowed(self) -> None:
        client = RpcClient(command=("python", "fake.py"), use_legacy_subprocess=True)
        self.assertEqual(client.command, ("python", "fake.py"))
        self.assertIsNone(client._process)

    def test_request_raw_success_and_command_frame_shape(self) -> None:
        def handler(inbound: dict[str, Any], conn: socket.socket) -> None:
            self.assertEqual(inbound["kind"], "command")
            self.assertEqual(inbound["type"], "get_state")
            self.assertEqual(inbound["payload"], {"id": "req_1", "type": "get_state"})
            respond(conn, inbound, {"sessionId": "uds-session", "isStreaming": False})

        server = UdsServer(handler)
        with server.client() as client:
            self.assertEqual(client.request_raw("get_state"), {"sessionId": "uds-session", "isStreaming": False})
        server.join()

    def test_error_response_without_id_is_correlated_by_command(self) -> None:
        def handler(inbound: dict[str, Any], conn: socket.socket) -> None:
            respond(conn, inbound, success=False, error="unsupported: unknown", command="unknown", include_id=False)

        server = UdsServer(handler)
        with server.client() as client:
            with self.assertRaises(RpcCommandError) as ctx:
                client.request_raw("unknown")
        self.assertEqual(ctx.exception.command, "unknown")
        self.assertEqual(ctx.exception.error, "unsupported: unknown")

    def test_ready_and_typed_event_listeners_over_uds(self) -> None:
        def handler(inbound: dict[str, Any], conn: socket.socket) -> None:
            respond(conn, inbound, {})
            emit_event(conn, {"type": "agent_start"})
            emit_event(conn, {"type": "turn_start"})
            emit_event(conn, {"type": "message_update", "message": {"role": "assistant", "content": []}, "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "pong"}})
            emit_event(conn, {"type": "agent_end", "messages": []})

        server = UdsServer(handler)
        ready: list[str] = []
        typed: list[str] = []
        notifications: list[str] = []
        client = server.client()
        try:
            client.on_ready(lambda event: ready.append(event.type))
            client.on_notification(lambda notification: notifications.append(notification.type))
            client.on_turn_start(lambda event: typed.append(event.type))
            client.on_message_update(lambda event: typed.append(event.type))
            client.on_agent_end(lambda event: typed.append(event.type))
            client.start()
            client.request_raw("prompt")
            deadline = time.time() + 1.0
            while len(typed) < 3 and time.time() < deadline:
                time.sleep(0.01)
        finally:
            client.stop()
        self.assertEqual(ready, ["ready"])
        self.assertEqual(typed, ["turn_start"])
        self.assertIn("ready", notifications)

    def test_listener_exceptions_are_reported_without_stopping_client(self) -> None:
        def handler(inbound: dict[str, Any], conn: socket.socket) -> None:
            respond(conn, inbound, {})
            emit_event(conn, {"type": "turn_start"})
            emit_event(conn, {"type": "agent_end", "messages": []})

        server = UdsServer(handler)
        errors: list[tuple[str, str | None, str]] = []
        with server.client() as client:
            client.on_notification(lambda notification: (_ for _ in ()).throw(RuntimeError("boom")) if notification.type == "turn_start" else None)
            client.on_listener_error(lambda event: errors.append((event.listener_kind, event.source_type, str(event.error))))
            client.request_raw("prompt")
            deadline = time.time() + 1.0
            while not errors and time.time() < deadline:
                time.sleep(0.01)
        self.assertEqual(errors, [("notification", "turn_start", "boom")])

    def test_prompt_lifecycle_collectors_are_single_flight(self) -> None:
        def handler(inbound: dict[str, Any], conn: socket.socket) -> None:
            respond(conn, inbound, {})
            time.sleep(0.2)
            emit_event(conn, {"type": "agent_end", "messages": []})

        server = UdsServer(handler)
        errors: list[BaseException] = []
        with server.client() as client:
            def run_prompt() -> None:
                try:
                    client.prompt_and_wait("slow", timeout=1.0)
                except BaseException as exc:
                    errors.append(exc)

            thread = threading.Thread(target=run_prompt)
            thread.start()
            deadline = time.time() + 1.0
            while client._prompt_lifecycle.active_operation != "prompt_and_wait" and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(client._prompt_lifecycle.active_operation, "prompt_and_wait")
            with self.assertRaises(RpcConcurrencyError):
                client.collect_events(timeout=1.0)
            thread.join(timeout=2.0)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
