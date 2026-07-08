import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { GjcExtensionsInspectResult } from "@gajae-code/app-server-client";
import { fuzzyFilter, groupCounts, maskSecretValue, previewAppearance, type AppearanceSemanticPreview, type AppearanceSettings, type AppearanceTheme, type Extension, type Plugin, type PluginInspection, type Skill } from "./extensibility-logic";
type ExtensionInspection = NonNullable<GjcExtensionsInspectResult["extension"]>;

export type ExtensibilityPanelProps = {
	skills: Skill[];
	extensions: Extension[];
	plugins: Plugin[];
	pluginInspection?: PluginInspection;
	extensionInspection?: ExtensionInspection;
	appearanceThemes?: AppearanceTheme[];
	appearance?: AppearanceSettings;
	appearancePreviewActive?: boolean;
	loading: boolean;
	error?: string;
	onRefresh(): void;
	onInspectExtension(id: string): void;
	onInspectPlugin(id: string): void;
	onPreviewAppearance?(next: AppearanceSettings): void;
	onRestoreAppearance?(): void;
	onApplyAppearance?(next: AppearanceSettings): void;
	onSkillEnabled?(skillId: string, enabled: boolean): void;
	onExtensionEnabled?(extensionId: string, enabled: boolean): void;
	onPluginEnabled?(pluginId: string, enabled: boolean): void;
	onPluginFeature?(pluginId: string, feature: string, enabled: boolean): void;
	onPluginSetting?(pluginId: string, key: string, value: unknown): void;
	initialTab?: Tab;
	activeTab?: Tab;
	onTabChange?(tab: Tab): void;
};

type Tab = "skills" | "extensions" | "plugins" | "appearance";

const noopAppearance = () => undefined;

