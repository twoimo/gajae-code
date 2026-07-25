from pathlib import Path

path = Path("packages/coding-agent/src/session/agent-session.ts")
text = path.read_text()

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
if "#reasoningControlContextGeneration = 0;" not in text:
    if text.count(field_anchor) != 1:
        raise SystemExit("AgentSession mutation field anchor changed")
    text = text.replace(field_anchor, field_anchor + fields, 1)

sync_anchor = "\t#syncAgentSessionId(sessionId?: string): void {\n"
expected_sync = sync_anchor + "\t\tthis.#reasoningControlContextGeneration++;\n"
if expected_sync not in text:
    if text.count(sync_anchor) != 1:
        raise SystemExit("AgentSession session-id sync anchor changed")
    text = text.replace(sync_anchor, expected_sync, 1)

helper_anchor = "\t#setModelWithProviderSessionReset(model: Model): void {\n"
helper = '''\t#setAgentModelWithReasoningContext(model: Model): void {
\t\tthis.#reasoningControlContextGeneration++;
\t\tthis.agent.setModel(model);
\t}

'''
if "#setAgentModelWithReasoningContext(model: Model): void" not in text:
    if text.count(helper_anchor) != 1:
        raise SystemExit("AgentSession model-reset helper anchor changed")
    text = text.replace(helper_anchor, helper + helper_anchor, 1)

path.write_text(text)
