import { Fragment, type ReactNode, useMemo, useState } from "react";
import {
	type AppearanceSemanticPreview,
	type AppearanceSettings,
	type AppearanceTheme,
	type Extension,
	fuzzyFilter,
	groupCounts,
	isSecretSettingKey,
	maskSecretValue,
	type Plugin,
	type PluginInspection,
	previewAppearance,
	type Skill,
} from "./extensibility-logic";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function extensionEnabled(extension: Extension): boolean {
	return extension.state !== "disabled";
}

function pluginEnabled(plugin: Plugin): boolean {
	return plugin.status !== "disabled";
}

function manifestSettingSchema(manifest: unknown, key: string): Record<string, unknown> | undefined {
	return record(record(record(manifest)?.settings)?.[key]);
}

function settingInputType(
	schema: Record<string, unknown> | undefined,
	key: string,
): "checkbox" | "number" | "password" | "text" {
	if (schema?.type === "boolean") return "checkbox";
	if (schema?.type === "number") return "number";
	return schema?.secret === true || isSecretSettingKey(key) ? "password" : "text";
}

export type ExtensibilityPanelProps = {
	skills: Skill[];
	extensions: Extension[];
	plugins: Plugin[];
	pluginInspection?: PluginInspection;
	appearance?: AppearanceSettings;
	appearanceThemes?: AppearanceTheme[];
	activeTab?: Tab;
	onTabChange?(tab: Tab): void;
	onPreviewAppearance?(next: AppearanceSettings): void;
	onRestoreAppearance?(): void;
	onApplyAppearance?(next: AppearanceSettings): void;
	onSkillEnabled?(skillId: string, enabled: boolean): void;
	onExtensionEnabled?(extensionId: string, enabled: boolean): void;
	onPluginEnabled?(pluginId: string, enabled: boolean): void;
	onPluginSetting?(pluginId: string, key: string, value: unknown): void;
	loading: boolean;
	error?: string;
	onRefresh(): void;
	onInspectExtension(id: string): void;
	onInspectPlugin(id: string): void;
};

type Tab = "skills" | "extensions" | "plugins" | "appearance";

