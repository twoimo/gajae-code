#!/usr/bin/env bun

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as ts from "typescript";
import { ADAPTERS, OPERATIONS, type Operation } from "../src/sdk/protocol/operation-registry";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const inventoryPath = process.env.GJC_SDK_OPERATION_INVENTORY
	? path.resolve(process.env.GJC_SDK_OPERATION_INVENTORY)
	: path.join(repoRoot, "packages/coding-agent/src/sdk/protocol/operation-inventory.generated.json");

/** Reviewed seams deliberately excluded from the public SDK operation surface. */
const LOCKED_EXCLUSIONS: Readonly<Record<string, string>> = {
	"slash_command:settings": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:theme": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:copy": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:changelog": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:help": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:hotkeys": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:agents": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:monitors": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:tree": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:provider": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:logout": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:ssh": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:drop": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:contribute-pr": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:btw": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:debug": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:memory": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:exit": "visual/local-only command, not a user-facing SDK control seam",
	"agent_session:constructor": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:nextToolChoice": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setForcedToolChoice": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getActiveSkillState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getActiveSkillPhase": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:peekQueueInvoker": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:peekStandingResolveHandler": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setStandingResolveHandler": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:buildForkContextSeed": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getHindsightSessionState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setHindsightSessionState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:markPlanCompactAbortPending": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:clearPlanCompactAbortPending": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:enqueueCustomMessageDisplay": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getAgentId": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:emitNotice": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:subscribe": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:dispose": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:disposeChildSubprocesses": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:waitForIdle": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:drainAsyncJobDeliveriesForAcp": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getToolByName": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:registerForegroundBashBackgroundRequestHandler": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:hasForegroundBashBackgroundRequestHandler": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:requestForegroundBashBackground": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:isMCPDiscoveryEnabled": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getDiscoverableMCPSearchIndex": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getSelectedMCPToolNames": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:activateDiscoveredMCPTools": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:isToolDiscoveryEnabled": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getDiscoverableToolSearchIndex": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getSelectedDiscoveredToolNames": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:activateDiscoveredTools": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:refreshSshTool": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:refreshBaseSystemPrompt": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:refreshMCPTools": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:refreshGjcSubskillTools": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:buildDisplaySessionContext": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:convertMessagesToLlm": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:prepareSimpleStreamOptions": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getPlanModeState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setPlanModeState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getGoalModeState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setGoalModeState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getWorkflowGateEmitter": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getAskAnswerSource": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setWorkflowGateEmitter": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:markPlanReferenceSent": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setPlanReferencePath": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setClientBridge": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getCheckpointState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setCheckpointState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:sendPlanModeContext": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:sendGoalModeContext": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:resolveRoleModel": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:resolveRoleModelWithThinking": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setSlashCommands": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setMCPPromptCommands": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:queueDeferredMessage": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:queueDeferredMessageForTests": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:purgeQueuedCustomMessages": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:clearQueue": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:popLastQueuedMessage": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:applyCompactionPostAppendForTests": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setActiveModelProfile": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getActiveModelProfile": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getSessionDefaultModelSelector": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:recordResumeDefaultModel": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setModelTemporary": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:cycleRoleModels": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:isFastModeEnabled": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:isFastForProvider": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:isFastForSubagentProvider": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:isFastModeActive": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getAvailableThinkingLevels": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:abortCompaction": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:runIdleCompaction": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:abortBranchSummary": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:abortHandoff": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:prepareContributionPrep": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setResourceSampler": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setRetainedMemorySampler": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:recordBashResult": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:executePython": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:assertEvalExecutionAllowed": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:promptCustomMessage": "internal custom-message plumbing, not a user-facing SDK control seam",
	"agent_session:sendCustomMessage": "internal custom-message plumbing, not a user-facing SDK control seam",
	"agent_session:trackEvalExecution": "internal execution bookkeeping, not a user-facing SDK control seam",
	"agent_session:recordPythonResult": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:abortEval": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:respondAsBackground": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:emitIrcRelayObservation": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:emitSubagentSteerObservation": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:emitSubagentSteerRelayObservation": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:runEphemeralTurn": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:navigateTree": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:hasCopyCandidateAssistantMessage": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getLastVisibleHandoffText": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:hasExtensionHandlers": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:registerBeforeAgentStartContributor": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setSdkPermissionProvider": "internal reverse-provider plumbing, not a user-facing SDK control seam",
};
/** Maps reviewed source seams to registry SDK operation IDs. */
const SEAM_TO_SDK: Readonly<Record<string, string>> = {
	"agent_session:prompt": "turn.prompt",
	"agent_session:steer": "turn.steer",
	"agent_session:followUp": "turn.follow_up",
	"agent_session:abort": "turn.abort",
	"agent_session:newSession": "session.new",
	"agent_session:fork": "session.fork",
	"agent_session:clearContext": "context.clear",
	"agent_session:setSessionName": "session.rename",
	"agent_session:setModel": "model.set",
	"agent_session:cycleModel": "model.cycle",
	"agent_session:setThinkingLevel": "thinking.set",
	"agent_session:cycleThinkingLevel": "thinking.cycle",
	"agent_session:setSteeringMode": "queue.steering_mode.set",
	"agent_session:setFollowUpMode": "queue.follow_up_mode.set",
	"agent_session:setInterruptMode": "queue.interrupt_mode.set",
	"agent_session:compact": "compaction.run",
	"agent_session:setAutoCompactionEnabled": "compaction.auto.set",
	"agent_session:setAutoRetryEnabled": "retry.auto.set",
	"agent_session:abortRetry": "retry.abort",
	"agent_session:retry": "retry.last",
	"agent_session:retryNow": "retry.now",
	"agent_session:setActiveToolsByName": "tools.active.set",
	"agent_session:removeQueuedMessageForEditing": "queue.message.remove",
	"agent_session:moveQueuedMessageForEditing": "queue.message.move",
	"agent_session:executeBash": "bash.execute",
	"agent_session:abortBash": "bash.abort",
	"agent_session:switchSession": "session.switch",
	"agent_session:branch": "session.branch",
	"agent_session:handoff": "session.handoff",
	"agent_session:exportToHtml": "session.export_html",
	"agent_session:getAvailableModels": "models.list/current",
	"agent_session:getActiveToolNames": "tools.list",
	"agent_session:getQueuedMessages": "queue.messages.list",
	"agent_session:getTodoPhases": "todo.list",
	"agent_session:getContextUsage": "context.get",
	"agent_session:getTranscript": "transcript.list",
	"agent_session:getTranscriptBody": "transcript.body",
	"agent_session:getSessionStats": "session.stats",
	"agent_session:getLastAssistantMessage": "session.last_assistant",
	"agent_session:getUserMessagesForBranching": "session.branch_candidates",
	"agent_session:getAsyncJobSnapshot": "runtime.jobs.list",
	"agent_session:fetchUsageReports": "usage.get",
	"agent_session:setTodoPhases": "todo.replace",
	"agent_session:getQueuedMessageEntries": "queue.messages.list",
	"agent_session:getAllToolNames": "tools.list",
	"agent_session:getDiscoverableMCPTools": "tools.list",
	"agent_session:getDiscoverableTools": "tools.list",
	"agent_session:sendUserMessage": "turn.steer",
	"agent_session:reload": "runtime.reload",
	"agent_session:setSdkPermissionMode": "permission_mode.set",
	"agent_session:invokeSkill": "skill.invoke",
	"agent_session:setSdkPlanMode": "mode.plan.set",
	"agent_session:operateGoal": "mode.goal.operate",
	"agent_session:setServiceTier": "service_tier.set",
	"agent_session:setFastMode": "service_tier.set",
	"agent_session:toggleFastMode": "service_tier.set",
	"agent_session:getLastAssistantText": "session.last_assistant",
	"agent_session:formatSessionAsText": "transcript.body",
	"agent_session:formatCompactContext": "context.get",
	"slash_command:goal": "mode.goal.operate",
	"slash_command:model": "model.set",
	"slash_command:effort": "thinking.set",
	"slash_command:fast": "service_tier.set",
	"slash_command:export": "session.export_html",
	"slash_command:dump": "transcript.body",
	"slash_command:session": "session.list",
	"slash_command:jobs": "runtime.jobs.list",
	"slash_command:context": "context.get",
	"slash_command:usage": "usage.get",
	"slash_command:tools": "tools.list",
	"slash_command:login": "auth.login",
	"slash_command:clear": "context.clear",
	"slash_command:new": "session.new",
	"slash_command:compact": "compaction.run",
	"slash_command:resume": "session.resume",
	"slash_command:retry": "retry.last",
	"slash_command:background": "bash.background",
	"slash_command:rename": "session.rename",
	"slash_command:move": "session.cwd.move",
};

