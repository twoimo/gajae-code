import threading
from gjc_rpc.app_server import (
    AppServerClient,
    AgentMessageDeltaNotification,
    TurnCompletedNotification,
)

WORKTREE = "/Users/bellman/Documents/Workspace/gjc-app-server"

deltas = []
completed = threading.Event()

client = AppServerClient(
    command=["bun", "packages/coding-agent/src/cli.ts", "app-server"],
    cwd=WORKTREE,
    startup_timeout=60.0,
    request_timeout=120.0,
)

@client.on_notification
def _on(note):
    if isinstance(note, AgentMessageDeltaNotification):
        d = note.params.get("delta")
        if d:
            deltas.append(d)
    elif isinstance(note, TurnCompletedNotification):
        completed.set()

with client:
    thread = client.start_thread(cwd=WORKTREE)
    client.start_turn(thread.id, "Reply with exactly the single word: PONG")
    ok = completed.wait(timeout=110)

text = "".join(deltas)
print(f"thread={thread.id}")
print(f"completed={ok}")
print(f"assistant_text={text!r}")
assert ok, "turn did not complete"
assert "PONG" in text, f"expected PONG, got {text!r}"
print("PHASE5_LIVE_OK")