export function ExtensibilityPanel({
	skills,
	extensions,
	plugins,
	pluginInspection,
	appearance,
	appearanceThemes = [],
	activeTab,
	onTabChange,
	onPreviewAppearance,
	onRestoreAppearance,
	onApplyAppearance,
	onSkillEnabled,
	onExtensionEnabled,
	onPluginEnabled,
	onPluginSetting,
	loading,
	error,
	onRefresh,
	onInspectExtension,
	onInspectPlugin,
}: ExtensibilityPanelProps) {
	const [uncontrolledTab, setUncontrolledTab] = useState<Tab>("skills");
	const tab = activeTab ?? uncontrolledTab;
	const setTab = (next: Tab) => {
		if (activeTab === undefined) setUncontrolledTab(next);
		onTabChange?.(next);
	};
	const [query, setQuery] = useState("");
	const counts = groupCounts({ skills, extensions, plugins });
	const filteredSkills = useMemo(
		() => fuzzyFilter(skills, query, skill => `${skill.name} ${skill.source} ${skill.description ?? ""}`),
		[query, skills],
	);
	const filteredExtensions = useMemo(
		() =>
			fuzzyFilter(
				extensions,
				query,
				extension =>
					`${extension.id} ${extension.name} ${extension.kind} ${extension.source} ${extension.status ?? ""}`,
			),
		[extensions, query],
	);
	const filteredPlugins = useMemo(
		() =>
			fuzzyFilter(
				plugins,
				query,
				plugin => `${plugin.id} ${plugin.name} ${plugin.kind} ${plugin.source} ${plugin.status ?? ""}`,
			),
		[plugins, query],
	);
	return (
		<section className="extensibility-panel" aria-label="Skills, extensions, plugins, and appearance">
			<header className="extensibility-panel__header">
				<div>
					<p className="eyebrow">Catalog controls</p>
					<h2>Skills & extensions</h2>
					<p>{counts.total} catalog entries · appearance uses terminal theme settings only</p>
				</div>
				<button className="neutral-action" type="button" onClick={onRefresh} disabled={loading}>
					{loading ? "Refreshing…" : "Refresh"}
				</button>
			</header>
			<div className="extensibility-panel__tabs" role="tablist" aria-label="Catalog sections">
				<TabButton id="skills" selected={tab === "skills"} onSelect={setTab}>
					Skills ({counts.skills})
				</TabButton>
				<TabButton id="extensions" selected={tab === "extensions"} onSelect={setTab}>
					Extensions ({counts.extensions})
				</TabButton>
				<TabButton id="plugins" selected={tab === "plugins"} onSelect={setTab}>
					Plugins ({counts.plugins})
				</TabButton>
				<TabButton id="appearance" selected={tab === "appearance"} onSelect={setTab}>
					Appearance
				</TabButton>
			</div>
			<label className="extensibility-panel__search">
				<span>Search catalogs</span>
				<input
					value={query}
					onChange={event => setQuery(event.target.value)}
					placeholder="Filter by name, source, status…"
				/>
			</label>
			{error ? <div className="extensibility-panel__state extensibility-panel__state--error">{error}</div> : null}
			{loading ? (
				<div className="extensibility-panel__state" aria-busy="true">
					Loading catalogs…
				</div>
			) : null}
			{tab === "skills" ? (
				<CatalogList
					title="Skills"
					empty="No skills match."
					items={filteredSkills}
					render={skill => <SkillRow skill={skill} onToggle={onSkillEnabled} />}
				/>
			) : null}
			{tab === "extensions" ? (
				<CatalogList
					title="Extensions"
					empty="No extensions match."
					items={filteredExtensions}
					render={extension => (
						<ExtensionRow extension={extension} onInspect={onInspectExtension} onToggle={onExtensionEnabled} />
					)}
				/>
			) : null}
			{tab === "plugins" ? (
				<CatalogList
					title="Plugins"
					empty="No plugins match."
					items={filteredPlugins}
					render={plugin => (
						<PluginRow
							plugin={plugin}
							inspection={pluginInspection?.plugin.id === plugin.id ? pluginInspection : undefined}
							onInspect={onInspectPlugin}
							onToggle={onPluginEnabled}
							onSetting={onPluginSetting}
						/>
					)}
				/>
			) : null}
			{tab === "appearance" ? (
				<AppearancePanel
					themes={appearanceThemes}
					appearance={appearance}
					onPreview={onPreviewAppearance}
					onRestore={onRestoreAppearance}
					onApply={onApplyAppearance}
				/>
			) : null}
		</section>
	);
}
function TabButton({
	id,
	selected,
	onSelect,
	children,
}: {
	id: Tab;
	selected: boolean;
	onSelect(tab: Tab): void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={selected}
			className={
				selected ? "extensibility-panel__tab extensibility-panel__tab--selected" : "extensibility-panel__tab"
			}
			onClick={() => onSelect(id)}
		>
			{children}
		</button>
	);
}
function CatalogList<T>({
	title,
	empty,
	items,
	render,
}: {
	title: string;
	empty: string;
	items: T[];
	render(item: T): ReactNode;
}) {
	return (
		<section className="extensibility-panel__list" aria-label={title}>
			{items.length === 0 ? (
				<div className="extensibility-panel__state">{empty}</div>
			) : (
				items.map((item, index) => <Fragment key={index}>{render(item)}</Fragment>)
			)}
		</section>
	);
}
function SkillRow({ skill, onToggle }: { skill: Skill; onToggle?(id: string, enabled: boolean): void }) {
	const enabled = skill.enabled !== false;
	const id =
		(skill as Skill & { id?: string; skillId?: string }).id ??
		(skill as Skill & { skillId?: string }).skillId ??
		skill.name;
	return (
		<article className="extensibility-card">
			<RowHeader title={skill.name} meta={skill.source} badge={enabled ? "enabled" : "disabled"} />
			{skill.description ? <p>{skill.description}</p> : null}
			<button type="button" onClick={() => onToggle?.(id, !enabled)}>
				{enabled ? "Disable" : "Enable"}
			</button>
		</article>
	);
}
function ExtensionRow({
	extension,
	onInspect,
	onToggle,
}: {
	extension: Extension;
	onInspect(id: string): void;
	onToggle?(id: string, enabled: boolean): void;
}) {
	const enabled = extensionEnabled(extension);
	return (
		<article className="extensibility-card">
			<RowHeader
				title={extension.name}
				meta={`${extension.kind} · ${extension.source}`}
				badge={enabled ? "enabled" : extension.status}
			/>
			<p>{extension.id}</p>
			<div className="extensibility-card__actions">
				<button type="button" onClick={() => onInspect(extension.id)}>
					Inspect
				</button>
				<button type="button" onClick={() => onToggle?.(extension.id, !enabled)}>
					{enabled ? "Disable" : "Enable"}
				</button>
			</div>
		</article>
	);
}
function PluginRow({
	plugin,
	inspection,
	onInspect,
	onToggle,
	onSetting,
}: {
	plugin: Plugin;
	inspection?: PluginInspection;
	onInspect(id: string): void;
	onToggle?(id: string, enabled: boolean): void;
	onSetting?(id: string, key: string, value: unknown): void;
}) {
	const enabled = pluginEnabled(plugin);
	const [settingErrors, setSettingErrors] = useState<Record<string, string | undefined>>({});
	const settings = Object.entries(record(inspection?.settings) ?? {});
	return (
		<article className="extensibility-card">
			<RowHeader
				title={plugin.name}
				meta={`${plugin.kind} · ${plugin.source}`}
				badge={enabled ? "enabled" : plugin.status}
			/>
			<p>{plugin.id}</p>
			<div className="extensibility-card__actions">
				<button type="button" onClick={() => onInspect(plugin.id)}>
					Inspect masked settings
				</button>
				<button type="button" onClick={() => onToggle?.(plugin.id, !enabled)}>
					{enabled ? "Disable" : "Enable"}
				</button>
			</div>
			{settings.length ? (
				<details className="extensibility-card__details" open>
					<summary>Masked settings</summary>
					<dl>
						{settings.map(([key, value]) => (
							<Fragment key={key}>
								<dt>{key}</dt>
								<dd>{maskSecretValue(value, key)}</dd>
								<dd>
									{(() => {
										const schema = manifestSettingSchema(inspection?.manifest, key);
										const type = settingInputType(schema, key);
										const error = settingErrors[key];
										const submitNumber = (raw: string) => {
											const number = Number(raw);
											const min = typeof schema?.min === "number" ? schema.min : undefined;
											const max = typeof schema?.max === "number" ? schema.max : undefined;
											const step = typeof schema?.step === "number" ? schema.step : undefined;
											const stepBase = min ?? 0;
											const stepMismatch =
												step !== undefined &&
												step > 0 &&
												Math.abs((number - stepBase) / step - Math.round((number - stepBase) / step)) >
													1e-9;
											if (
												raw.trim() === "" ||
												!Number.isFinite(number) ||
												(min !== undefined && number < min) ||
												(max !== undefined && number > max) ||
												stepMismatch
											) {
												setSettingErrors(current => ({
													...current,
													[key]: "Enter a finite value within the allowed range and step.",
												}));
												return;
											}
											setSettingErrors(current => ({ ...current, [key]: undefined }));
											onSetting?.(plugin.id, key, number);
										};
										if (schema?.type === "enum")
											return (
												<select
													defaultValue={typeof value === "string" ? value : undefined}
													onChange={event => onSetting?.(plugin.id, key, event.currentTarget.value)}
												>
													{Array.isArray(schema.values) &&
														schema.values
															.filter((entry): entry is string => typeof entry === "string")
															.map(entry => (
																<option key={entry} value={entry}>
																	{entry}
																</option>
															))}
												</select>
											);
										return (
											<>
												<input
													type={type}
													min={
														type === "number" && typeof schema?.min === "number" ? schema.min : undefined
													}
													max={
														type === "number" && typeof schema?.max === "number" ? schema.max : undefined
													}
													step={
														type === "number" && typeof schema?.step === "number"
															? schema.step
															: undefined
													}
													checked={type === "checkbox" ? value === true : undefined}
													onChange={event => {
														if (type === "checkbox")
															onSetting?.(plugin.id, key, event.currentTarget.checked);
													}}
													onBlur={event => {
														if (type === "number") submitNumber(event.currentTarget.value);
														else if (type !== "checkbox")
															onSetting?.(plugin.id, key, event.currentTarget.value);
													}}
												/>
												{error ? <span role="alert">{error}</span> : null}
											</>
										);
									})()}
								</dd>
							</Fragment>
						))}
					</dl>
				</details>
			) : null}
		</article>
	);
}
function AppearancePanel({
	themes,
	appearance,
	onPreview,
	onRestore,
	onApply,
}: {
	themes: AppearanceTheme[];
	appearance?: AppearanceSettings;
	onPreview?(next: AppearanceSettings): void;
	onRestore?(): void;
	onApply?(next: AppearanceSettings): void;
}) {
	if (!appearance)
		return (
			<section className="extensibility-panel__appearance">
				<h3>Appearance</h3>
				<p>Appearance settings are loading.</p>
			</section>
		);
	const preview = (patch: Partial<AppearanceSettings>) =>
		onPreview?.(
			previewAppearance({ baseline: appearance, candidate: appearance, previewActive: false }, patch).candidate,
		);
	return (
		<section className="extensibility-panel__appearance" aria-label="Appearance">
			<h3>Terminal appearance</h3>
			<p>Theme choices affect terminal rendering only.</p>
			{themes.map(theme => (
				<button
					className="extensibility-card"
					key={theme.id}
					type="button"
					aria-pressed={theme.id === appearance.dark || theme.id === appearance.light}
					onClick={() => preview(theme.kind === "dark" ? { dark: theme.id } : { light: theme.id })}
				>
					<RowHeader title={theme.id} meta={theme.builtin ? "built-in" : "custom"} badge={theme.kind} />
					<ThemeSample semantic={theme.semanticPreview} />
				</button>
			))}
			<div className="extensibility-card__actions">
				<button type="button" onClick={() => onApply?.(appearance)}>
					Apply terminal appearance
				</button>
				<button type="button" onClick={() => onRestore?.()}>
					Cancel preview
				</button>
			</div>
		</section>
	);
}
function ThemeSample({ semantic }: { semantic: AppearanceSemanticPreview }) {
	return (
		<div
			className="appearance-theme-sample"
			aria-label="Semantic theme sample"
			style={{ backgroundColor: semantic.bg, borderColor: semantic.border, color: semantic.text }}
		>
			<p>
				assistant <small style={{ color: semantic.textMuted }}>streaming transcript</small>
			</p>
			<div style={{ backgroundColor: semantic.surface, borderColor: semantic.border }}>tool read DESIGN.md</div>
		</div>
	);
}
function RowHeader({ title, meta, badge }: { title: string; meta?: string; badge?: string | null }) {
	return (
		<header>
			<div>
				<strong>{title}</strong>
				{meta ? <span>{meta}</span> : null}
			</div>
			{badge ? <em>{badge}</em> : null}
		</header>
	);
}