/** Genuine action seams awaiting a reviewed registry mapping or exclusion. */
const PENDING_REVIEW: Readonly<Record<string, string>> = {};

function lockedExclusion(sourceId: string): string | undefined {
	return LOCKED_EXCLUSIONS[sourceId];
}


export type SourceKind = "registry" | "controller" | "agent_session" | "slash_command" | "acp" | "locked_exclusion";
export interface SourceSeam {
	sourceId: string;
	sourceFile: string;
	sourceKind: SourceKind;
}
interface InventoryRecord {
	sourceId: string;
	sourceFile: string;
	sourceKind: SourceKind;
	decision: "include" | "exclude";
	rationale?: string;
	sdkId?: string;
	adapterMappings: Operation["adapterDispositions"];
	testIds: string[];
}

function repoPath(file: string): string {
	return path.relative(repoRoot, file).split(path.sep).join("/");
}

/** Controller seam adapter. Semantic IDs never depend on line numbers. */
function collectCaseSeams(source: string, prefix: string): string[] {
	return [...source.matchAll(/case\s+["']([^"']+)["']/g)].map(match => `${prefix}:${match[1]}`);
}

export function scanSlashCommands(sourceText: string): string[] {
	const builtinRegistry = sourceText.slice(sourceText.indexOf("const BUILTIN_SLASH_COMMAND_REGISTRY"));
	return [...builtinRegistry.matchAll(/^\t\tname:\s*["']([^"']+)["']/gm)].map(match => `slash_command:${match[1]}`);
}

