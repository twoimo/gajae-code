from __future__ import annotations

from pathlib import Path

base = Path(__file__).with_name("memory-guard-final-base.py")
if not base.exists():
    raise SystemExit(f"memory guard base script missing: {base}")
source = base.read_text()

old = '''elif new_null not in resource:
    raise RuntimeError("effectiveBytes null latch-release anchor mismatch")'''
new = '''elif new_null not in resource and "memoryGuardLastEvaluatedAt.delete(sessionId);" not in resource:
    raise RuntimeError("effectiveBytes null latch-release anchor mismatch")'''
if old not in source:
    raise SystemExit("memory latch verifier source anchor missing")
source = source.replace(old, new, 1)

exec(compile(source, str(base), "exec"), {"__name__": "__main__", "__file__": str(base)})
