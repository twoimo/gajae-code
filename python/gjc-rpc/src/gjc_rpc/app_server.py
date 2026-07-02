from __future__ import annotations

import json
import os
import queue
import shlex
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Protocol, Sequence, TextIO, cast

from .protocol import JsonObject, JsonValue, UnknownNotification


AppServerNotificationListener = Callable[["AppServerNotification"], None]


class AppServerError(RuntimeError):
    """Base exception for the app-server JSON-RPC client."""


class AppServerTimeoutError(AppServerError):
    """Raised when the app-server does not respond before the request timeout."""


class AppServerProcessExitError(AppServerError):
    """Raised when the app-server transport exits while requests are pending."""


class AppServerCommandError(AppServerError):
    """Raised when the app-server returns a JSON-RPC error object."""

    def __init__(self, method: str, code: int | None, message: str):
        prefix = f"{method}: " if method else ""
        detail = f"{code}: {message}" if code is not None else message
        super().__init__(f"{prefix}{detail}")
        self.method = method
        self.code = code
        self.message = message


@dataclass(slots=True, frozen=True)
class ThreadRef:
    id: str


@dataclass(slots=True, frozen=True)
class TurnRef:
    id: str | None
    raw: JsonObject


@dataclass(slots=True, frozen=True)
class TurnStartedNotification:
    params: JsonObject
    type: str = "turn_started"


@dataclass(slots=True, frozen=True)
class ItemStartedNotification:
    params: JsonObject
    type: str = "item_started"


@dataclass(slots=True, frozen=True)
class AgentMessageDeltaNotification:
    params: JsonObject
    type: str = "agent_message_delta"


@dataclass(slots=True, frozen=True)
class ItemCompletedNotification:
    params: JsonObject
    type: str = "item_completed"


@dataclass(slots=True, frozen=True)
class TurnCompletedNotification:
    params: JsonObject
    type: str = "turn_completed"


@dataclass(slots=True, frozen=True)
class GjcEventNotification:
    params: JsonObject
    type: str = "gjc_event"


AppServerNotification = (
    TurnStartedNotification
    | ItemStartedNotification
    | AgentMessageDeltaNotification
    | ItemCompletedNotification
    | TurnCompletedNotification
    | GjcEventNotification
    | UnknownNotification
)


class AppServerTransport(Protocol):
    stdin: TextIO | None
    stdout: TextIO | None
    stderr: TextIO | None

    def poll(self) -> int | None: ...

    def terminate(self) -> None: ...

    def wait(self, timeout: float | None = None) -> int: ...

    def kill(self) -> None: ...


@dataclass(slots=True)
class _PendingRequest:
    method: str
    response_queue: queue.Queue[JsonObject | BaseException]


def parse_app_server_notification(payload: JsonObject) -> AppServerNotification:
    method = payload.get("method")
    params_value = payload.get("params")
    params = dict(params_value) if isinstance(params_value, dict) else {}

    if method == "turn/started":
        return TurnStartedNotification(params=cast(JsonObject, params))
    if method == "item/started":
        return ItemStartedNotification(params=cast(JsonObject, params))
    if method == "item/agentMessage/delta":
        return AgentMessageDeltaNotification(params=cast(JsonObject, params))
    if method == "item/completed":
        return ItemCompletedNotification(params=cast(JsonObject, params))
    if method == "turn/completed":
        return TurnCompletedNotification(params=cast(JsonObject, params))
    if method == "gjc/event":
        return GjcEventNotification(params=cast(JsonObject, params))
    return UnknownNotification(payload=dict(payload))


