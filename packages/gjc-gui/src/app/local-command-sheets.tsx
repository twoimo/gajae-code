export type LocalCommandSheet = "help" | "hotkeys";

export function HelpSheet({ onClose }: { onClose(): void }) {
	return (
		<div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
			<section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="help-sheet-title" onMouseDown={event => event.stopPropagation()}>
				<header>
					<p className="eyebrow">Local reference</p>
					<h2 id="help-sheet-title">Command help</h2>
				</header>
				<p>Use the palette to navigate GUI surfaces, run supported actions, or insert slash commands that are still prompt-only.</p>
				<ul>
					<li><strong>/model</strong>, <strong>/theme</strong>, <strong>/session</strong>, <strong>/tools</strong>, <strong>/skills</strong>, <strong>/extensions</strong>, and <strong>/plugins</strong> open local panels.</li>
					<li><strong>/compact</strong>, <strong>/retry</strong>, <strong>/new</strong>, <strong>/copy</strong>, <strong>/dump</strong>, <strong>/drop</strong>, and <strong>/resume</strong> run GUI actions.</li>
					<li>Prompt-only commands insert text in the composer without contacting the backend.</li>
				</ul>
				<footer><button className="primary-action" type="button" onClick={onClose}>Close</button></footer>
			</section>
		</div>
	);
}

export function HotkeysSheet({ onClose }: { onClose(): void }) {
	const keys = [
		["Cmd/Ctrl+K", "Open or close the command palette"],
		["Enter", "Send the current composer message"],
		["Shift+Enter", "Insert a newline"],
		["Ctrl/Cmd+Enter", "Insert a newline"],
		["Esc", "Close dialogs or interrupt from the stop control when a turn is running"],
		["Arrow Up/Down", "Move palette selection"],
	];
	return (
		<div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
			<section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="hotkeys-sheet-title" onMouseDown={event => event.stopPropagation()}>
				<header>
					<p className="eyebrow">Local reference</p>
					<h2 id="hotkeys-sheet-title">Keyboard shortcuts</h2>
				</header>
				<dl>{keys.map(([key, description]) => <div key={key}><dt>{key}</dt><dd>{description}</dd></div>)}</dl>
				<footer><button className="primary-action" type="button" onClick={onClose}>Close</button></footer>
			</section>
		</div>
	);
}
