from __future__ import annotations

import runpy
import subprocess
from pathlib import Path

CONFLICT_PATHS = (
    "packages/coding-agent/src/capability/index.ts",
    "packages/coding-agent/src/session/agent-session.ts",
    "packages/coding-agent/test/discovery/agent-discovery-disabled-providers.test.ts",
    "packages/coding-agent/test/input-controller-keybindings.test.ts",
)

for value in CONFLICT_PATHS:
    path = Path(value)
    text = path.read_text()
    if "<<<<<<< " not in text and "=======" not in text and ">>>>>>> " not in text:
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
runpy.run_path(str(base), run_name="__main__")
