export type GjcTeamPhase = "starting" | "running" | "awaiting_integration" | "complete" | "failed" | "cancelled";
export type GjcTeamTaskStatus = "pending" | "blocked" | "in_progress" | "completed" | "failed";
export type GjcWorkerStatusState = "idle" | "working" | "blocked" | "done" | "failed" | "draining" | "unknown";
export type GjcTeamWorkerLifecycleState =
	| "starting"
	| "ready"
	| "working"
	| "draining"
	| "stopped"
	| "failed"
	| "unknown";
export type GjcTeamNotificationDeliveryState =
	| "pending"
	| "sent"
	| "queued"
	| "deferred"
	| "failed"
	| "delivered"
	| "acknowledged";

export interface GjcTeamTaskClaim {
	owner: string;
	token: string;
	leased_until: string;
}

export interface GjcTeamTaskCompletionEvidenceItem {
	kind: "command" | "inspection" | "artifact";
	status: "passed" | "failed" | "not_run" | "verified" | "rejected";
	summary: string;
	command?: string;
	artifact?: string;
	location?: string;
	output?: string;
}

export interface GjcTeamTaskCompletionEvidence {
	summary: string;
	items: GjcTeamTaskCompletionEvidenceItem[];
	files?: string[];
	notes?: string;
	recorded_by: string;
	recorded_at: string;
}

export interface GjcTeamTask {
	id: string;
	subject: string;
	description: string;
	title: string;
	objective: string;
	status: GjcTeamTaskStatus;
	assignee?: string;
	owner?: string;
	result?: string;
	completion_evidence?: GjcTeamTaskCompletionEvidence;
	error?: string;
	blocked_by?: string[];
	depends_on?: string[];
	lane?: string;
	required_role?: string;
	allowed_roles?: string[];
	version: number;
	claim?: GjcTeamTaskClaim;
	created_at: string;
	updated_at: string;
	completed_at?: string;
}

export interface GjcTeamWorker {
	id: string;
	name: string;
	index: number;
	agent_type: string;
	role: string;
	status: "starting" | "idle" | "busy" | "stopped";
	last_heartbeat: string;
	assigned_tasks: string[];
}

export interface GjcTeamWorkerLifecycle {
	worker: string;
	lifecycle_state: GjcTeamWorkerLifecycleState;
	worker_status_state: GjcWorkerStatusState;
	pane_id?: string;
	pid?: number;
	started_at?: string;
	updated_at: string;
	stopped_at?: string;
	stop_reason?: string;
}

export interface GjcTeamNotification {
	id: string;
	team_name: string;
	recipient: string;
	source: { type: "message" | "task" | "worker" | "event"; id: string };
	delivery_state: GjcTeamNotificationDeliveryState;
	replay_count: number;
	pane_attempt_result?: "sent" | "queued" | "deferred" | "failed";
	pane_attempt_reason?: string;
}

export interface GjcTeamNotificationSummary {
	total: number;
	replay_eligible: number;
	by_state: Record<GjcTeamNotificationDeliveryState, number>;
}

export function taskReceiptFields(teamName: string, task: GjcTeamTask): Record<string, unknown> {
	return {
		team_name: teamName,
		task_id: task.id,
		status: task.status,
		owner: task.owner,
		worker_id: task.claim?.owner ?? task.owner ?? task.assignee,
	};
}

export function notificationReceiptFields(notification: GjcTeamNotification): Record<string, unknown> {
	return {
		team_name: notification.team_name,
		notification_id: notification.id,
		recipient: notification.recipient,
		source_type: notification.source.type,
		source_id: notification.source.id,
		delivery_state: notification.delivery_state,
		pane_attempt_result: notification.pane_attempt_result,
		pane_attempt_reason: notification.pane_attempt_reason,
		replay_count: notification.replay_count,
	};
}

export function isReplayEligibleNotification(state: GjcTeamNotificationDeliveryState): boolean {
	return state === "pending" || state === "queued" || state === "deferred" || state === "failed";
}

