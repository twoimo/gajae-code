export type ExecStateStatus = "loading" | "empty" | "populated" | "error";

export type ExecStateCard = {
	key: string;
	title: string;
	status: ExecStateStatus;
	lines: string[];
	error?: string;
};

export const GJC_JOBS_CHANGED_METHOD = "gjc/jobs/changed" as const;
export const EXEC_STATE_RAW_REFRESH_EVENTS = new Set(["todo_reminder", "todo_auto_clear"]);

export type ExecStateRefreshCause = "initial" | "turn-boundary" | "jobs-changed" | "todos-changed";


export function cardFromRows(key: string, title: string, rows: unknown[] | undefined, empty = "No live items"): ExecStateCard {
	if (!rows) return { key, title, status: "loading", lines: ["Loading…"] };
	if (rows.length === 0) return { key, title, status: "empty", lines: [empty] };
	return { key, title, status: "populated", lines: rows.map(rowLine) };
}

export function monitorsCardFromResult(result: Record<string, unknown>): ExecStateCard {
	const monitors = Array.isArray(result.monitors) ? result.monitors.map(row => ({ row, kind: "monitor" })) : [];
	const crons = Array.isArray(result.crons) ? result.crons.map(row => ({ row, kind: "cron" })) : [];
	return cardFromRows("monitors", "Monitors", [...monitors, ...crons]);
}

export function mergeExecCards(current: ExecStateCard[], next: ExecStateCard[]): ExecStateCard[] {
	if (current.length === 0) return next;
	return next.map(card => {
		const existing = current.find(candidate => candidate.key === card.key);
		return card.status === "loading" && existing && existing.status !== "loading" ? existing : card;
	});
}

export function shouldRefreshOnTurnBoundary(previousTurnId: string | undefined, nextTurnId: string | undefined): boolean {
	return previousTurnId !== nextTurnId;
}

export function notificationRefreshCause(notification: { method: string; params?: unknown }): ExecStateRefreshCause | undefined {
	if (notification.method === GJC_JOBS_CHANGED_METHOD) return "jobs-changed";
	const params = notification.params && typeof notification.params === "object" ? notification.params as { eventType?: unknown } : undefined;
	if (notification.method === "gjc/event" && typeof params?.eventType === "string" && EXEC_STATE_RAW_REFRESH_EVENTS.has(params.eventType)) return "todos-changed";
	return undefined;
}

export function errorCard(key: string, title: string, error: unknown): ExecStateCard {
	return { key, title, status: "error", lines: [], error: error instanceof Error ? error.message : String(error) };
}

export function rowLine(row: unknown): string {
	if (!row || typeof row !== "object") return String(row ?? "");
	const wrapped = row as { row?: unknown; kind?: unknown };
	if (wrapped.kind === "monitor" && wrapped.row && typeof wrapped.row === "object") return monitorRowLine(wrapped.row as Record<string, unknown>);
	if (wrapped.kind === "cron" && wrapped.row && typeof wrapped.row === "object") return cronRowLine(wrapped.row as Record<string, unknown>);
	const r = row as Record<string, unknown>;
	const label = firstString(r.content, r.description, r.summary, r.modelId, r.id) ?? "item";
	const status = firstString(r.status, r.freshness);
	const nums = ["input", "output", "cacheRead", "cacheWrite", "cost", "tokensBefore"]
		.filter(key => typeof r[key] === "number")
		.map(key => `${key}:${r[key]}`)
		.join(" ");
	return [status ? `● ${status}` : "●", label, nums].filter(Boolean).join(" — ");
}

function monitorRowLine(row: Record<string, unknown>): string {
	const line = genericRowLine(row);
	const outputTail = firstString(row.outputTail);
	return outputTail ? `${line} — output: ${outputTail}` : line;
}

function cronRowLine(row: Record<string, unknown>): string {
	const label = firstString(row.humanSchedule, row.cronExpression, row.prompt, row.id) ?? "cron";
	const nextFireAt = firstString(row.nextFireAt);
	return ["● schedule", label, nextFireAt ? `next:${nextFireAt}` : undefined].filter(Boolean).join(" — ");
}

function genericRowLine(r: Record<string, unknown>): string {
	const label = firstString(r.content, r.description, r.summary, r.modelId, r.id) ?? "item";
	const status = firstString(r.status, r.freshness);
	const nums = ["input", "output", "cacheRead", "cacheWrite", "cost", "tokensBefore"]
		.filter(key => typeof r[key] === "number")
		.map(key => `${key}:${r[key]}`)
		.join(" ");
	return [status ? `● ${status}` : "●", label, nums].filter(Boolean).join(" — ");
}

export function firstString(...values: unknown[]): string | undefined {
	return values.find((value): value is string => typeof value === "string" && value.length > 0);
}