class AppServerClient:
    """Typed client for the side-by-side `gjc app-server` JSON-RPC 2.0 transport."""

    def __init__(
        self,
        *,
        command: Sequence[str] | str | None = None,
        executable: str = "gjc",
        cwd: str | Path | None = None,
        env: Mapping[str, str] | None = None,
        startup_timeout: float = 30.0,
        request_timeout: float = 30.0,
        transport: AppServerTransport | None = None,
    ) -> None:
        self._command = self._normalize_command(command)
        self._executable = executable
        self._cwd = Path(cwd) if cwd is not None else None
        self._env = dict(env or {})
        self._startup_timeout = startup_timeout
        self._request_timeout = request_timeout
        self._injected_transport = transport

        self._transport: AppServerTransport | None = None
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._pending: dict[str, _PendingRequest] = {}
        self._request_id = 0
        self._stopping = False
        self._closed_error: BaseException | None = None
        self._stderr_chunks: list[str] = []
        self._notification_listeners: list[AppServerNotificationListener] = []

    def __enter__(self) -> "AppServerClient":
        return self.start()

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.stop()

    @property
    def command(self) -> tuple[str, ...]:
        if self._command is not None:
            return self._command
        env_command = os.environ.get("GJC_APP_SERVER_COMMAND")
        if env_command:
            return tuple(shlex.split(env_command))
        return (self._executable, "app-server")

    @property
    def stderr(self) -> str:
        with self._state_lock:
            return "".join(self._stderr_chunks)

    def on_notification(self, listener: AppServerNotificationListener) -> AppServerNotificationListener:
        self._notification_listeners.append(listener)
        return listener

    def start(self) -> "AppServerClient":
        if self._transport is not None:
            raise AppServerError("app-server client is already started")
        self._stopping = False
        self._closed_error = None
        with self._state_lock:
            self._stderr_chunks.clear()
            self._pending.clear()

        if self._injected_transport is not None:
            transport = self._injected_transport
        else:
            transport = subprocess.Popen(
                list(self.command),
                cwd=str(self._cwd) if self._cwd is not None else None,
                env={**os.environ, **self._env},
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        self._transport = transport
        self._stdout_thread = threading.Thread(target=self._read_stdout_loop, name="gjc-app-server-stdout", daemon=True)
        self._stdout_thread.start()
        if transport.stderr is not None:
            self._stderr_thread = threading.Thread(target=self._read_stderr_loop, name="gjc-app-server-stderr", daemon=True)
            self._stderr_thread.start()

        self.initialize(timeout=self._startup_timeout)
        self._notify("initialized", {})
        return self

    def stop(self) -> None:
        transport = self._transport
        if transport is None:
            return
        self._stopping = True
        try:
            if transport.poll() is None:
                transport.terminate()
                try:
                    transport.wait(timeout=2.0)
                except Exception:
                    transport.kill()
        finally:
            self._transport = None
            self._fail_pending(AppServerProcessExitError("app-server client stopped"))

    def initialize(self, params: Mapping[str, JsonValue] | None = None, *, timeout: float | None = None) -> JsonObject:
        return self.request("initialize", dict(params or {}), timeout=timeout)

    def start_thread(self, **params: JsonValue) -> ThreadRef:
        result = self.request("thread/start", params)
        thread = result.get("thread")
        if not isinstance(thread, dict) or not isinstance(thread.get("id"), str):
            raise AppServerError("thread/start response must contain thread.id")
        return ThreadRef(id=thread["id"])

    def start_turn(self, thread_id: str, input: str, **params: JsonValue) -> TurnRef:
        payload: JsonObject = {"threadId": thread_id, "input": input}
        payload.update(params)
        result = self.request("turn/start", payload)
        turn = result.get("turn")
        if not isinstance(turn, dict):
            raise AppServerError("turn/start response must contain turn")
        turn_id = turn.get("id")
        if turn_id is not None and not isinstance(turn_id, str):
            raise AppServerError("turn.id must be a string when present")
        return TurnRef(id=turn_id, raw=cast(JsonObject, dict(turn)))

    def prompt(self, thread_id: str, input: str, **params: JsonValue) -> TurnRef:
        return self.start_turn(thread_id, input, **params)

    def steer(self, thread_id: str, input: str, **params: JsonValue) -> JsonObject:
        payload: JsonObject = {"threadId": thread_id, "input": input}
        payload.update(params)
        return self.request("turn/steer", payload)

    def interrupt(self, thread_id: str, **params: JsonValue) -> JsonObject:
        payload: JsonObject = {"threadId": thread_id}
        payload.update(params)
        return self.request("turn/interrupt", payload)

    def read_thread(self, thread_id: str, **params: JsonValue) -> JsonObject:
        payload: JsonObject = {"threadId": thread_id}
        payload.update(params)
        return self.request("thread/read", payload)

    def gjc_state_read(self, **params: JsonValue) -> JsonObject:
        return self.request("gjc/state/read", params)

    def request(self, method: str, params: Mapping[str, JsonValue] | None = None, *, timeout: float | None = None) -> JsonObject:
        transport = self._require_transport()
        request_id = self._next_request_id()
        envelope: JsonObject = {"id": request_id, "method": method}
        if params is not None:
            envelope["params"] = dict(params)
        response_queue: queue.Queue[JsonObject | BaseException] = queue.Queue(maxsize=1)
        with self._state_lock:
            self._pending[request_id] = _PendingRequest(method=method, response_queue=response_queue)
        try:
            self._write_json(transport, envelope)
        except BaseException:
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise

        try:
            response = response_queue.get(timeout=self._request_timeout if timeout is None else timeout)
        except queue.Empty as exc:
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise AppServerTimeoutError(f"Timed out waiting for response to {method}. Stderr: {self.stderr}") from exc

        if isinstance(response, BaseException):
            raise response
        if "error" in response:
            error = response.get("error")
            code: int | None = None
            message = "unknown app-server error"
            if isinstance(error, dict):
                raw_code = error.get("code")
                if isinstance(raw_code, int) and not isinstance(raw_code, bool):
                    code = raw_code
                raw_message = error.get("message")
                if isinstance(raw_message, str):
                    message = raw_message
            raise AppServerCommandError(method, code, message)
        result = response.get("result")
        if result is None:
            return {}
        if not isinstance(result, dict):
            raise AppServerError(f"{method} result must be an object")
        return cast(JsonObject, dict(result))

    def _notify(self, method: str, params: Mapping[str, JsonValue] | None = None) -> None:
        envelope: JsonObject = {"method": method}
        if params is not None:
            envelope["params"] = dict(params)
        self._write_json(self._require_transport(), envelope)

    def _next_request_id(self) -> str:
        with self._state_lock:
            self._request_id += 1
            return f"req_{self._request_id}"

    def _require_transport(self) -> AppServerTransport:
        if self._transport is None:
            raise AppServerError("app-server client is not started")
        return self._transport

    def _write_json(self, transport: AppServerTransport, payload: JsonObject) -> None:
        if transport.stdin is None:
            raise AppServerProcessExitError("app-server stdin is unavailable")
        with self._write_lock:
            try:
                transport.stdin.write(json.dumps(payload))
                transport.stdin.write("\n")
                transport.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise AppServerProcessExitError(f"Failed to write app-server frame: {exc}") from exc

    def _read_stdout_loop(self) -> None:
        transport = self._transport
        if transport is None or transport.stdout is None:
            return
        line_number = 0
        try:
            for line in transport.stdout:
                line_number += 1
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    payload = cast(JsonObject, json.loads(stripped))
                except json.JSONDecodeError as exc:
                    raise AppServerError(f"Failed to decode app-server output on line {line_number}: {exc}") from exc
                if "id" in payload and ("result" in payload or "error" in payload):
                    self._handle_response(payload)
                elif "method" in payload:
                    self._handle_notification(payload)
                else:
                    self._handle_notification(payload)
        except BaseException as exc:
            if not self._stopping:
                self._closed_error = exc
                self._fail_pending(exc if isinstance(exc, AppServerError) else AppServerProcessExitError(str(exc)))

    def _read_stderr_loop(self) -> None:
        transport = self._transport
        if transport is None or transport.stderr is None:
            return
        try:
            for chunk in transport.stderr:
                with self._state_lock:
                    self._stderr_chunks.append(chunk)
        except Exception:
            return

    def _handle_response(self, payload: JsonObject) -> None:
        request_id = payload.get("id")
        if not isinstance(request_id, str):
            return
        with self._state_lock:
            pending = self._pending.pop(request_id, None)
        if pending is not None:
            pending.response_queue.put(payload)

    def _handle_notification(self, payload: JsonObject) -> None:
        notification = parse_app_server_notification(payload)
        for listener in tuple(self._notification_listeners):
            listener(notification)

    def _fail_pending(self, error: BaseException) -> None:
        with self._state_lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for request in pending:
            request.response_queue.put(error)

    def _normalize_command(self, command: Sequence[str] | str | None) -> tuple[str, ...] | None:
        if command is None:
            return None
        if isinstance(command, str):
            return tuple(shlex.split(command))
        return tuple(command)