function parseSource(sourceText: string): ts.SourceFile {
	return ts.createSourceFile("inventory-seam.ts", sourceText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
	if (!name || ts.isComputedPropertyName(name)) return undefined;
	return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

export function scanAgentSessionMethods(sourceText: string): string[] {
	const sourceFile = parseSource(sourceText);
	const agentSession = sourceFile.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === "AgentSession");
	if (!agentSession || !ts.isClassDeclaration(agentSession)) return [];

	const methods: string[] = [];
	for (const member of agentSession.members) {
		if (ts.isConstructorDeclaration(member)) methods.push("agent_session:constructor");
		else if (ts.isMethodDeclaration(member)) {
			const name = propertyName(member.name);
			if (name) methods.push(`agent_session:${name}`);
		}
	}
	return methods;
}

export function scanAcpMethods(sourceText: string): string[] {
	const methods: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isSwitchStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === "method") {
			for (const clause of node.caseBlock.clauses) {
				if (ts.isCaseClause(clause) && (ts.isStringLiteral(clause.expression) || ts.isNoSubstitutionTemplateLiteral(clause.expression))) {
					methods.push(`acp:${clause.expression.text}`);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parseSource(sourceText));
	return methods;
}


async function scanSeams(): Promise<SourceSeam[]> {
	const root = process.env.GJC_SDK_SEAM_SCAN_ROOT;
	if (root) {
		const files = await fs.readdir(root, { recursive: true });
		const seams: SourceSeam[] = [];
		for (const relative of files) {
			if (typeof relative !== "string" || !relative.endsWith(".ts")) continue;
			const file = path.join(root, relative);
			for (const sourceId of collectCaseSeams(await Bun.file(file).text(), `controller:${relative}`))
				seams.push({ sourceId, sourceFile: file, sourceKind: "controller" });
		}
		return seams;
	}

	const builtinFile = path.join(repoRoot, "packages/coding-agent/src/slash-commands/builtin-registry.ts");
	const sessionFile = path.join(repoRoot, "packages/coding-agent/src/session/agent-session.ts");
	const acpFile = path.join(repoRoot, "packages/coding-agent/src/modes/acp/acp-agent.ts");
	const [builtinSource, sessionSource, acpSource] = await Promise.all([
		Bun.file(builtinFile).text(), Bun.file(sessionFile).text(), Bun.file(acpFile).text(),
	]);
	return [
		...scanSlashCommands(builtinSource).map(sourceId => ({ sourceId, sourceFile: repoPath(builtinFile), sourceKind: "slash_command" as const })),
		...scanAgentSessionMethods(sessionSource).map(sourceId => ({ sourceId, sourceFile: repoPath(sessionFile), sourceKind: "agent_session" as const })),
		...scanAcpMethods(acpSource).map(sourceId => ({ sourceId, sourceFile: repoPath(acpFile), sourceKind: "acp" as const })),
	];
}


function generatedRecords(seams: Awaited<ReturnType<typeof scanSeams>>): InventoryRecord[] {
	const records: InventoryRecord[] = OPERATIONS.map(operation => ({
		sourceId: `registry:${operation.id}`,
		sourceFile: "packages/coding-agent/src/sdk/protocol/operation-registry.ts",
		sourceKind: "registry" as const,
		decision: "include" as const,
		sdkId: operation.sdkId,
		adapterMappings: operation.adapterDispositions,
		testIds: operation.testIds,
	}));
	for (const seam of seams) {
		const sdkId = SEAM_TO_SDK[seam.sourceId];
		const rationale = lockedExclusion(seam.sourceId);
		if (!sdkId && !rationale) continue;
		const operation = sdkId ? OPERATIONS.find(candidate => candidate.sdkId === sdkId) : undefined;
		if (sdkId && !operation) throw new Error(`SEAM_TO_SDK maps ${seam.sourceId} to unknown SDK ID: ${sdkId}`);
		records.push({
			...seam,
			decision: (sdkId ? "include" : "exclude") as "include" | "exclude",
			...(sdkId ? { sdkId } : { rationale }),
			adapterMappings: operation?.adapterDispositions ?? OPERATIONS[0]!.adapterDispositions,
			testIds: operation?.testIds ?? ["packages/coding-agent/test/sdk-operation-inventory.test.ts"],
		});
	}
	return records;
}


function validateRegistry(records: InventoryRecord[]): string[] {
	const errors: string[] = [];
	const ids = new Set<string>();
	const sdkIds = new Set<string>();
	for (const operation of OPERATIONS) {
		if (ids.has(operation.id)) errors.push(`Duplicate operation ID: ${operation.id}`);
		ids.add(operation.id);
		const operationKey = `${operation.kind}:${operation.sdkId}`;
		if (sdkIds.has(operationKey)) errors.push(`Duplicate sdkId in ${operation.kind}: ${operation.sdkId}`);
		sdkIds.add(operationKey);
		if (ADAPTERS.some(adapter => !operation.adapterDispositions[adapter])) errors.push(`${operation.id} is missing adapter dispositions.`);
		if (operation.testIds.length === 0) errors.push(`${operation.id} is missing test IDs.`);
	}
	for (const record of records) {
		if (record.decision === "exclude" && !record.rationale) errors.push(`${record.sourceId} exclusion lacks a locked rationale.`);
		if (ADAPTERS.some(adapter => !record.adapterMappings[adapter])) errors.push(`${record.sourceId} is missing adapter mappings.`);
		if (record.testIds.length === 0) errors.push(`${record.sourceId} is missing test IDs.`);
	}
	return errors;
}

export function pendingReviewErrors(seams: readonly Pick<SourceSeam, "sourceId">[]): string[] {
	return seams
		.filter(seam => !SEAM_TO_SDK[seam.sourceId] && !lockedExclusion(seam.sourceId))
		.map(seam => `Pending review source seam: ${seam.sourceId}. Add it to SEAM_TO_SDK or LOCKED_EXCLUSIONS.`);
}

async function check(records: InventoryRecord[], seams: Awaited<ReturnType<typeof scanSeams>>): Promise<void> {
	const errors = [...validateRegistry(records), ...pendingReviewErrors(seams)];
	for (const sourceId of Object.keys(PENDING_REVIEW)) errors.push(`Pending review source seam: ${sourceId}. ${PENDING_REVIEW[sourceId]}`);
	let checkedIn: InventoryRecord[];
	try {
		checkedIn = await Bun.file(inventoryPath).json();
	} catch (error) {
		throw new Error(`Unable to read ${repoPath(inventoryPath)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const expected = JSON.stringify(records);
	const actual = JSON.stringify(checkedIn);
	if (actual !== expected) {
		const expectedSources = new Set(records.map(record => record.sourceId));
		const actualSources = new Set(checkedIn.map(record => record.sourceId));
		for (const sourceId of expectedSources) if (!actualSources.has(sourceId)) errors.push(`Unreviewed addition: ${sourceId}`);
		for (const sourceId of actualSources) if (!expectedSources.has(sourceId)) errors.push(`Disappeared source: ${sourceId}`);
		errors.push("Generated operation inventory drifts from OPERATIONS.");
	}
	if (errors.length > 0) throw new Error(errors.join("\n"));
}

if (import.meta.main) {
	const seams = await scanSeams();
	const records = generatedRecords(seams);
	const pending = pendingReviewErrors(seams);
	if (process.argv.slice(2).includes("--check")) {
		try {
			await check(records, seams);
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		}
	} else {
		await Bun.write(inventoryPath, `${JSON.stringify(records, null, "\t")}\n`);
		const included = records.filter(record => record.decision === "include").length;
		const excluded = records.filter(record => record.decision === "exclude").length;
		process.stderr.write(`Generated ${repoPath(inventoryPath)} (${records.length} records): include=${included}, exclude=${excluded}, pending=${pending.length}.\n`);
	}
}
