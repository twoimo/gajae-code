# G004 executor QA / red-team evidence

QA: passed

Scope: focused ACP, FileGateStore, and notification session-switch probes from `packages/coding-agent`. No production source files were edited. One adversarial ACP regression test was added to `packages/coding-agent/test/acp-agent.test.ts` for a source record removed before the lifecycle invocation.

## Commands and outcomes

### 1. ACP lifecycle re-key: existing collision, bridge, and close-race probes

```sh
bun test test/acp-agent.test.ts --test-name-pattern='re-keys the ACP session map|evicts the mutated session|refuses an extension re-key'
```

Outcome:

```text
3 pass
70 filtered out
0 fail
19 expect() calls
Ran 3 tests across 1 file. [328.00ms]
```

Validated:

- A successful extension re-key replaces the ACP client bridge; the replacement bridge sends `readTextFile` with the new session id.
- Re-keying a source record onto an id owned by another managed record rejects, disposes/evicts the mutated source, and leaves the target usable through `setSessionMode`.
- A source closed while its lifecycle transition is in flight cannot be resurrected under either old or changed id.

### 2. FileGateStore focused regression probes

```sh
bun test test/workflow-gate-broker.test.ts --test-name-pattern='quarantines accepted records|quarantines state whose counter|keeps a corrupt FileGateStore locked|loads a structurally valid'
```

Outcome:

```text
4 pass
14 filtered out
0 fail
10 expect() calls
Ran 4 tests across 1 file. [20.00ms]
```

Validated accepted records lacking a durable `resolution`, lagging stage counters, persistent quarantine markers, and structurally valid persisted state.

### 3. Notification gate migration integration probe

```sh
bun test test/notifications-session-switch.test.ts --test-name-pattern='session_switch reissues pending workflow-gate presentations'
```

Outcome:

```text
1 pass
7 filtered out
0 fail
4 expect() calls
Ran 1 test across 1 file. [459.00ms]
```

Validated that session switching invalidates the old remote action, emits a different action id scoped to the new session, and routes the reply through that new action to the original durable gate id.

### 4. Added adversarial ACP probe: record removed before lifecycle call

```sh
bun test test/acp-agent.test.ts --test-name-pattern='source record was removed before the lifecycle call'
```

Outcome:

```text
1 pass
73 filtered out
0 fail
4 expect() calls
Ran 1 test across 1 file. [228.00ms]
```

The test closes the managed source before invoking the extension's captured `newSession` action. It proves that the lifecycle callback is never invoked, the operation is refused as no longer managed, the closed record remains disposed, and its id is not resurrected.

### 5. Inline FileGateStore red-team state-file probe

Command:

```sh
bun -e "$SCRIPT"
```