export function ExtensibilityPanel({ skills, extensions, plugins, extensionInspection, pluginInspection, appearanceThemes = [], appearance, appearancePreviewActive, initialTab = "skills", activeTab, loading, error, onRefresh, onInspectExtension, onInspectPlugin, onPreviewAppearance = noopAppearance, onRestoreAppearance = noopAppearance, onApplyAppearance = noopAppearance, onSkillEnabled, onExtensionEnabled, onPluginEnabled, onPluginFeature, onPluginSetting, onTabChange }: ExtensibilityPanelProps) {
	const [uncontrolledTab, setUncontrolledTab] = useState<Tab>(initialTab);
	const tab = activeTab ?? uncontrolledTab;
	const setTab = activeTab === undefined ? setUncontrolledTab : (next: Tab) => onTabChange?.(next);
	const [query, setQuery] = useState("");
	const counts = groupCounts({ skills, extensions, plugins });
	const filteredSkills = useMemo(() => fuzzyFilter(skills, query, skill => `${skill.name} ${skill.source} ${skill.description ?? ""}`), [query, skills]);
	const filteredExtensions = useMemo(() => fuzzyFilter(extensions, query, extension => `${extension.id} ${extension.name} ${extension.kind} ${extension.source} ${extension.status ?? ""}`), [extensions, query]);
	const filteredPlugins = useMemo(() => fuzzyFilter(plugins, query, plugin => `${plugin.id} ${plugin.name} ${plugin.kind} ${plugin.source} ${plugin.status ?? ""}`), [plugins, query]);

	return (
		<section className="extensibility-panel" aria-label="Skills, extensions, plugins, and appearance">
			<header className="extensibility-panel__header">
				<div>
					<p className="eyebrow">Catalog controls</p>
					<h2>Skills & extensions</h2>
					<p>{counts.total} catalog entries · appearance uses terminal theme settings only</p>
				</div>
				<button className="neutral-action" type="button" onClick={onRefresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
			</header>

			<div className="extensibility-panel__tabs" role="tablist" aria-label="Catalog sections">
				<TabButton id="skills" selected={tab === "skills"} onSelect={setTab}>Skills ({counts.skills})</TabButton>
				<TabButton id="extensions" selected={tab === "extensions"} onSelect={setTab}>Extensions ({counts.extensions})</TabButton>
				<TabButton id="plugins" selected={tab === "plugins"} onSelect={setTab}>Plugins ({counts.plugins})</TabButton>
				<TabButton id="appearance" selected={tab === "appearance"} onSelect={setTab}>Appearance</TabButton>
			</div>

			<label className="extensibility-panel__search"><span>Search catalogs</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter by name, source, status…" /></label>
			{error ? <div className="extensibility-panel__state extensibility-panel__state--error">{error}</div> : null}
			{loading ? <div className="extensibility-panel__state" aria-busy="true">Loading catalogs…</div> : null}
			{tab === "skills" ? <CatalogList title="Skills" empty="No skills match." items={filteredSkills} render={skill => <SkillRow skill={skill} onToggle={onSkillEnabled} />} /> : null}
			{tab === "extensions" ? <CatalogList title="Extensions" empty="No extensions match." items={filteredExtensions} render={extension => <ExtensionRow extension={extension} inspection={extensionInspection?.id === extension.id ? extensionInspection : undefined} onInspect={onInspectExtension} onToggle={onExtensionEnabled} />} /> : null}
			{tab === "plugins" ? <CatalogList title="Plugins" empty="No plugins match." items={filteredPlugins} render={plugin => <PluginRow plugin={plugin} inspection={pluginInspection?.plugin.id === plugin.id ? pluginInspection : undefined} onInspect={onInspectPlugin} onToggle={onPluginEnabled} onFeature={onPluginFeature} onSetting={onPluginSetting} />} /> : null}
			{tab === "appearance" ? <AppearancePanel themes={appearanceThemes} appearance={appearance} previewActive={Boolean(appearancePreviewActive)} onPreview={onPreviewAppearance} onRestore={onRestoreAppearance} onApply={onApplyAppearance} /> : null}
		</section>
	);
}

function TabButton({ id, selected, onSelect, children }: { id: Tab; selected: boolean; onSelect(tab: Tab): void; children: ReactNode }) {
	return <button type="button" role="tab" aria-selected={selected} className={selected ? "extensibility-panel__tab extensibility-panel__tab--selected" : "extensibility-panel__tab"} onClick={() => onSelect(id)}>{children}</button>;
}

function CatalogList<T>({ title, empty, items, render }: { title: string; empty: string; items: T[]; render(item: T): ReactNode }) {
	return <section className="extensibility-panel__list" aria-label={title}>{items.length === 0 ? <div className="extensibility-panel__state">{empty}</div> : items.map((item, index) => <Fragment key={index}>{render(item)}</Fragment>)}</section>;
}

function SkillRow({ skill, onToggle }: { skill: Skill; onToggle?(skillId: string, enabled: boolean): void }) {
	const enabled = (skill as { enabled?: boolean }).enabled !== false;
	const skillId = (skill as { id?: string; skillId?: string }).id ?? (skill as { skillId?: string }).skillId ?? skill.name;
	return <article className="extensibility-card"><RowHeader title={skill.name} meta={skill.source} badge={enabled ? "enabled" : "disabled"} />{skill.description ? <p>{skill.description}</p> : null}<button type="button" onClick={() => confirmToggle(skill.name, !enabled) && onToggle?.(skillId, !enabled)}>{enabled ? "Disable" : "Enable"}</button></article>;
}

function ExtensionRow({ extension, inspection, onInspect, onToggle }: { extension: Extension; inspection?: ExtensionInspection; onInspect(id: string): void; onToggle?(extensionId: string, enabled: boolean): void }) {
	const enabled = (extension as { enabled?: boolean }).enabled !== false;
	return <article className="extensibility-card"><RowHeader title={extension.name} meta={`${extension.kind} · ${extension.source}`} badge={enabled ? "enabled" : (extension.status ?? extension.state)} /><p>{extension.id}</p><div className="extensibility-card__actions"><button type="button" onClick={() => onInspect(extension.id)}>Inspect</button><button type="button" onClick={() => confirmToggle(extension.id, !enabled) && onToggle?.(extension.id, !enabled)}>{enabled ? "Disable" : "Enable"}</button></div>{inspection ? <details className="extensibility-card__details" open><summary>Extension detail</summary><dl>{Object.entries(inspection).map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{formatSettingValue(value, key)}</dd></Fragment>)}</dl></details> : null}</article>;
}

function PluginRow({ plugin, inspection, onInspect, onToggle, onFeature, onSetting }: { plugin: Plugin; inspection?: PluginInspection; onInspect(id: string): void; onToggle?(pluginId: string, enabled: boolean): void; onFeature?(pluginId: string, feature: string, enabled: boolean): void; onSetting?(pluginId: string, key: string, value: unknown): void }) {
	const enabled = (plugin as { enabled?: boolean }).enabled !== false;
	const features = Object.entries((inspection as { features?: Record<string, unknown> } | undefined)?.features ?? {});
	const settings = Object.entries(inspection?.settings ?? {});
	return <article className="extensibility-card"><RowHeader title={plugin.name} meta={`${plugin.kind} · ${plugin.source}`} badge={enabled ? "enabled" : plugin.status} /><p>{plugin.id}</p><div className="extensibility-card__actions"><button type="button" onClick={() => onInspect(plugin.id)}>Inspect masked settings</button><button type="button" onClick={() => confirmToggle(plugin.id, !enabled) && onToggle?.(plugin.id, !enabled)}>{enabled ? "Disable" : "Enable"}</button></div>{features.length > 0 ? <details className="extensibility-card__details" open><summary>Features</summary>{features.map(([feature, value]) => <label key={feature}><input type="checkbox" checked={value === true} onChange={event => onFeature?.(plugin.id, feature, event.target.checked)} /> {feature}</label>)}</details> : null}{settings.length > 0 ? <details className="extensibility-card__details" open><summary>Masked settings</summary><dl>{settings.map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{formatSettingValue(value, key)}</dd><dd><input type={maskSecretValue(value, key) === "••••••••" ? "password" : "text"} placeholder={maskSecretValue(value, key)} onBlur={event => { if (event.currentTarget.value) onSetting?.(plugin.id, key, event.currentTarget.value); }} /></dd></Fragment>)}</dl></details> : null}</article>;
}

