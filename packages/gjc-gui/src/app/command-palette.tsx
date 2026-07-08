import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
	classifyBadge,
	commandAction,
	commandDisabled,
	commandDisplayText,
	commandInsertText,
	fuzzyFilter,
	type PaletteCommand,
	type PaletteCommandAction,
	type PaletteTool,
} from "./command-palette-logic";

export type CommandPaletteProps = {
	open: boolean;
	commands: PaletteCommand[];
	tools: PaletteTool[];
	loading: boolean;
	error?: string;
	onClose(): void;
	onInsert(text: string): void;
	onAction?(action: PaletteCommandAction, command: PaletteCommand): void;
};

type PaletteRow =
	| { kind: "command"; command: PaletteCommand; disabled: boolean }
	| { kind: "tool"; tool: PaletteTool; disabled: true };

export function CommandPalette({ open, commands, tools, loading, error, onClose, onInsert, onAction }: CommandPaletteProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);

	const filteredCommands = useMemo(() => fuzzyFilter(commands, query, command => command.name), [commands, query]);
	const filteredTools = useMemo(() => fuzzyFilter(tools, query, tool => tool.name), [tools, query]);
	const rows = useMemo<PaletteRow[]>(
		() => [
			...filteredCommands.map(command => ({
				kind: "command" as const,
				command,
				disabled: commandDisabled(command),
			})),
			...filteredTools.map(tool => ({ kind: "tool" as const, tool, disabled: true as const })),
		],
		[filteredCommands, filteredTools],
	);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setSelectedIndex(0);
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [open]);

	useEffect(() => {
		setSelectedIndex(current => Math.min(current, Math.max(rows.length - 1, 0)));
	}, [rows.length]);

	const hasNoResults = !loading && !error && rows.length === 0;
	const activeDescendant = rows[selectedIndex] ? `command-palette-row-${selectedIndex}` : undefined;

	useEffect(() => {
		document.getElementById(activeDescendant ?? "")?.scrollIntoView({ block: "nearest" });
	}, [activeDescendant]);

	if (!open) return null;


	function activateRow(row = rows[selectedIndex]) {
		if (!row || row.disabled || row.kind !== "command") return;
		const action = commandAction(row.command);
		if (action.kind === "insert-prompt") onInsert(commandInsertText(row.command));
		else onAction?.(action, row.command);
		onClose();
	}

	function handleKeyDown(event: ReactKeyboardEvent) {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key === "Tab") {
			const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input, button, [href], [tabindex]:not([tabindex="-1"])')).filter(
				element => !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true",
			);
			if (focusable.length > 0) {
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
					return;
				}
				if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
					return;
				}
			}
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			if (rows.length > 0) setSelectedIndex(current => (current + 1 + rows.length) % rows.length);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			if (rows.length > 0) setSelectedIndex(current => (current - 1 + rows.length) % rows.length);
			return;
		}
		if (event.key === "Enter") {
			if (event.nativeEvent.isComposing || event.keyCode === 229) return;
			event.preventDefault();
			activateRow();
		}
	}


	return (
		<div className="command-palette-backdrop" onMouseDown={onClose}>
			<section
				className="command-palette"
				role="dialog"
				aria-modal="true"
				aria-label="Command palette"
				onKeyDown={handleKeyDown}
				onMouseDown={event => event.stopPropagation()}
			>
				<header className="command-palette__header">
					<label htmlFor="command-palette-search">Command palette</label>
					<input
						id="command-palette-search"
						ref={inputRef}
						value={query}
						onChange={event => {
							setQuery(event.target.value);
							setSelectedIndex(0);
						}}
						placeholder="Filter commands and tools…"
						aria-activedescendant={activeDescendant}
						aria-controls="command-palette-rows"
						role="combobox"
						aria-expanded="true"
					/>
				</header>

				<div className="command-palette__body">
					{loading ? <div className="command-palette__state">Loading commands...</div> : null}
					{error ? <div className="command-palette__state command-palette__state--error">{error}</div> : null}
					{!loading && !error ? (
						<div id="command-palette-rows" role="listbox">
							<PaletteSection
								title="Commands"
								rows={filteredCommands.map(command => ({ kind: "command" as const, command, disabled: commandDisabled(command) }))}
								selectedIndex={selectedIndex}
								startIndex={0}
								onSelect={setSelectedIndex}
								onActivate={activateRow}
							/>
							<PaletteSection
								title="Tools"
								rows={filteredTools.map(tool => ({ kind: "tool" as const, tool, disabled: true as const }))}
								selectedIndex={selectedIndex}
								startIndex={filteredCommands.length}
								onSelect={setSelectedIndex}
								onActivate={activateRow}
							/>
							{hasNoResults ? <div className="command-palette__state">No commands match</div> : null}
						</div>
					) : null}
				</div>
			</section>
		</div>
	);
}

function PaletteSection({
	title,
	rows,
	selectedIndex,
	startIndex,
	onSelect,
	onActivate,
}: {
	title: string;
	rows: PaletteRow[];
	selectedIndex: number;
	startIndex: number;
	onSelect(index: number): void;
	onActivate(row: PaletteRow): void;
}) {
	if (rows.length === 0) return null;
	return (
		<section className="command-palette__section" aria-label={title}>
			<h2>{title}</h2>
			<div className="command-palette__rows">
				{rows.map((row, offset) => {
					const index = startIndex + offset;
					return <PaletteRowView row={row} selected={index === selectedIndex} onSelect={() => onSelect(index)} onActivate={() => onActivate(row)} id={`command-palette-row-${index}`} key={row.kind === "command" ? `command-${row.command.name}` : `tool-${row.tool.name}`} />;
				})}
			</div>
		</section>
	);
}

function PaletteRowView({ row, selected, onSelect, onActivate, id }: { row: PaletteRow; selected: boolean; onSelect(): void; onActivate(): void; id: string }) {
	const commandBadge = row.kind === "command" ? classifyBadge(row.command.classification) : undefined;
	const action = row.kind === "command" ? commandAction(row.command) : undefined;
	const name = row.kind === "command" ? commandDisplayText(row.command) : row.tool.name;
	const meta = row.kind === "command" ? row.command.source : row.tool.active ? "active tool" : "inactive tool";
	const description = row.kind === "command" ? row.command.description : row.tool.description;
	const badge = row.kind === "command" ? action?.kind === "disabled" ? action.reason : commandBadge?.label : row.tool.active ? "active" : "inactive";

	return (
		<div
			id={id}
			role="option"
			className={`command-palette__row ${selected ? "command-palette__row--selected" : ""} ${row.disabled ? "command-palette__row--disabled" : ""}`}
			aria-selected={selected}
			aria-disabled={row.disabled}
			onMouseEnter={onSelect}
			onClick={onActivate}
		>
			<div className="command-palette__row-main">
				<strong>{name}</strong>
				<span>{meta}</span>
				{badge ? <em>{badge}</em> : null}
			</div>
			{description ? <p>{description}</p> : null}
		</div>
	);
}
