from __future__ import annotations

import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any

from gjc_rpc import GjcFrameDecoder, RpcClient, WorkflowGate, read_frame, write_frame


def frame(*, kind: str, frame_type: str, payload: dict[str, Any], correlation_id: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"protocolVersion": 1, "frameId": f"gate-{time.time_ns()}", "sessionId": "default", "seq": 1, "direction": "server_to_client", "kind": kind, "type": frame_type, "replay": False, "payload": payload}
    if correlation_id is not None:
        out["correlationId"] = correlation_id
    return out


GATE = {"type": "workflow_gate", "gate_id": "wg_test_ralplan_000001", "stage": "ralplan", "kind": "approval", "schema": {"type": "object", "properties": {"decision": {"type": "string"}}, "required": ["decision"]}, "schema_hash": "hash-1", "context": {"title": "Approve?"}, "created_at": "2026-06-05T05:00:00.000Z", "required": True}


class GateServer:
    def __init__(self, emit_gates: int = 1) -> None:
        self.socket_path = Path(tempfile.mkdtemp(prefix="gjc-rpc-gate-", dir="/tmp")) / "daemon.sock"
        self.ready = threading.Event()
        self.commands: list[dict[str, Any]] = []
        self.emit_gates = emit_gates
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
            if read_frame(conn, decoder) is None:
                return
            write_frame(conn, frame(kind="ready", frame_type="hello_accepted", payload={"sessions": 1}))
            for index in range(self.emit_gates):
                gate = dict(GATE, gate_id=f"wg_multi_{index + 1}" if self.emit_gates > 1 else GATE["gate_id"])
                write_frame(conn, frame(kind="event", frame_type="workflow_gate", payload=gate))
            while True:
                inbound = read_frame(conn, decoder)
                if inbound is None:
                    return
                payload = inbound["payload"]
                self.commands.append(payload)
                if payload.get("type") == "workflow_gate_response":
                    write_frame(conn, frame(kind="event", frame_type="extension_error", payload={"type": "extension_error", "extensionPath": "gate-echo", "event": payload.get("gate_id", ""), "error": str(payload.get("answer"))}))
                    write_frame(conn, frame(kind="response", frame_type="workflow_gate_response", correlation_id=inbound.get("correlationId"), payload={"success": True, "data": {"gate_id": payload.get("gate_id", ""), "status": "accepted", "answer_hash": "sha256:test", "resolved_at": "2026-06-05T05:01:00.000Z"}}))
        finally:
            conn.close()
            listener.close()

    def client(self) -> RpcClient:
        return RpcClient(socket_path=self.socket_path, startup_timeout=1.0, request_timeout=1.0)


class WorkflowGateClientTest(unittest.TestCase):
    def test_on_workflow_gate_receives_typed_gate(self) -> None:
        server = GateServer()
        received: list[WorkflowGate] = []
        done = threading.Event()
        client = server.client()
        client.on_workflow_gate(lambda gate: (received.append(gate), done.set()))
        client.start()
        try:
            self.assertTrue(done.wait(timeout=1.0))
            self.assertEqual(received[0].gate_id, "wg_test_ralplan_000001")
            self.assertEqual(received[0].kind, "approval")
        finally:
            client.stop()

    def test_respond_gate_waits_for_resolution_envelope(self) -> None:
        server = GateServer()
        with server.client() as client:
            resolution = client.respond_gate("wg_test_ralplan_000001", {"decision": "approve"}, idempotency_key="idem-1")
        self.assertEqual(resolution["gate_id"], "wg_test_ralplan_000001")
        self.assertEqual(resolution["status"], "accepted")
        self.assertEqual(resolution["answer_hash"], "sha256:test")
        self.assertEqual(server.commands[-1]["idempotency_key"], "idem-1")

    def test_run_workflow_gate_policy_responds_and_round_trips(self) -> None:
        server = GateServer()
        echoes: list[str] = []
        done = threading.Event()
        client = server.client()
        client.on_extension_error(lambda event: (echoes.append(event.error), done.set()))
        client.run_workflow_gate_policy(lambda gate: {"decision": "approve"} if gate.kind == "approval" else {"selected": []})
        client.start()
        try:
            self.assertTrue(done.wait(timeout=1.0))
            self.assertIn("approve", echoes[0])
        finally:
            client.stop()


if __name__ == "__main__":
    unittest.main()