function AppearancePanel({ themes, appearance, previewActive, onPreview, onRestore, onApply }: { themes: AppearanceTheme[]; appearance?: AppearanceSettings; previewActive: boolean; onPreview(next: AppearanceSettings): void; onRestore(): void; onApply(next: AppearanceSettings): void }) {
	if (!appearance) return <section className="extensibility-panel__appearance"><h3>Appearance</h3><p>Appearance settings are loading.</p></section>;
	const darkThemes = themes.filter(theme => theme.kind === "dark");
	const lightThemes = themes.filter(theme => theme.kind === "light");
	const preview = (patch: Partial<AppearanceSettings>) => onPreview(previewAppearance({ baseline: appearance, candidate: appearance, previewActive: false }, patch).candidate);
	return (
		<section className="extensibility-panel__appearance" aria-label="Appearance">
			<h3>Terminal appearance</h3>
			<p>Theme choices affect terminal rendering only. App chrome stays on DESIGN.md tokens and never adopts terminal palettes.</p>
			{themes.length === 0 ? <div className="extensibility-panel__state">No themes exposed by the registry.</div> : null}
			<ThemeGroup title="Dark terminal themes" themes={darkThemes} selected={appearance.dark} onSelect={id => preview({ dark: id })} />
			<ThemeGroup title="Light terminal themes" themes={lightThemes} selected={appearance.light} onSelect={id => preview({ light: id })} />
			<label>Symbol preset <select value={appearance.symbolPreset ?? "unicode"} onChange={event => preview({ symbolPreset: event.target.value })}><option value="unicode">unicode</option><option value="nerd">nerd</option><option value="ascii">ascii</option></select></label>
			<label><input type="checkbox" checked={Boolean(appearance.colorBlindMode)} onChange={event => preview({ colorBlindMode: event.target.checked })} /> Color blind diff additions</label>
			<div className="extensibility-card__actions"><button type="button" disabled={!previewActive && appearance === undefined} onClick={() => onApply(appearance)}>Apply terminal appearance</button><button type="button" disabled={!previewActive} onClick={() => onRestore()}>Cancel preview</button></div>
		</section>
	);
}

function ThemeGroup({ title, themes, selected, onSelect }: { title: string; themes: AppearanceTheme[]; selected: string; onSelect(id: string): void }) {
	return <section className="extensibility-panel__list" aria-label={title}><h4>{title}</h4>{themes.map(theme => <button className="extensibility-card" key={theme.id} type="button" aria-pressed={theme.id === selected} onClick={() => onSelect(theme.id)}><RowHeader title={theme.id} meta={theme.builtin ? "built-in" : "custom"} badge={theme.id === selected ? "selected" : theme.kind} /><Swatches theme={theme} /><ThemeSample semantic={theme.semanticPreview} /></button>)}</section>;
}

function Swatches({ theme }: { theme: AppearanceTheme }) {
	return <div className="appearance-swatches" aria-label={`${theme.id} semantic preview`}>{Object.entries(theme.semanticPreview).map(([name, color]) => <span key={name} title={`${name}: ${color}`} style={{ backgroundColor: color }} />)}</div>;
}

function ThemeSample({ semantic }: { semantic: AppearanceSemanticPreview }) {
	const sampleStyle = {
		backgroundColor: semantic.bg,
		borderColor: semantic.border,
		color: semantic.text,
	} as const;
	const mutedStyle = { color: semantic.textMuted } as const;
	const toolStyle = {
		backgroundColor: semantic.surface,
		borderColor: semantic.border,
		color: semantic.text,
	} as const;
	return (
		<div className="appearance-theme-sample" aria-label="Semantic theme sample" style={sampleStyle}>
			<p><span style={{ backgroundColor: semantic.accent }} /> <strong>assistant</strong> <small style={mutedStyle}>streaming transcript</small></p>
			<div style={toolStyle}><strong>tool</strong><span style={mutedStyle}> read DESIGN.md</span></div>
			<p><span style={{ backgroundColor: semantic.success }} /> <small style={mutedStyle}>connected</small> <span style={{ backgroundColor: semantic.warning }} /> <small style={mutedStyle}>approval</small> <span style={{ backgroundColor: semantic.danger }} /> <small style={mutedStyle}>error</small></p>
		</div>
	);
}

function RowHeader({ title, meta, badge }: { title: string; meta?: string; badge?: string | null }) {
	return <header><div><strong>{title}</strong>{meta ? <span>{meta}</span> : null}</div>{badge ? <em>{badge}</em> : null}</header>;
}

function formatSettingValue(value: unknown, key = ""): string {
	return maskSecretValue(value, key);
}

function confirmToggle(label: string, enabled: boolean): boolean {
	return window.confirm(`${enabled ? "Enable" : "Disable"} ${label}?`);
}

