from __future__ import annotations

import json
import os
import socket
import struct
from pathlib import Path
from typing import Mapping, cast

from .protocol import JsonObject

GJC_RPC_DAEMON_SOCKET_ENV = "GJC_RPC_DAEMON_SOCKET"
MAX_FRAME_BYTES = 8 * 1024 * 1024


class GjcFrameCodecError(ValueError):
    """Raised when a GjcFrame v1 byte stream is malformed."""


class GjcFrameDecoder:
    """Incremental decoder for `[u32 BE length][UTF-8 JSON]` GjcFrame v1 bytes."""

    def __init__(self) -> None:
        self._buffer = bytearray()

    @property
    def buffered(self) -> int:
        return len(self._buffer)

    def push(self, chunk: bytes) -> None:
        self._buffer.extend(chunk)

    def next_frame(self) -> JsonObject | None:
        if len(self._buffer) < 4:
            return None
        declared = struct.unpack(">I", self._buffer[:4])[0]
        if declared > MAX_FRAME_BYTES:
            raise GjcFrameCodecError(f"frame length {declared} exceeds max {MAX_FRAME_BYTES}")
        if len(self._buffer) < 4 + declared:
            return None
        body = bytes(self._buffer[4 : 4 + declared])
        del self._buffer[: 4 + declared]
        decoded = json.loads(body.decode("utf-8"))
        if not isinstance(decoded, dict):
            raise GjcFrameCodecError("GjcFrame JSON body must be an object")
        return cast(JsonObject, decoded)


def encode_frame(frame: Mapping[str, object]) -> bytes:
    """Encode a GjcFrame v1 as 4-byte big-endian length plus UTF-8 JSON."""

    body = json.dumps(frame, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_FRAME_BYTES:
        raise GjcFrameCodecError(f"frame length {len(body)} exceeds max {MAX_FRAME_BYTES}")
    return struct.pack(">I", len(body)) + body


def read_frame(sock: socket.socket, decoder: GjcFrameDecoder) -> JsonObject | None:
    while True:
        frame = decoder.next_frame()
        if frame is not None:
            return frame
        chunk = sock.recv(65536)
        if not chunk:
            if decoder.buffered:
                raise GjcFrameCodecError(f"truncated frame: {decoder.buffered} buffered bytes at EOF")
            return None
        decoder.push(chunk)


def write_frame(sock: socket.socket, frame: Mapping[str, object]) -> None:
    sock.sendall(encode_frame(frame))


def default_daemon_socket_path(env: Mapping[str, str] | None = None, cwd: str | Path | None = None) -> str:
    environ = os.environ if env is None else env
    configured = environ.get(GJC_RPC_DAEMON_SOCKET_ENV)
    if configured:
        return configured
    runtime_dir = environ.get("XDG_RUNTIME_DIR")
    if runtime_dir:
        return str(Path(runtime_dir) / "gjc" / "rpc-sdk" / "daemon.sock")
    base = Path.cwd() if cwd is None else Path(cwd)
    return str(base / ".gjc" / "state" / "rpc-sdk" / "daemon.sock")
