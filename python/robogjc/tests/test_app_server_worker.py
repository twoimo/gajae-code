from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from gjc_rpc.app_server import AgentMessageDeltaNotification, ThreadRef, TurnCompletedNotification, TurnRef

from robogjc import app_server_worker, worker


class _AuditDb:
    def __init__(self) -> None:
        self.models: list[tuple[str, str]] = []
        self.tool_calls: list[dict] = []

    def set_event_model(self, delivery_id: str, model: str) -> None:
        self.models.append((delivery_id, model))

    def log_tool_call(self, **kwargs):
        self.tool_calls.append(kwargs)
        return len(self.tool_calls)

    def get_issue(self, _issue_key: str):
        return None


class _FakeAppServerClient:
    instances: list[_FakeAppServerClient] = []

    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.listeners = []
        self.calls: list[tuple[str, dict]] = []
        _FakeAppServerClient.instances.append(self)

    def __enter__(self):
        self.calls.append(("initialize", {}))
        return self

    def __exit__(self, exc_type, exc, tb):
        self.calls.append(("stop", {}))
        return False

    def on_notification(self, listener):
        self.listeners.append(listener)
        return listener

    def start_thread(self, **params):
        self.calls.append(("thread/start", params))
        return ThreadRef(id="thread-1")

    def start_turn(self, thread_id: str, input: str, **params):
        self.calls.append(("turn/start", {"thread_id": thread_id, "input": input, **params}))
        return TurnRef(id="turn-1", raw={"id": "turn-1"})

    def steer(self, thread_id: str, input: str, **params):
        self.calls.append(("turn/steer", {"thread_id": thread_id, "input": input, **params}))
        for listener in self.listeners:
            listener(AgentMessageDeltaNotification(params={"delta": "done"}))
            listener(
                TurnCompletedNotification(
                    params={
                        "threadId": thread_id,
                        "turn": {"id": "turn-1"},
                        "secret_url": "https://user:token@example.invalid/repo.git",
                    }
                )
            )
        return {"ok": True}

    def interrupt(self, thread_id: str, **params):
        self.calls.append(("turn/interrupt", {"thread_id": thread_id, **params}))
        return {"ok": True}

    def stop(self) -> None:
        self.calls.append(("stop", {}))


class AppServerWorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        _FakeAppServerClient.instances.clear()
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.session_dir = root / "session"
        self.repo_dir = root / "repo"
        self.session_dir.mkdir()
        self.repo_dir.mkdir()
        self.db = _AuditDb()
        self.settings = SimpleNamespace(
            gjc_command="gjc",
            request_timeout_seconds=1.0,
            task_timeout_seconds=1.0,
            resolved_author_name="Robo GJC",
            git_author_email="robot@example.invalid",
            provider=None,
            thinking_level="off",
            pick_model=lambda: "test-model",
            model_pool=("test-model",),
        )
        self.repo = SimpleNamespace(full_name="acme/widgets", owner="acme", name="widgets")
        self.issue = SimpleNamespace(repo="acme/widgets", number=7, title="Bug", body="body")
        workspace = SimpleNamespace(
            root=root,
            session_dir=self.session_dir,
            repo_dir=self.repo_dir,
            branch="robogjc/issue-7",
        )
        self.inputs = worker.TaskInputs(
            settings=self.settings,  # type: ignore[arg-type]
            db=self.db,  # type: ignore[arg-type]
            github=SimpleNamespace(),  # type: ignore[arg-type]
            git_transport=SimpleNamespace(),  # type: ignore[arg-type]
            repo=self.repo,  # type: ignore[arg-type]
            issue=self.issue,  # type: ignore[arg-type]
            workspace=workspace,  # type: ignore[arg-type]
            delivery_id="delivery-1",
        )
        patches = [
            mock.patch("robogjc.app_server_worker.AppServerClient", _FakeAppServerClient),
            mock.patch("robogjc.app_server_worker.worker._AGENT_HOME_STAGE", root / "missing-agent-home-stage"),
            mock.patch("robogjc.app_server_worker.persona.system_append", return_value="SYS"),
            mock.patch("robogjc.app_server_worker.worker._build_prompt", return_value="fix https://user:token@example.invalid/repo.git"),
        ]
        self._patches = patches
        for patch in patches:
            patch.start()

    def tearDown(self) -> None:
        for patch in reversed(self._patches):
            patch.stop()
        self.tmp.cleanup()

    def test_run_task_starts_thread_drives_turn_and_redacts_audit(self) -> None:
        result = asyncio.run(app_server_worker.run_task(task_kind="triage_issue", inputs=self.inputs))

        self.assertEqual(result, "done")
        client = _FakeAppServerClient.instances[0]
        self.assertEqual([name for name, _ in client.calls[:4]], ["initialize", "thread/start", "turn/start", "turn/steer"])
        self.assertEqual(client.calls[1][1]["sessionDir"], str(self.session_dir))
        self.assertEqual(client.calls[2][1]["thread_id"], "thread-1")
        self.assertEqual(client.calls[3][1]["input"], "fix https://user:token@example.invalid/repo.git")
        metadata = json.loads((self.session_dir / "app-server-thread.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata, {"thread_id": "thread-1"})
        audit_json = json.dumps(self.db.tool_calls, sort_keys=True)
        self.assertIn("https://***@example.invalid/repo.git", audit_json)
        self.assertNotIn("user:token@", audit_json)
        self.assertIn(("delivery-1", "test-model"), self.db.models)


if __name__ == "__main__":
    unittest.main()