export function summarizeNotifications(notifications: GjcTeamNotification[]): GjcTeamNotificationSummary {
	const by_state: Record<GjcTeamNotificationDeliveryState, number> = {
		pending: 0,
		sent: 0,
		queued: 0,
		deferred: 0,
		failed: 0,
		delivered: 0,
		acknowledged: 0,
	};
	let replay_eligible = 0;
	for (const notification of notifications) {
		by_state[notification.delivery_state] += 1;
		if (isReplayEligibleNotification(notification.delivery_state)) replay_eligible += 1;
	}
	return { total: notifications.length, replay_eligible, by_state };
}

export function lifecycleStateForWorkerStatus(status: GjcWorkerStatusState): GjcTeamWorkerLifecycleState {
	switch (status) {
		case "working":
			return "working";
		case "draining":
			return "draining";
		case "failed":
			return "failed";
		case "unknown":
			return "unknown";
		case "idle":
		case "blocked":
		case "done":
			return "ready";
	}
}

export function isTaskCompletionVerified(task: GjcTeamTask): boolean {
	if (task.status !== "completed" || !task.completion_evidence) return false;
	const evidence = task.completion_evidence;
	return Boolean(
		evidence.recorded_by.trim() &&
			evidence.recorded_at.trim() &&
			evidence.items.some(
				item =>
					(item.kind === "command" && item.status === "passed") ||
					((item.kind === "inspection" || item.kind === "artifact") && item.status === "verified"),
			),
	);
}

export function taskDependencyReadiness(task: GjcTeamTask, tasks: GjcTeamTask[]): string | null {
	if (task.blocked_by?.length) return `task_blocked:${task.id}:${task.blocked_by.join(",")}`;
	for (const dependencyId of task.depends_on ?? []) {
		const dependency = tasks.find(candidate => candidate.id === dependencyId);
		if (!dependency || !isTaskCompletionVerified(dependency))
			return `task_dependency_incomplete:${task.id}:${dependencyId}`;
	}
	return null;
}

export function taskClaimEligibilityReason(
	task: GjcTeamTask,
	worker: GjcTeamWorker,
	tasks: GjcTeamTask[],
): string | null {
	if (task.status !== "pending") return `task_not_pending:${task.id}`;
	if (task.owner && task.owner !== worker.id) return `task_owner_mismatch:${task.id}:${task.owner}`;
	if (task.assignee && task.assignee !== worker.id) return `task_assignee_mismatch:${task.id}:${task.assignee}`;
	const roles = new Set([worker.role, worker.agent_type].map(value => value.trim()).filter(Boolean));
	if (task.required_role && !roles.has(task.required_role))
		return `task_role_mismatch:${task.id}:${task.required_role}`;
	if (task.allowed_roles?.length && !task.allowed_roles.some(role => roles.has(role)))
		return `task_role_mismatch:${task.id}:${task.allowed_roles.join(",")}`;
	return taskDependencyReadiness(task, tasks);
}

export function isLeaseActive(claim: GjcTeamTaskClaim | undefined, nowIso: string): boolean {
	if (!claim) return false;
	const lease = Date.parse(claim.leased_until);
	const now = Date.parse(nowIso);
	return Number.isFinite(lease) && Number.isFinite(now) && lease > now;
}

export function validateTaskTransition(input: {
	task: GjcTeamTask;
	status: GjcTeamTaskStatus;
	claimToken?: string;
	workerId?: string;
}): string | null {
	const { task, status, claimToken, workerId } = input;
	if (status === "pending") return `invalid_task_transition:${task.id}:pending_requires_release`;
	if (task.status === "completed" || task.status === "failed") return `task_terminal:${task.id}`;
	if (!task.claim || !claimToken) return `claim_token_required:${task.id}`;
	if (task.claim.token !== claimToken) return `claim_token_mismatch:${task.id}`;
	if (workerId && task.claim.owner !== workerId) return `claim_owner_mismatch:${task.id}`;
	return null;
}

export function deriveTeamPhase(input: {
	storedPhase: GjcTeamPhase;
	tasks: GjcTeamTask[];
	hasPendingIntegration: boolean;
}): GjcTeamPhase {
	if (input.storedPhase !== "running" || input.tasks.length === 0 || !input.tasks.every(isTaskCompletionVerified))
		return input.storedPhase;
	return input.hasPendingIntegration ? "awaiting_integration" : input.storedPhase;
}