`SCRIPT` payload:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileGateStore, WorkflowGateBroker } from "./src/modes/shared/agent-wire/workflow-gate-broker.ts";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};
const pendingRecord = (gateId: string) => ({
	gate: { type: "workflow_gate", gate_id: gateId, stage: "ralplan", kind: "approval", schema: { type: "string" } },
	status: "pending",
	advanced: false,
});
const acceptedWithoutResolution = (gateId: string) => ({
	...pendingRecord(gateId),
	status: "accepted",
	responseHash: "response-hash",
	answer: "approve",
});
const runCorruptionCase = (name: string, state: unknown): void => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `g004-${name}-`));
	const file = path.join(dir, "gates.json");
	const marker = `${file}.corrupt.lock`;
	try {
		fs.writeFileSync(file, JSON.stringify(state));
		let initialError = "";
		try { new FileGateStore(file); } catch (error) { initialError = String(error); }
		assert(/corrupt gate store/.test(initialError), `${name}: corrupt state was accepted`);
		assert(fs.existsSync(marker), `${name}: quarantine marker was not created`);
		let lockedError = "";
		try { new FileGateStore(file); } catch (error) { lockedError = String(error); }
		assert(/quarantine marker/.test(lockedError), `${name}: second construction was not blocked by marker`);

		// Manual recovery retains the quarantined stage high-water mark before unlock.
		fs.unlinkSync(marker);
		fs.writeFileSync(file, JSON.stringify({ counters: { ralplan: 7 }, gates: {} }));
		const recovered = new FileGateStore(file);
		assert(recovered.list().length === 0, `${name}: legitimate recovered state did not load`);
		const gate = new WorkflowGateBroker("quarantine-run", recovered).openGate({
			stage: "ralplan", kind: "approval", schema: { type: "string" },
		});
		assert(gate.gate_id.endsWith("_000008"), `${name}: recovered store reused a quarantined sequence: ${gate.gate_id}`);
		console.log(`${name}: quarantine, persistent lock, and high-water recovery passed (${gate.gate_id})`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

runCorruptionCase("accepted-missing-resolution", {
	counters: { ralplan: 7 },
	gates: { wg_quarantine_ralplan_000007: acceptedWithoutResolution("wg_quarantine_ralplan_000007") },
});
runCorruptionCase("lagging-counter", {
	counters: { ralplan: 6 },
	gates: { wg_quarantine_ralplan_000007: pendingRecord("wg_quarantine_ralplan_000007") },
});

const legitimateDir = fs.mkdtempSync(path.join(os.tmpdir(), "g004-legitimate-"));
try {
	const file = path.join(legitimateDir, "gates.json");
	const gateId = "wg_legitimate_ralplan_000002";
	fs.writeFileSync(file, JSON.stringify({ counters: { ralplan: 2 }, gates: { [gateId]: pendingRecord(gateId) } }));
	const store = new FileGateStore(file);
	assert(store.get(gateId)?.status === "pending", "legitimate persisted gate did not load");
	assert(store.nextSeq("ralplan") === 3, "legitimate store reused its persisted gate sequence");
	console.log("legitimate persisted state loaded and allocated sequence 3");
} finally {
	fs.rmSync(legitimateDir, { recursive: true, force: true });
}
```

Outcome:

```text
accepted-missing-resolution: quarantine, persistent lock, and high-water recovery passed (wg_ntinerun_ralplan_000008)
lagging-counter: quarantine, persistent lock, and high-water recovery passed (wg_ntinerun_ralplan_000008)
legitimate persisted state loaded and allocated sequence 3
```

The probe writes both malformed state variants, verifies quarantine and a persistent `.corrupt.lock`, verifies subsequent construction is refused, then performs explicit manual recovery that preserves the stage high-water mark before removing the marker. The recovered store allocates sequence `8`, never reusing quarantined sequence `7`.

### 6. Final focused re-run after the new ACP regression test

```sh
bun test test/acp-agent.test.ts --test-name-pattern='re-keys the ACP session map|evicts the mutated session|refuses an extension re-key after the source session closes|source record was removed before the lifecycle call'
```

Outcome:

```text
4 pass
70 filtered out
0 fail
23 expect() calls
Ran 4 tests across 1 file. [363.00ms]
```

```sh
bun test test/workflow-gate-broker.test.ts --test-name-pattern='quarantines accepted records|quarantines state whose counter|keeps a corrupt FileGateStore locked|loads a structurally valid'
```

Outcome:

```text
4 pass
14 filtered out
0 fail
10 expect() calls
Ran 4 tests across 1 file. [22.00ms]
```

```sh
bun test test/notifications-session-switch.test.ts --test-name-pattern='session_switch reissues pending workflow-gate presentations'
```

Outcome:

```text
1 pass
7 filtered out
0 fail
4 expect() calls
Ran 1 test across 1 file. [442.00ms]
```

## Verdict

QA: passed

All requested adversarial probes passed. The FileGateStore recovery check intentionally preserves the maximum quarantined sequence before manual unlock; deleting the lock without recovery is not a supported recovery procedure.
