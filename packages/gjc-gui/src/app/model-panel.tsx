import { useEffect, useMemo, useState, type FormEvent } from "react";
import { LoginFlowSheet, type LoginFlowClient } from "./login-flow-sheet";
import { GJC_MODEL_ASSIGNMENT_TARGET_IDS, modelAssignPayload, parseModelLabel, providerAddPayload, providerAuthGuidance, validateModelInput, type ModelAssignInput, type ProviderAddPayload } from "./model-panel-logic";

type CatalogModel = { provider: string; modelId: string; name?: string | null; contextWindow?: number | null; reasoning?: boolean | null; available: boolean };
type SettingDescriptor = { key: string; type: string; label?: string | null; description?: string | null; enum?: string[] | null; default?: unknown };
type ProviderAuth = { id: string; name?: string | null; authKind: "oauth" | "api-key-env" | "none"; authenticated: boolean; envVar?: string | null };

type ModelPanelProps = {
	currentModel: string;
	activeThreadId?: string;
	disabled: boolean;
	onApply(provider: string, modelId: string): void | Promise<void>;
	loadCatalog?: () => Promise<{ models: CatalogModel[]; activeProvider?: string | null; activeModelId?: string | null }>;
	loadThinking?: () => Promise<{ level: string; levels: string[] }>;
	onSetThinking?: (level: string) => Promise<void>;
	loadFast?: () => Promise<{ enabled: boolean; affectedRoles?: string[] | null }>;
	onSetFast?: (enabled: boolean) => Promise<void>;
	loadSettings?: () => Promise<{ schema: SettingDescriptor[]; values: Record<string, unknown> }>;
	onUpdateSetting?: (key: string, value: unknown) => Promise<Record<string, unknown> | void>;
	loadProviders?: () => Promise<{ providers: ProviderAuth[] }>;
	onLogoutProvider?: (providerId: string) => Promise<void>;
	onProviderAdd?: (payload: ProviderAddPayload) => Promise<{ ok: true; providerId: string; models: string[] }>;
	loginClient?: LoginFlowClient;
	onModelAssign?: (payload: ModelAssignInput) => Promise<void>;
};

