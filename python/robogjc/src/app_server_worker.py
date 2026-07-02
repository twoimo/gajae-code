"""Opt-in robogjc worker backed by `gjc app-server`.

This module intentionally lives side-by-side with `worker.py`. The legacy RPC
worker remains the default path; callers must opt into this app-server driver.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import Any, Mapping

from gjc_rpc.app_server import AppServerClient, AppServerError, AppServerProcessExitError

from robogjc import persona, worker
from robogjc.cancellation import register_cancel_hook, unregister_cancel_hook
from robogjc.db import issue_key
from robogjc.git_ops import redact_credentials
from robogjc.host_tools import AbortController, ToolBindings, _git_identity_env
from robogjc.sandbox import _prepare_slot_runtime_env, _safe_directory_env

log = logging.getLogger(__name__)

_THREAD_METADATA = "app-server-thread.json"


def _metadata_path(session_dir: Path) -> Path:
    return session_dir / _THREAD_METADATA


def _read_thread_id(session_dir: Path) -> str | None:
    path = _metadata_path(session_dir)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    thread_id = raw.get("thread_id")
    return thread_id if isinstance(thread_id, str) and thread_id else None


def _write_thread_id(session_dir: Path, thread_id: str) -> None:
    session_dir.mkdir(parents=True, exist_ok=True)
    tmp = _metadata_path(session_dir).with_suffix(".tmp")
    tmp.write_text(json.dumps({"thread_id": thread_id}, separators=(",", ":")) + "\n", encoding="utf-8")
    tmp.replace(_metadata_path(session_dir))


def _audit_app_server_event(bindings: ToolBindings, name: str, args: Mapping[str, Any], result: Any | None = None) -> None:
    safe_args = json.loads(json.dumps(args, default=str))
    safe_result = json.loads(json.dumps(result, default=str)) if result is not None else None
    safe_args = _redact_json(safe_args)
    safe_result = _redact_json(safe_result) if safe_result is not None else None
    bindings.db.log_tool_call(
        issue_key=bindings.issue_key,
        tool=name,
        args=safe_args if isinstance(safe_args, Mapping) else {"value": safe_args},
        result=safe_result if isinstance(safe_result, Mapping) else ({"value": safe_result} if safe_result is not None else None),
    )


def _redact_json(value: Any) -> Any:
    if isinstance(value, str):
        return redact_credentials(value)
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _redact_json(item) for key, item in value.items()}
    return value


def _notification_type(notification: Any) -> str | None:
    value = getattr(notification, "type", None)
    if isinstance(value, str):
        return value
    payload = getattr(notification, "payload", None)
    if isinstance(payload, Mapping):
        method = payload.get("method")
        if method == "turn/completed":
            return "turn_completed"
        if isinstance(method, str):
            return method.replace("/", "_")
    return None


def _notification_params(notification: Any) -> Mapping[str, Any]:
    params = getattr(notification, "params", None)
    if isinstance(params, Mapping):
        return params
    payload = getattr(notification, "payload", None)
    if isinstance(payload, Mapping):
        raw_params = payload.get("params")
        if isinstance(raw_params, Mapping):
            return raw_params
    return {}


def _run_app_server_blocking(
    inputs: worker.TaskInputs,
    *,
    task_kind: str,
    prompt: str,
    loop: asyncio.AbstractEventLoop,
    bindings: ToolBindings,
) -> str | None:
    del loop  # App-server host-tool bridging is not wired until this path becomes default.
    settings = inputs.settings
    completed = threading.Event()
    assistant_text: list[str] = []
    completion_payload: dict[str, Any] | None = None

    def _on_notification(notification: Any) -> None:
        nonlocal completion_payload
        kind = _notification_type(notification)
        params = dict(_notification_params(notification))
        if kind == "agent_message_delta":
            delta = params.get("delta") or params.get("text")
            if isinstance(delta, str):
                assistant_text.append(delta)
        elif kind == "turn_completed":
            completion_payload = params
            completed.set()
        elif kind == "item_completed":
            item = params.get("item")
            if isinstance(item, Mapping):
                name = item.get("name") or item.get("tool") or item.get("type")
                if isinstance(name, str):
                    _audit_app_server_event(bindings, name, {"notification": params}, item)

    app_env = worker._build_extra_env(settings)
    app_env.update(_prepare_slot_runtime_env(inputs.workspace, inputs.slot_uid))
    app_env.update(_safe_directory_env(bindings.workspace.repo_dir))
    app_env.update(_git_identity_env(inputs.settings.resolved_author_name, inputs.settings.git_author_email))

    model_override, thinking_override = worker._resolve_pragma_overrides(None, settings)
    chosen_model = model_override or settings.pick_model()
    chosen_thinking = thinking_override or settings.thinking_level
    inputs.db.set_event_model(inputs.delivery_id, chosen_model)

    with AppServerClient(
        executable=settings.gjc_command,
        cwd=bindings.workspace.repo_dir,
        env=app_env,
        request_timeout=settings.request_timeout_seconds,
        startup_timeout=60.0,
    ) as client:
        client.on_notification(_on_notification)

        def _cancel_hook() -> None:
            thread_id = _read_thread_id(bindings.workspace.session_dir)
            if thread_id is not None:
                try:
                    client.interrupt(thread_id)
                except AppServerError:
                    pass
            client.stop()

        if bindings.abort is not None:
            bindings.abort.stop = _cancel_hook
        register_cancel_hook(_cancel_hook)
        try:
            thread_id = _read_thread_id(bindings.workspace.session_dir)
            resuming = thread_id is not None
            if thread_id is None:
                thread = client.start_thread(
                    cwd=str(bindings.workspace.repo_dir),
                    sessionDir=str(bindings.workspace.session_dir),
                    systemPrompt=persona.system_append(repo=inputs.repo, issue=inputs.issue, workspace=inputs.workspace),
                    model=chosen_model,
                    provider=settings.provider,
                    thinking=chosen_thinking if chosen_thinking != "off" else None,
                )
                thread_id = thread.id
                _write_thread_id(bindings.workspace.session_dir, thread_id)
            log.info(
                "app_server_thread",
                extra={"issue": bindings.issue_key, "task": task_kind, "thread_id": thread_id, "resuming": resuming},
            )
            _audit_app_server_event(
                bindings,
                "app_server_thread",
                {"thread_id": thread_id, "session_dir": str(bindings.workspace.session_dir), "resuming": resuming},
            )

            client.start_turn(thread_id, "", task=task_kind)
            client.steer(thread_id, prompt)
            if not completed.wait(settings.task_timeout_seconds):
                raise TimeoutError("app-server task timed out waiting for turn/completed")
            _audit_app_server_event(bindings, "app_server_turn_completed", {"thread_id": thread_id}, completion_payload or {})
            return "".join(assistant_text) or None
        except AppServerProcessExitError as exc:
            raise RuntimeError(redact_credentials(str(exc))) from exc
        finally:
            unregister_cancel_hook()


async def run_task(
    *,
    task_kind: str,
    inputs: worker.TaskInputs,
    comment: Any | None = None,
    pr_number: int | None = None,
    review_payload: dict[str, Any] | None = None,
    directive: worker.DirectiveInfo | None = None,
    thread: tuple[worker.ThreadMessage, ...] = (),
) -> str | None:
    """Run one robogjc task through the opt-in app-server client."""
    loop = asyncio.get_running_loop()
    bindings = ToolBindings(
        db=inputs.db,
        github=inputs.github,
        git_transport=inputs.git_transport,
        repo=inputs.repo,
        issue=inputs.issue,
        workspace=inputs.workspace,
        loop=loop,
        settings=inputs.settings,
        author_name=inputs.settings.resolved_author_name,
        author_email=inputs.settings.git_author_email,
        inbound_thread_number=pr_number,
        inbound_is_pr=pr_number is not None,
        slot_uid=inputs.slot_uid,
        abort=AbortController(),
    )
    prompt = worker._build_prompt(
        task_kind,
        inputs,
        comment=comment,
        pr_number=pr_number,
        review_payload=review_payload,
        directive=directive,
        thread=thread,
        resuming=_read_thread_id(inputs.workspace.session_dir) is not None,
    )
    return await asyncio.to_thread(
        _run_app_server_blocking,
        inputs,
        task_kind=task_kind,
        prompt=prompt,
        loop=loop,
        bindings=bindings,
    )


__all__ = ["run_task"]
