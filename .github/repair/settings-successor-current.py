from __future__ import annotations

import subprocess
from pathlib import Path

CONFLICT_PATHS = (
    "packages/coding-agent/src/capability/index.ts",
    "packages/coding-agent/src/session/agent-session.ts",
    "packages/coding-agent/test/discovery/agent-discovery-disabled-providers.test.ts",
    "packages/coding-agent/test/input-controller-keybindings.test.ts",
)


def has_conflict_markers(text: str) -> bool:
    return any(line.startswith(("<<<<<<< ", "=======", ">>>>>>> ")) for line in text.splitlines())


for value in CONFLICT_PATHS:
    path = Path(value)
    text = path.read_text()
    if not has_conflict_markers(text):
        continue
    try:
        current_dev = subprocess.check_output(
            ["git", "show", f":2:{value}"],
            text=True,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"unable to recover current-dev stage for {value}: {error.stderr}") from error
    path.write_text(current_dev)

base = Path(__file__).with_name("settings-successor-base.py")
if not base.exists():
    raise SystemExit(f"settings successor base script missing: {base}")
source = base.read_text()
old = 'if "<<<<<<< " in text or "=======" in text or ">>>>>>> " in text:'
new = 'if any(line.startswith(("<<<<<<< ", "=======", ">>>>>>> ")) for line in text.splitlines()):'
if old not in source:
    raise SystemExit("settings conflict-marker verifier source anchor missing")
source = source.replace(old, new, 1)
exec(compile(source, str(base), "exec"), {"__name__": "__main__", "__file__": str(base)})