export function ModelPanel({ currentModel, activeThreadId, disabled, onApply, loadCatalog, loadThinking, onSetThinking, loadFast, onSetFast, loadSettings, onUpdateSetting, loadProviders, onLogoutProvider, onProviderAdd, loginClient, onModelAssign }: ModelPanelProps) {
	const parsed = useMemo(() => parseModelLabel(currentModel), [currentModel]);
	const [provider, setProvider] = useState(parsed.provider ?? "");
	const [modelId, setModelId] = useState(parsed.modelId ?? "");
	const [catalog, setCatalog] = useState<CatalogModel[]>([]);
	const [thinking, setThinking] = useState<{ level: string; levels: string[] } | null>(null);
	const [fast, setFast] = useState<{ enabled: boolean; affectedRoles?: string[] | null } | null>(null);
	const [settings, setSettings] = useState<{ schema: SettingDescriptor[]; values: Record<string, unknown> } | null>(null);
	const [providers, setProviders] = useState<ProviderAuth[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [preset, setPreset] = useState("");
	const [newProviderId, setNewProviderId] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKeyEnv, setApiKeyEnv] = useState("");
	const [models, setModels] = useState("");
	const [assignRole, setAssignRole] = useState("default");
	const [assignThinking, setAssignThinking] = useState("");
	const [loginProvider, setLoginProvider] = useState<string | null>(null);
	const validation = validateModelInput(provider, modelId);
	const canApply = !disabled && validation.ok;

	useEffect(() => {
		setProvider(parsed.provider ?? "");
		setModelId(parsed.modelId ?? "");
	}, [parsed.provider, parsed.modelId]);

	useEffect(() => {
		let cancelled = false;
		async function refresh() {
			if (disabled) return;
			setError(null);
			try {
				const [catalogResult, thinkingResult, fastResult, settingsResult, providerResult] = await Promise.all([loadCatalog?.(), loadThinking?.(), loadFast?.(), loadSettings?.(), loadProviders?.()]);
				if (cancelled) return;
				if (catalogResult) {
					setCatalog(catalogResult.models);
					if (catalogResult.activeProvider) setProvider(catalogResult.activeProvider);
					if (catalogResult.activeModelId) setModelId(catalogResult.activeModelId);
				}
				if (thinkingResult) setThinking(thinkingResult);
				if (fastResult) setFast(fastResult);
				if (settingsResult) setSettings(settingsResult);
				if (providerResult) setProviders(providerResult.providers);
			} catch (caught) {
				if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
			}
		}
		void refresh();
		return () => { cancelled = true; };
	}, [disabled, loadCatalog, loadThinking, loadFast, loadSettings, loadProviders]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!canApply) return;
		await onApply(provider.trim(), modelId.trim());
	}

	async function addProvider(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const result = providerAddPayload({ preset, providerId: newProviderId, baseUrl, apiKeyEnv, models });
		if (!result.ok) { setError(result.error); return; }
		try {
			setError(null);
			const added = await onProviderAdd?.(result.payload);
			if (added) setProviders(current => [...current.filter(item => item.id !== added.providerId), { id: added.providerId, authKind: "api-key-env", authenticated: false, envVar: "apiKeyEnv" }]);
			setNewProviderId(""); setBaseUrl(""); setApiKeyEnv(""); setModels(""); setPreset("");
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	}

	async function assignModel(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const payload = modelAssignPayload({ threadId: activeThreadId ?? "", role: assignRole, provider, modelId, thinkingLevel: assignThinking });
		if (!payload.threadId || !payload.role || !payload.provider || !payload.modelId) return;
		await onModelAssign?.(payload);
	}

	async function updateSetting(setting: SettingDescriptor, value: unknown) {
		try {
			setError(null);
			const values = await onUpdateSetting?.(setting.key, value);
			setSettings(current => current ? { ...current, values: values ?? { ...current.values, [setting.key]: value } } : current);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	}

	async function logoutProvider(providerId: string) {
		if (!onLogoutProvider || !window.confirm(`Sign out of ${providerId}?`)) return;
		try {
			setError(null);
			await onLogoutProvider(providerId);
			setProviders(current => current.map(item => item.id === providerId ? { ...item, authenticated: false } : item));
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	}

	const grouped = catalog.reduce<Record<string, CatalogModel[]>>((acc, model) => {
		(acc[model.provider] ??= []).push(model);
		return acc;
	}, {});
	const selectedValue = provider && modelId ? `${provider}/${modelId}` : "";
	const roles = GJC_MODEL_ASSIGNMENT_TARGET_IDS;

	return (
		<section className="model-panel" aria-label="Model and settings">
			<header><p className="eyebrow">Model</p><strong>{currentModel || selectedValue || "model pending"}</strong></header>
			{error ? <p className="model-panel__hint model-panel__hint--error">{error}</p> : null}
			{catalog.length > 0 ? <label>Catalog<select value={selectedValue} disabled={disabled} onChange={event => { const next = parseModelLabel(event.target.value); setProvider(next.provider ?? ""); setModelId(next.modelId ?? ""); }}>{Object.entries(grouped).map(([groupProvider, groupModels]) => <optgroup label={groupProvider} key={groupProvider}>{groupModels.map(model => <option key={`${model.provider}/${model.modelId}`} value={`${model.provider}/${model.modelId}`} disabled={!model.available}>{model.name ?? model.modelId}{model.reasoning ? " · thinking" : ""}{model.available ? "" : " · unavailable"}</option>)}</optgroup>)}</select></label> : <p className="empty-inline">No catalog entries loaded.</p>}
			<form className="model-panel__form" onSubmit={submit} aria-describedby="model-panel-hint">
				<label htmlFor="model-provider-input">Provider</label><input id="model-provider-input" type="text" value={provider} onChange={event => setProvider(event.target.value)} disabled={disabled} autoComplete="off" placeholder="anthropic" />
				<label htmlFor="model-id-input">Model ID</label><input id="model-id-input" type="text" value={modelId} onChange={event => setModelId(event.target.value)} disabled={disabled} autoComplete="off" placeholder="claude-sonnet-4" />
				<p id="model-panel-hint" className={`model-panel__hint ${validation.ok ? "" : "model-panel__hint--error"}`}>{disabled ? "Connect and select a thread before setting a model." : validation.error ?? "Catalog is token-safe: provider and model metadata only."}</p>
				<button className="primary-action" type="submit" disabled={!canApply}>Apply</button>
			</form>
			<form className="model-panel__form" onSubmit={assignModel}>
				<strong>Assign role model</strong>
				<label>Role<select value={assignRole} onChange={event => setAssignRole(event.target.value)}>{roles.map(role => <option key={role} value={role}>{role}</option>)}</select></label>
				<label>Thinking level<input value={assignThinking} onChange={event => setAssignThinking(event.target.value)} placeholder="optional" /></label>
				<button type="submit" className="neutral-action" disabled={disabled || !onModelAssign || !validation.ok}>Assign role</button>
			</form>
			{thinking ? <label>Thinking<select value={thinking.level} disabled={disabled || !onSetThinking} onChange={event => { void onSetThinking?.(event.target.value).then(() => setThinking(current => current ? { ...current, level: event.target.value } : current)); }}>{thinking.levels.map(level => <option key={level} value={level}>{level}</option>)}</select></label> : null}
			{fast && onSetFast ? <label className="model-panel__toggle"><input type="checkbox" checked={fast.enabled} disabled={disabled} onChange={event => { const enabled = event.target.checked; void onSetFast(enabled).then(() => setFast(current => current ? { ...current, enabled } : current)); }} />Fast mode{fast.affectedRoles?.length ? ` (affected roles: ${fast.affectedRoles.join(", ")})` : ""}</label> : null}
			{settings ? <fieldset className="model-panel__settings"><legend>Safe settings</legend>{settings.schema.map(setting => <label key={setting.key}><span>{setting.label ?? setting.key}</span>{setting.type === "boolean" ? <input type="checkbox" checked={settings.values[setting.key] === true} onChange={event => void updateSetting(setting, event.target.checked)} /> : setting.enum?.length ? <select value={String(settings.values[setting.key] ?? setting.default ?? "")} onChange={event => void updateSetting(setting, event.target.value)}>{setting.enum.map(value => <option key={value} value={value}>{value}</option>)}</select> : <input value={String(settings.values[setting.key] ?? "")} onChange={event => void updateSetting(setting, event.target.value)} />}{setting.description ? <em>{setting.description}</em> : null}</label>)}</fieldset> : null}
			<fieldset className="model-panel__settings"><legend>Add provider</legend><p className="model-panel__hint">Enter an environment variable name such as OPENAI_API_KEY. Raw API keys are never accepted or displayed.</p><form onSubmit={addProvider}><label>Preset<select value={preset} onChange={event => setPreset(event.target.value)}><option value="">Custom compatible provider</option><option value="openai">OpenAI preset</option><option value="anthropic">Anthropic preset</option></select></label><label>Provider ID<input value={newProviderId} onChange={event => setNewProviderId(event.target.value)} disabled={Boolean(preset)} /></label><label>Base URL<input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} disabled={Boolean(preset)} /></label><label>API key environment variable<input value={apiKeyEnv} onChange={event => setApiKeyEnv(event.target.value)} placeholder="OPENAI_API_KEY" disabled={Boolean(preset)} autoComplete="off" /></label><label>Models<textarea value={models} onChange={event => setModels(event.target.value)} disabled={Boolean(preset)} placeholder="model-a, model-b" /></label><button className="neutral-action" type="submit" disabled={disabled || !onProviderAdd}>Add provider</button></form></fieldset>
			{providers.length > 0 ? <fieldset className="model-panel__settings"><legend>Provider sign-in</legend>{providers.map(item => { const guidance = providerAuthGuidance(item); return <div className="provider-auth-row" key={item.id}><strong>{item.name ?? item.id}</strong><span className={item.authenticated ? "status-badge status-badge--ok" : "status-badge"}>{item.authenticated ? "signed in" : "signed out"}</span>{guidance ? <em>{guidance}</em> : null}{item.authKind === "oauth" && !item.authenticated ? <button className="neutral-action" type="button" disabled={disabled || !loginClient} onClick={() => setLoginProvider(item.id)}>Login</button> : null}{item.authenticated ? <button className="neutral-action" type="button" disabled={disabled || !onLogoutProvider} onClick={() => void logoutProvider(item.id)}>Sign out</button> : null}</div>; })}</fieldset> : null}
			{loginProvider && loginClient ? <LoginFlowSheet providerId={loginProvider} client={loginClient} onClose={() => setLoginProvider(null)} /> : null}
		</section>
	);
}
