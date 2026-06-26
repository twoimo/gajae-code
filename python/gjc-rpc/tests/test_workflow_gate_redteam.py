from __future__ import annotations

import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any

from gjc_rpc import GjcFrameDecoder, RpcClient, read_frame, write_frame
from gjc_rpc.protocol import parse_workflow_gate


BASE_GATE = {"type": "workflow_gate", "gate_id": "wg_redteam_ralplan_000001", "stage": "ralplan", "kind": "approval", "schema": {"type": "object"}, "schema_hash": "hash-redteam", "context": {"title": "Approve?"}, "created_at": "2026-06-05T05:00:00.000Z"}


def frame(*, kind: str, frame_type: str, payload: dict[str, Any], correlation_id: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"protocolVersion": 1, "frameId": f"redteam-{time.time_ns()}", "sessionId": "default", "seq": 1, "direction": "server_to_client", "kind": kind, "type": frame_type, "replay": False, "payload": payload}
    if correlation_id is not None:
        out["correlationId"] = correlation_id
    return out


class EchoGateServer:
    def __init__(self, gates: list[dict[str, Any]] | None = None) -> None:
        self.socket_path = Path(tempfile.mkdtemp(prefix="gjc-rpc-redteam-", dir="/tmp")) / "daemon.sock"
        self.ready = threading.Event()
        self.commands: list[dict[str, Any]] = []
        self.gates = gates or []
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
            for gate in self.gates:
                write_frame(conn, frame(kind="event", frame_type="workflow_gate", payload=gate))
            while True:
                inbound = read_frame(conn, decoder)
                if inbound is None:
                    return
                payload = dict(inbound["payload"])
                self.commands.append(payload)
                if payload.get("type") == "workflow_gate_response":
                    write_frame(conn, frame(kind="event", frame_type="extension_error", payload={"type": "extension_error", "extensionPath": "gate-response", "event": str(payload.get("gate_id", "")), "error": repr(payload)}))
                    write_frame(conn, frame(kind="response", frame_type="workflow_gate_response", correlation_id=inbound.get("correlationId"), payload={"success": True, "data": {"gate_id": payload.get("gate_id", ""), "status": "accepted", "answer_hash": "sha256:test", "resolved_at": "2026-06-05T05:01:00.000Z"}}))
        finally:
            conn.close()
            listener.close()

    def client(self) -> RpcClient:
        return RpcClient(socket_path=self.socket_path, startup_timeout=1.0, request_timeout=1.0)


class WorkflowGateRedTeamTest(unittest.TestCase):
    def test_parse_workflow_gate_rejects_missing_each_core_field(self) -> None:
        for field in ("gate_id", "stage", "kind", "schema_hash", "created_at"):
            with self.subTest(field=field):
                payload = dict(BASE_GATE)
                payload.pop(field)
                with self.assertRaises(ValueError):
                    parse_workflow_gate(payload)

    def test_respond_gate_sends_exact_frame_without_idempotency_key(self) -> None:
        server = EchoGateServer()
        with server.client() as client:
            client.respond_gate("wg_no_idem", {"decision": "approve"})
        self.assertEqual(server.commands[0], {"id": "req_1", "type": "workflow_gate_response", "gate_id": "wg_no_idem", "answer": {"decision": "approve"}})

    def test_respond_gate_sends_exact_frame_with_idempotency_key(self) -> None:
        server = EchoGateServer()
        with server.client() as client:
            client.respond_gate("wg_with_idem", "approved", idempotency_key="idem-1")
        self.assertEqual(server.commands[0], {"id": "req_1", "type": "workflow_gate_response", "gate_id": "wg_with_idem", "answer": "approved", "idempotency_key": "idem-1"})

    def test_run_workflow_gate_policy_answers_multiple_gates(self) -> None:
        gates = [dict(BASE_GATE, gate_id="wg_multi_1"), dict(BASE_GATE, gate_id="wg_multi_2", stage="ultragoal", kind="execution")]
        server = EchoGateServer(gates)
        done = threading.Event()
        client = server.client()
        client.on_extension_error(lambda _event: done.set() if len(server.commands) >= 2 else None)
        client.run_workflow_gate_policy(lambda gate: {"answered": gate.gate_id})
        client.start()
        try:
            deadline = time.time() + 1.0
            while len(server.commands) < 2 and time.time() < deadline:
                time.sleep(0.01)
            by_gate = {command["gate_id"]: command["answer"] for command in server.commands[:2]}
            self.assertEqual(by_gate, {"wg_multi_1": {"answered": "wg_multi_1"}, "wg_multi_2": {"answered": "wg_multi_2"}})
        finally:
            client.stop()

    def test_on_workflow_gate_unsubscribe_stops_delivery(self) -> None:
        gates = [dict(BASE_GATE, gate_id="wg_multi_1"), dict(BASE_GATE, gate_id="wg_multi_2")]
        server = EchoGateServer(gates)
        received: list[str] = []
        first = threading.Event()

        def listener(gate: object) -> None:
            received.append(getattr(gate, "gate_id", ""))
            unsubscribe()
            first.set()

        client = server.client()
        unsubscribe = client.on_workflow_gate(listener)
        client.start()
        try:
            self.assertTrue(first.wait(timeout=1.0))
            time.sleep(0.1)
            self.assertEqual(received, ["wg_multi_1"])
        finally:
            client.stop()


if __name__ == "__main__":
    unittest.main()
