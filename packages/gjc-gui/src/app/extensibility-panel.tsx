import { Fragment, useMemo, useState, type ReactNode } from "react";
import { APPEARANCE_DEFERRED, fuzzyFilter, groupCounts, type Extension, type Plugin, type PluginInspection, type Skill } from "./extensibility-logic";

export type ExtensibilityPanelProps = {
	skills: Skill[];
	extensions: Extension[];
	plugins: Plugin[];
	pluginInspection?: PluginInspection;
	loading: boolean;
	error?: string;
	onRefresh(): void;
	onInspectExtension(id: string): void;
	onInspectPlugin(id: string): void;
};

type Tab = "skills" | "extensions" | "plugins" | "appearance";

export function ExtensibilityPanel({ skills, extensions, plugins, pluginInspection, loading, error, onRefresh, onInspectExtension, onInspectPlugin }: ExtensibilityPanelProps) {
	const [tab, setTab] = useState<Tab>("skills");
	const [query, setQuery] = useState("");
	const counts = groupCounts({ skills, extensions, plugins });
	const filteredSkills = useMemo(() => fuzzyFilter(skills, query, skill => `${skill.name} ${skill.source} ${skill.description ?? ""}`), [query, skills]);
	const filteredExtensions = useMemo(() => fuzzyFilter(extensions, query, extension => `${extension.id} ${extension.name} ${extension.kind} ${extension.source} ${extension.status ?? ""}`), [extensions, query]);
	const filteredPlugins = useMemo(() => fuzzyFilter(plugins, query, plugin => `${plugin.id} ${plugin.name} ${plugin.kind} ${plugin.source} ${plugin.status ?? ""}`), [plugins, query]);

	return (
		<section className="extensibility-panel" aria-label="Skills, extensions, plugins, and appearance">
			<header className="extensibility-panel__header">
				<div>
					<p className="eyebrow">Read-only catalogs</p>
					<h2>Skills & extensions</h2>
					<p>{counts.total} catalog entries · mutations deferred</p>
				</div>
				<button className="neutral-action" type="button" onClick={onRefresh} disabled={loading}>
					{loading ? "Refreshing…" : "Refresh"}
				</button>
			</header>

			<div className="extensibility-panel__tabs" role="tablist" aria-label="Catalog sections">
				<TabButton id="skills" selected={tab === "skills"} onSelect={setTab}>Skills ({counts.skills})</TabButton>
				<TabButton id="extensions" selected={tab === "extensions"} onSelect={setTab}>Extensions ({counts.extensions})</TabButton>
				<TabButton id="plugins" selected={tab === "plugins"} onSelect={setTab}>Plugins ({counts.plugins})</TabButton>
				<TabButton id="appearance" selected={tab === "appearance"} onSelect={setTab}>Appearance</TabButton>
			</div>

			<label className="extensibility-panel__search">
				<span>Search catalogs</span>
				<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter by name, source, status…" />
			</label>

			{error ? <div className="extensibility-panel__state extensibility-panel__state--error">{error}</div> : null}
			{loading ? <div className="extensibility-panel__state" aria-busy="true">Loading catalogs…</div> : null}

			{tab === "skills" ? <CatalogList title="Skills" empty="No skills match." items={filteredSkills} render={skill => <SkillRow skill={skill} />} /> : null}
			{tab === "extensions" ? <CatalogList title="Extensions" empty="No extensions match." items={filteredExtensions} render={extension => <ExtensionRow extension={extension} onInspect={onInspectExtension} />} /> : null}
			{tab === "plugins" ? <CatalogList title="Plugins" empty="No plugins match." items={filteredPlugins} render={plugin => <PluginRow plugin={plugin} inspection={pluginInspection?.plugin.id === plugin.id ? pluginInspection : undefined} onInspect={onInspectPlugin} />} /> : null}
			{tab === "appearance" ? <AppearanceDeferred /> : null}
		</section>
	);
}

function TabButton({ id, selected, onSelect, children }: { id: Tab; selected: boolean; onSelect(tab: Tab): void; children: ReactNode }) {
	return (
		<button type="button" role="tab" aria-selected={selected} className={selected ? "extensibility-panel__tab extensibility-panel__tab--selected" : "extensibility-panel__tab"} onClick={() => onSelect(id)}>
			{children}
		</button>
	);
}

function CatalogList<T>({ title, empty, items, render }: { title: string; empty: string; items: T[]; render(item: T): ReactNode }) {
	return (
		<section className="extensibility-panel__list" aria-label={title}>
			{items.length === 0 ? <div className="extensibility-panel__state">{empty}</div> : items.map((item, index) => <Fragment key={index}>{render(item)}</Fragment>)}
		</section>
	);
}

function SkillRow({ skill }: { skill: Skill }) {
	return (
		<article className="extensibility-card">
			<RowHeader title={skill.name} meta={skill.source} badge={skill.enabled === false ? "disabled" : "enabled"} />
			{skill.description ? <p>{skill.description}</p> : null}
			<button type="button" disabled>manage (soon)</button>
		</article>
	);
}

function ExtensionRow({ extension, onInspect }: { extension: Extension; onInspect(id: string): void }) {
	return (
		<article className="extensibility-card">
			<RowHeader title={extension.name} meta={`${extension.kind} · ${extension.source}`} badge={extension.status} />
			<p>{extension.id}</p>
			<div className="extensibility-card__actions">
				<button type="button" onClick={() => onInspect(extension.id)}>Inspect</button>
				<button type="button" disabled>manage (soon)</button>
			</div>
		</article>
	);
}

function PluginRow({ plugin, inspection, onInspect }: { plugin: Plugin; inspection?: PluginInspection; onInspect(id: string): void }) {
	return (
		<article className="extensibility-card">
			<RowHeader title={plugin.name} meta={`${plugin.kind} · ${plugin.source}`} badge={plugin.status} />
			<p>{plugin.id}</p>
			<div className="extensibility-card__actions">
				<button type="button" onClick={() => onInspect(plugin.id)}>Inspect masked settings</button>
				<button type="button" disabled>manage (soon)</button>
			</div>
			{inspection?.settings && Object.keys(inspection.settings).length > 0 ? (
				<details className="extensibility-card__details" open>
					<summary>Masked settings</summary>
					<dl>
						{Object.entries(inspection.settings).map(([key, value]) => (
							<Fragment key={key}>
								<dt>{key}</dt>
								<dd>{formatSettingValue(value)}</dd>
							</Fragment>
						))}
					</dl>
				</details>
			) : null}
		</article>
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

function formatSettingValue(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function AppearanceDeferred() {
	return (
		<section className="extensibility-panel__appearance" aria-disabled="true" aria-label="Appearance deferred">
			<h3>Appearance</h3>
			<p>{APPEARANCE_DEFERRED.reason}</p>
			<p>{APPEARANCE_DEFERRED.unblock}</p>
			<button type="button" disabled>theme controls (soon)</button>
		</section>
	);
}
