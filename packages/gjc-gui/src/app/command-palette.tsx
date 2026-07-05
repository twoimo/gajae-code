import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
	classifyBadge,
	commandInsertText,
	fuzzyFilter,
	resolveClassification,
	type PaletteCommand,
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
};

type PaletteRow =
	| { kind: "command"; command: PaletteCommand; disabled: boolean }
	| { kind: "tool"; tool: PaletteTool; disabled: true };

export function CommandPalette({ open, commands, tools, loading, error, onClose, onInsert }: CommandPaletteProps) {
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
				disabled: classifyBadge(resolveClassification(command)).disabled,
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

	if (!open) return null;

	function moveSelection(delta: number) {
		if (rows.length === 0) return;
		setSelectedIndex(current => (current + delta + rows.length) % rows.length);
	}

	function activateSelection() {
		const row = rows[selectedIndex];
		if (!row || row.disabled || row.kind !== "command") return;
		onInsert(commandInsertText(row.command));
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
			moveSelection(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			moveSelection(-1);
			return;
		}
		if (event.key === "Enter") {
			if (event.nativeEvent.isComposing || event.keyCode === 229) return;
			event.preventDefault();
			activateSelection();
		}
	}

	const hasNoResults = !loading && !error && rows.length === 0;
	const activeDescendant = rows[selectedIndex] ? `command-palette-row-${selectedIndex}` : undefined;

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
								rows={filteredCommands.map(command => ({ kind: "command" as const, command, disabled: classifyBadge(resolveClassification(command)).disabled }))}
								selectedIndex={selectedIndex}
								startIndex={0}
								onSelect={setSelectedIndex}
							/>
							<PaletteSection
								title="Tools"
								rows={filteredTools.map(tool => ({ kind: "tool" as const, tool, disabled: true as const }))}
								selectedIndex={selectedIndex}
								startIndex={filteredCommands.length}
								onSelect={setSelectedIndex}
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
}: {
	title: string;
	rows: PaletteRow[];
	selectedIndex: number;
	startIndex: number;
	onSelect(index: number): void;
}) {
	if (rows.length === 0) return null;
	return (
		<section className="command-palette__section" aria-label={title}>
			<h2>{title}</h2>
			<div className="command-palette__rows">
				{rows.map((row, offset) => {
					const index = startIndex + offset;
					return <PaletteRowView row={row} selected={index === selectedIndex} onSelect={() => onSelect(index)} id={`command-palette-row-${index}`} key={row.kind === "command" ? `command-${row.command.name}` : `tool-${row.tool.name}`} />;
				})}
			</div>
		</section>
	);
}

function PaletteRowView({ row, selected, onSelect, id }: { row: PaletteRow; selected: boolean; onSelect(): void; id: string }) {
	const commandBadge = row.kind === "command" ? classifyBadge(resolveClassification(row.command)) : undefined;
	const name = row.kind === "command" ? `/${row.command.name}` : row.tool.name;
	const meta = row.kind === "command" ? row.command.source : row.tool.active ? "active tool" : "inactive tool";
	const description = row.kind === "command" ? row.command.description : row.tool.description;
	const badge = row.kind === "command" ? commandBadge?.label : row.tool.active ? "active" : "inactive";

	return (
		<div
			id={id}
			role="option"
			className={`command-palette__row ${selected ? "command-palette__row--selected" : ""} ${row.disabled ? "command-palette__row--disabled" : ""}`}
			aria-selected={selected}
			aria-disabled={row.disabled}
			onMouseEnter={onSelect}
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
