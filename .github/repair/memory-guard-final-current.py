from __future__ import annotations

from pathlib import Path

base = Path(__file__).with_name("memory-guard-final-base.py")
if not base.exists():
    raise SystemExit(f"memory guard base script missing: {base}")
source = base.read_text()

literal_old = """\t\t\tmemoryGuardRestartCooldownUntil.delete(sessionId);
\t\t\tcontinue;"""
literal_new = """\t\t\tmemoryGuardRestartCooldownUntil.delete(sessionId);
\t\t\tmemoryGuardLastEvaluatedAt.delete(sessionId);
\t\t\tcontinue;"""
escaped_old = r"\t\t\tmemoryGuardRestartCooldownUntil.delete(sessionId);\n\t\t\tcontinue;"
escaped_new = r"\t\t\tmemoryGuardRestartCooldownUntil.delete(sessionId);\n\t\t\tmemoryGuardLastEvaluatedAt.delete(sessionId);\n\t\t\tcontinue;"

if literal_old in source:
    source = source.replace(literal_old, literal_new, 1)
elif escaped_old in source:
    source = source.replace(escaped_old, escaped_new, 1)
elif "memoryGuardLastEvaluatedAt.delete(sessionId);" not in source:
    raise SystemExit("memory latch idempotence anchor missing")

exec(compile(source, str(base), "exec"), {"__name__": "__main__", "__file__": str(base)})
