import { type FormEvent, useEffect, useMemo, useState } from "react";
import { DEFERRED_MODEL_SURFACES, parseModelLabel, validateModelInput } from "./model-panel-logic";

type ModelPanelProps = {
	currentModel: string;
	disabled: boolean;
	onApply(provider: string, modelId: string): void;
};

export function ModelPanel({ currentModel, disabled, onApply }: ModelPanelProps) {
	const parsed = useMemo(() => parseModelLabel(currentModel), [currentModel]);
	const [provider, setProvider] = useState(parsed.provider ?? "");
	const [modelId, setModelId] = useState(parsed.modelId ?? "");
	const validation = validateModelInput(provider, modelId);
	const canApply = !disabled && validation.ok;

	useEffect(() => {
		setProvider(parsed.provider ?? "");
		setModelId(parsed.modelId ?? "");
	}, [parsed.provider, parsed.modelId]);

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!canApply) return;
		onApply(provider.trim(), modelId.trim());
	}

	return (
		<section className="model-panel" aria-label="Model and settings">
			<header>
				<p className="eyebrow">Model</p>
				<strong>{currentModel || "model pending"}</strong>
			</header>
			<form className="model-panel__form" onSubmit={submit} aria-describedby="model-panel-hint">
				<label htmlFor="model-provider-input">Provider</label>
				<input
					id="model-provider-input"
					type="text"
					value={provider}
					onChange={event => setProvider(event.target.value)}
					disabled={disabled}
					autoComplete="off"
					placeholder="anthropic"
				/>
				<label htmlFor="model-id-input">Model ID</label>
				<input
					id="model-id-input"
					type="text"
					value={modelId}
					onChange={event => setModelId(event.target.value)}
					disabled={disabled}
					autoComplete="off"
					placeholder="claude-sonnet-4"
				/>
				<p id="model-panel-hint" className={`model-panel__hint ${validation.ok ? "" : "model-panel__hint--error"}`}>
					{disabled
						? "Connect before setting the model for the selected chat."
						: (validation.error ?? "Set the model for the selected chat.")}
				</p>
				<button className="primary-action" type="submit" disabled={!canApply}>
					Apply
				</button>
			</form>
			<details className="model-panel__deferred" open>
				<summary>More model &amp; settings surfaces (soon)</summary>
				<ul>
					{DEFERRED_MODEL_SURFACES.map(surface => (
						<li key={surface.name}>
							<button type="button" disabled>
								<strong>{surface.name}</strong>
								<span>{deferredModelCopy(surface.name)}</span>
								<em>Coming later.</em>
							</button>
						</li>
					))}
				</ul>
			</details>
		</section>
	);
}

function deferredModelCopy(name: string): string {
	switch (name) {
		case "model-catalog":
			return "Browse available models.";
		case "thinking":
			return "Choose how much reasoning to use.";
		case "fast":
			return "Toggle faster responses.";
		case "settings":
			return "Adjust advanced model settings.";
		default:
			return "Additional controls.";
	}
}
