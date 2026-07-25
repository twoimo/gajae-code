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

session_path = Path("packages/coding-agent/src/session/agent-session.ts")
session = session_path.read_text()

field_anchor = "\t#defaultModelSelectionMutationRevision = 0;\n"
fields = '''\t#thinkingLevelMutationRevision = 0;
\t#thinkingVisibilityMutationRevision = 0;
\t#thinkingLevelLiveMutationRevision = 0;
\t#thinkingVisibilityLiveMutationRevision = 0;
\t#reasoningControlContextGeneration = 0;
\t#pendingThinkingLevelControlSuccess:
\t\t| {
\t\t\t\tlevel: ThinkingLevel;
\t\t\t\tmutationRevision: number;
\t\t\t\tsessionId: string;
\t\t\t\tmodel: Model | undefined;
\t\t\t\tcontextGeneration: number;
\t\t  }
\t\t| undefined;
\t#pendingThinkingVisibilityControlSuccess:
\t\t| {
\t\t\t\tvisibility: "visible" | "hidden";
\t\t\t\tmutationRevision: number;
\t\t\t\tsessionId: string;
\t\t\t\tmodel: Model | undefined;
\t\t\t\tcontextGeneration: number;
\t\t  }
\t\t| undefined;
\t#pendingThinkingLevelControlFailure:
\t\t| {
\t\t\t\tmutationRevision: number;
\t\t\t\tliveMutationRevision: number;
\t\t\t\tsessionId: string;
\t\t\t\tmodel: Model | undefined;
\t\t\t\tcontextGeneration: number;
\t\t  }
\t\t| undefined;
\t#pendingThinkingVisibilityControlFailure:
\t\t| {
\t\t\t\tmutationRevision: number;
\t\t\t\tliveMutationRevision: number;
\t\t\t\tsessionId: string;
\t\t\t\tmodel: Model | undefined;
\t\t\t\tcontextGeneration: number;
\t\t  }
\t\t| undefined;
'''
if "#reasoningControlContextGeneration = 0;" not in session:
    if session.count(field_anchor) != 1:
        raise SystemExit("AgentSession mutation field anchor changed")
    session = session.replace(field_anchor, field_anchor + fields, 1)

sync_anchor = "\t#syncAgentSessionId(sessionId?: string): void {\n"
if "#syncAgentSessionId(sessionId?: string): void {\n\t\tthis.#reasoningControlContextGeneration++;" not in session:
    if session.count(sync_anchor) != 1:
        raise SystemExit("AgentSession session-id sync anchor changed")
    session = session.replace(sync_anchor, sync_anchor + "\t\tthis.#reasoningControlContextGeneration++;\n", 1)

helper_anchor = "\t#setModelWithProviderSessionReset(model: Model): void {\n"
helper = '''\t#setAgentModelWithReasoningContext(model: Model): void {
\t\tthis.#reasoningControlContextGeneration++;
\t\tthis.agent.setModel(model);
\t}

'''
if "#setAgentModelWithReasoningContext(model: Model): void" not in session:
    if session.count(helper_anchor) != 1:
        raise SystemExit("AgentSession model-reset helper anchor changed")
    session = session.replace(helper_anchor, helper + helper_anchor, 1)

session_path.write_text(session)
