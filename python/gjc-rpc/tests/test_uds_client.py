from __future__ import annotations

import socket
import threading
import tempfile
from pathlib import Path
from typing import Any
import time
from unittest.mock import patch

from gjc_rpc import GjcFrameDecoder, RpcClient, default_daemon_socket_path, encode_frame, read_frame, write_frame


def make_frame(*, kind: str, frame_type: str, payload: dict[str, Any], correlation_id: str | None = None, direction: str = "server_to_client") -> dict[str, Any]:
    frame: dict[str, Any] = {
        "protocolVersion": 1,
        "frameId": f"frame-{kind}-{frame_type}",
        "sessionId": "default",
        "seq": 1,
        "direction": direction,
        "kind": kind,
        "type": frame_type,
        "replay": False,
        "payload": payload,
    }
    if correlation_id is not None:
        frame["correlationId"] = correlation_id
    return frame


def test_gjc_frame_codec_round_trips_camel_case_wire_shape() -> None:
    frame = make_frame(
        kind="command",
        frame_type="get_state",
        direction="client_to_server",
        correlation_id="req_1",
        payload={"type": "get_state", "id": "req_1", "modelId": "claude"},
    )

    encoded = encode_frame(frame)
    declared = int.from_bytes(encoded[:4], "big")
    assert declared == len(encoded) - 4
    assert b'"protocolVersion"' in encoded[4:]
    assert b'"frameId"' in encoded[4:]
    assert b'"correlationId"' in encoded[4:]
    assert b'"modelId"' in encoded[4:]

    decoder = GjcFrameDecoder()
    decoder.push(encoded[:3])
    assert decoder.next_frame() is None
    decoder.push(encoded[3:])
    assert decoder.next_frame() == frame
    assert decoder.buffered == 0


def test_default_daemon_socket_path_matches_rpc_sdk_discovery(tmp_path: Path) -> None:
    assert default_daemon_socket_path({"GJC_RPC_DAEMON_SOCKET": "/tmp/custom.sock"}, tmp_path) == "/tmp/custom.sock"
    assert default_daemon_socket_path({"XDG_RUNTIME_DIR": "/tmp/runtime"}, tmp_path) == "/tmp/runtime/gjc/rpc-sdk/daemon.sock"
    assert default_daemon_socket_path({}, tmp_path) == str(tmp_path / ".gjc" / "state" / "rpc-sdk" / "daemon.sock")


def test_rpc_client_hello_command_and_event_over_uds(tmp_path: Path) -> None:
    socket_path = Path(tempfile.mkdtemp(prefix="gjc-rpc-", dir="/tmp")) / "daemon.sock"
    ready = threading.Event()
    seen: list[dict[str, Any]] = []

    def server() -> None:
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(socket_path))
        listener.listen(1)
        ready.set()
        conn, _ = listener.accept()
        try:
            decoder = GjcFrameDecoder()
            hello = read_frame(conn, decoder)
            assert hello is not None
            seen.append(hello)
            assert hello["kind"] == "hello"
            assert hello["direction"] == "client_to_server"
            assert hello["payload"] == {"protocolVersion": 1, "requested": [{"session": "default", "redaction": "none"}]}
            write_frame(conn, make_frame(kind="ready", frame_type="hello_accepted", payload={"sessions": 1}))

            command = read_frame(conn, decoder)
            assert command is not None
            seen.append(command)
            assert command["kind"] == "command"
            assert command["direction"] == "client_to_server"
            assert command["type"] == "get_state"
            assert command["payload"] == {"id": "req_1", "type": "get_state"}
            correlation_id = command["correlationId"]
            write_frame(
                conn,
                make_frame(
                    kind="response",
                    frame_type="get_state",
                    correlation_id=correlation_id,
                    payload={"success": True, "data": {"sessionId": "uds-session", "isStreaming": False}},
                ),
            )
            write_frame(conn, make_frame(kind="event", frame_type="event", payload={"type": "event", "protocol_version": 2, "session_id": "uds-session", "seq": 1, "frame_id": "frame-1", "payload": {"event_type": "agent_start", "event": {"type": "agent_start"}}}))
        finally:
            conn.close()
            listener.close()

    thread = threading.Thread(target=server, daemon=True)
    thread.start()
    assert ready.wait(1.0)

    events: list[str] = []
    with RpcClient(socket_path=socket_path, startup_timeout=1.0, request_timeout=1.0) as client:
        client.on_event(lambda event: events.append(event.type))
        payload = client.request_raw("get_state")
        for _ in range(20):
            if events:
                break
            time.sleep(0.01)
        assert payload == {"sessionId": "uds-session", "isStreaming": False}

    thread.join(timeout=1.0)
    assert events == ["agent_start"]
    assert [frame["kind"] for frame in seen] == ["hello", "command"]


def test_default_rpc_client_route_does_not_spawn_subprocess(tmp_path: Path) -> None:
    client = RpcClient(socket_path=tmp_path / "missing.sock", startup_timeout=0.01)
    assert client.command == ("gjc", "--mode", "rpc-daemon-worker", "--no-title")
    with patch("gjc_rpc.client.subprocess.Popen") as mock_popen:
        try:
            client.start()
        except Exception:
            pass
    mock_popen.assert_not_called()
    assert client._process is None
