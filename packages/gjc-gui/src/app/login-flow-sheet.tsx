import { type FormEvent, useEffect, useRef, useState } from "react";
import type { LoginFlowState } from "./login-flow-logic";


export type LoginFlowClient = {
	start(providerId: string): Promise<{ flowId: string; state: LoginFlowState; authUrl?: string; instructions?: string }>;
	poll(flowId: string): Promise<{ state: LoginFlowState; promptMessage?: string }>;
	complete(flowId: string, redirectUrl: string): Promise<{ state: LoginFlowState }>;
	cancel(flowId: string): Promise<{ state: LoginFlowState }>;
};

export function LoginFlowSheet({
	providerId,
	client,
	onClose,
	openExternal,
}: {
	providerId: string;
	client: LoginFlowClient;
	onClose(): void;
	openExternal?(url: string): void;
}) {
	const [flowId, setFlowId] = useState("");
	// Per-effect-generation flow context: each start() gets its own cancel-once
	// guard so a stale generation (StrictMode replay, prop change) cannot mark
	// the live flow as already cancelled.
	const flowContextRef = useRef<{ flowId: string; cancelled: boolean } | null>(null);
	const [state, setState] = useState<LoginFlowState>("idle");
	const [authUrl, setAuthUrl] = useState("");
	const [instructions, setInstructions] = useState("");
	const [promptMessage, setPromptMessage] = useState("");
	const [redirectUrl, setRedirectUrl] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let cancelled = false;
		const context = { flowId: "", cancelled: false };
		flowContextRef.current = context;
		const cancelOnce = () => {
			if (context.cancelled || !context.flowId) return;
			context.cancelled = true;
			void client.cancel(context.flowId).catch(() => undefined);
		};
		client.start(providerId).then(
			result => {
				context.flowId = result.flowId;
				if (cancelled) {
					cancelOnce();
					return;
				}
				setFlowId(result.flowId);
				setState(result.state);
				setAuthUrl(result.authUrl ?? "");
				setInstructions(result.instructions ?? "");
			},
			caught => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
			},
		);
		return () => {
			cancelled = true;
			cancelOnce();
		};
	}, [client, providerId]);

	useEffect(() => {
		if (!flowId || !["pending-browser", "needs-input"].includes(state)) return;
		let cancelled = false;
		const timer = window.setInterval(() => {
			client.poll(flowId).then(result => {
				if (cancelled) return;
				setState(result.state);
				setPromptMessage(result.promptMessage ?? "");
			}, caught => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
			});
		}, 1500);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [client, flowId, state]);

	async function complete(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const oneShotRedirectUrl = redirectUrl.trim();
		if (!flowId || !oneShotRedirectUrl || busy) return;
		setBusy(true);
		setError("");
		setRedirectUrl("");
		try {
			const result = await client.complete(flowId, oneShotRedirectUrl);
			setState(result.state);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(false);
		}
	}

	async function cancel() {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			if (flowId) {
				const context = flowContextRef.current;
				if (context && context.flowId === flowId) context.cancelled = true;
				const result = await client.cancel(flowId);
				setState(result.state);
			}
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={`Login to ${providerId}`}>
			<section className="login-flow-sheet">
				<header><strong>Provider login</strong><button type="button" onClick={() => void cancel()}>Close</button></header>
				<p>Provider: {providerId}</p>
				<p>State: {state}</p>
				{error ? <p className="model-panel__hint model-panel__hint--error">{error}</p> : null}
				{state === "unsupported" ? <p>This provider does not support browser login. Use environment-variable configuration instead.</p> : null}
				{instructions ? <p>{instructions}</p> : null}
				{promptMessage ? <p>{promptMessage}</p> : null}
				{authUrl ? (
					<button
						type="button"
						className="neutral-action"
						onClick={() => (openExternal ?? (url => window.open(url, "_blank", "noopener,noreferrer")))(authUrl)}
					>
						Open browser sign-in
					</button>
				) : null}
				<form onSubmit={complete}>
					<label>
						One-time redirect secret
						<input
							type="password"
							value={redirectUrl}
							onInput={event => setRedirectUrl(event.currentTarget.value)}
							placeholder="Paste once; not stored or displayed"
							autoComplete="off"
						/>
					</label>
					<button className="primary-action" type="submit" disabled={busy || !flowId || !redirectUrl.trim()}>
						Complete login
					</button>
				</form>
				<button type="button" className="neutral-action" onClick={() => void cancel()} disabled={busy}>
					Cancel login
				</button>
			</section>
		</div>
	);
}
