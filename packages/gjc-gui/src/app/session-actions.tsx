import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type ConfirmState, cancelConfirm, confirmSessionAction, openConfirm } from "./session-actions-logic";
import type { ThreadView } from "./transcript";

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
				<button
					className="neutral-action session-actions__button"
					type="button"
					disabled={disabled}
					onClick={() => onFork(thread.id)}
				>
					Fork
				</button>
				<button
					className="neutral-action session-actions__button"
					type="button"
					disabled={disabled || !onMove}
					onClick={() => onMove?.(thread.id)}
				>
					Move
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
			{confirm ? (
				<ConfirmDialog
					state={confirm}
					onCancel={() => setConfirm(cancelConfirm())}
					onConfirm={() => setConfirm(confirmSessionAction(confirm, { onArchive, onDelete }))}
				/>
			) : null}
		</div>
	);
}

export function ConfirmDialog({
	state,
	onCancel,
	onConfirm,
}: {
	state: Exclude<ConfirmState, null>;
	onCancel(): void;
	onConfirm(): void;
}) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const confirmRef = useRef<HTMLButtonElement>(null);
	const action = state.kind === "delete" ? "Delete" : "Archive";

	useEffect(() => {
		cancelRef.current?.focus();
	}, []);

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
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
				<div className="session-confirm__buttons">
					<button className="neutral-action" type="button" ref={cancelRef} onClick={onCancel}>
						Cancel
					</button>
					<button
						className="neutral-action session-actions__button--danger"
						type="button"
						ref={confirmRef}
						onClick={onConfirm}
					>
						Confirm {action}
					</button>
				</div>
			</div>
		</div>
	);
}
