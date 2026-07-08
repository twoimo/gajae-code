import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ThreadView } from "./transcript";
import {
	cancelConfirm,
	confirmSessionAction,
	openConfirm,
	type ConfirmState,
} from "./session-actions-logic";

export type PromptState = { title: string; message: string; value: string; confirmLabel: string; onConfirm(value: string): void } | null;

type SessionActionsProps = {
	thread: ThreadView;
	onFork(id: string): void;
	onArchive(id: string): void;
	onDelete(id: string): void;
	onMove?(id: string): void;
	disabled?: boolean;
};

export function SessionActions({ thread, onFork, onArchive, onDelete, onMove, disabled = false }: SessionActionsProps) {
	const [confirm, setConfirm] = useState<ConfirmState>(null);

	return (
		<div className="session-actions" aria-label={`Session actions for ${thread.title}`}>
			<div className="session-actions__row">
				<button className="neutral-action session-actions__button" type="button" disabled={disabled} onClick={() => onFork(thread.id)}>
					Fork
				</button>
				<button
					className="neutral-action session-actions__button session-actions__button--danger"
					type="button"
					disabled={disabled || thread.status === "archived"}
					onClick={() => setConfirm(openConfirm("archive", thread))}
				>
					Archive
				</button>
				<button
					className="neutral-action session-actions__button session-actions__button--danger"
					type="button"
					disabled={disabled}
					onClick={() => setConfirm(openConfirm("delete", thread))}
				>
					Delete
				</button>
			</div>
			<details className="session-actions__deferred">
				<summary>More: move</summary>
				<button type="button" disabled={disabled || !onMove} onClick={() => onMove?.(thread.id)}>Move</button>
			</details>
			{confirm ? (
				<ConfirmDialog
					state={confirm}
					onCancel={() => setConfirm(cancelConfirm())}
					onConfirm={() =>
						setConfirm(
							confirmSessionAction(confirm, {
								onArchive,
								onDelete,
							}),
						)
					}
				/>
			) : null}
		</div>
	);
}

export function ConfirmDialog({ state, onCancel, onConfirm, confirmDisabled = false, children }: { state: Exclude<ConfirmState, null>; onCancel(): void; onConfirm(): void; confirmDisabled?: boolean; children?: ReactNode }) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const confirmRef = useRef<HTMLButtonElement>(null);
	const action = state.kind === "delete" ? "Delete" : state.kind === "move" ? "Move" : "Archive";

	useEffect(() => {
		cancelRef.current?.focus();
	}, []);

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
		}
		if (event.key !== "Tab") return;
		const first = cancelRef.current;
		const last = confirmRef.current;
		if (!first || !last) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		}
		if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	return (
		<div className="session-confirm__backdrop" role="presentation">
			<div
				className="session-confirm"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="session-confirm-title"
				aria-describedby="session-confirm-copy"
				onKeyDown={handleKeyDown}
			>
				<h2 id="session-confirm-title">{action} session?</h2>
				<p id="session-confirm-copy">
					{action} <strong>{state.title}</strong> ({state.threadId})?
				</p>
				{children}
				<div className="session-confirm__buttons">
					<button className="neutral-action" type="button" ref={cancelRef} onClick={onCancel}>
						Cancel
					</button>
					<button className="neutral-action session-actions__button--danger" type="button" ref={confirmRef} disabled={confirmDisabled} onClick={onConfirm}>
						Confirm {action}
					</button>
				</div>
			</div>
		</div>
	);
}

export function PromptDialog({ state, onCancel, onConfirm }: { state: Exclude<PromptState, null>; onCancel(): void; onConfirm(value: string): void }) {
	const [value, setValue] = useState(state.value);
	const inputRef = useRef<HTMLInputElement>(null);
	const confirmRef = useRef<HTMLButtonElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
		}
		if (event.key === "Enter") {
			event.preventDefault();
			onConfirm(value);
		}
		if (event.key !== "Tab") return;
		const first = inputRef.current;
		const last = confirmRef.current;
		if (!first || !last) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		}
		if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	return (
		<div className="session-confirm__backdrop" role="presentation">
			<div className="session-confirm" role="dialog" aria-modal="true" aria-labelledby="session-prompt-title" aria-describedby="session-prompt-copy" onKeyDown={handleKeyDown}>
				<h2 id="session-prompt-title">{state.title}</h2>
				<p id="session-prompt-copy">{state.message}</p>
				<input className="session-prompt__input" ref={inputRef} value={value} maxLength={200} onChange={event => setValue(event.target.value)} aria-label={state.title} />
				<div className="session-confirm__buttons">
					<button className="neutral-action" type="button" ref={cancelRef} onClick={onCancel}>Cancel</button>
					<button className="neutral-action" type="button" ref={confirmRef} onClick={() => onConfirm(value)}>{state.confirmLabel}</button>
				</div>
			</div>
		</div>
	);
}
