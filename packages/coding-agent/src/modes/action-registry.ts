import type { AppKeybinding } from "../config/keybindings";

export type FocusDomain = "composer" | "selector" | "overlay" | "global";

export interface ActionMetadata {
	id: AppKeybinding;
	title: string;
	category: string;
	bindingId?: AppKeybinding;
	domains: readonly FocusDomain[];
}

const action = (id: AppKeybinding, title: string, category: string, domains: FocusDomain[]): ActionMetadata => ({
	id,
	title,
	category,
	bindingId: id,
	domains,
});

export const APP_ACTION_METADATA: readonly ActionMetadata[] = [
	action("app.interrupt", "Interrupt", "Session", ["global"]),
	action("app.clear", "Clear", "Session", ["global"]),
	action("app.exit", "Exit", "Session", ["global"]),
	action("app.suspend", "Suspend", "Session", ["global"]),
	action("app.thinking.cycle", "Cycle thinking level", "Thinking", ["composer"]),
	action("app.thinking.toggle", "Toggle thinking", "Thinking", ["composer"]),
	action("app.commandPalette.open", "Open command palette", "Navigation", ["composer"]),
	action("app.model.cycleForward", "Next model", "Model", ["composer"]),
	action("app.model.cycleBackward", "Previous model", "Model", ["composer"]),
	action("app.model.select", "Select model", "Model", ["composer"]),
	action("app.model.selectTemporary", "Select temporary model", "Model", ["composer"]),
	action("app.tools.expand", "Toggle tool expansion", "Tools", ["composer"]),
	action("app.tool.backgroundFold", "Fold foreground tool", "Tools", ["composer"]),
	action("app.editor.external", "Open external editor", "Editor", ["composer"]),
	action("app.message.followUp", "Send follow-up", "Messages", ["composer"]),
	action("app.message.queue", "Queue message", "Messages", ["composer"]),
	action("app.message.dequeue", "Edit queued message", "Messages", ["composer"]),
	action("app.clipboard.pasteImage", "Paste image", "Clipboard", ["composer"]),
	action("app.clipboard.copyLine", "Copy line", "Clipboard", ["composer"]),
	action("app.clipboard.copyPrompt", "Copy prompt", "Clipboard", ["composer"]),
	action("app.session.new", "New session", "Session", ["composer"]),
	action("app.session.tree", "Session tree", "Session", ["composer"]),
	action("app.session.fork", "Fork session", "Session", ["composer"]),
	action("app.session.resume", "Resume session", "Session", ["composer"]),
	action("app.session.observe", "Observe sessions", "Session", ["composer"]),
	action("app.session.dashboard", "Show sessions dashboard", "Session", ["composer"]),
	action("app.jobs.open", "Open jobs", "Jobs", ["composer"]),
	action("app.session.togglePath", "Toggle session path", "Session", ["selector"]),
	action("app.session.toggleSort", "Toggle session sort", "Session", ["selector"]),
	action("app.session.rename", "Rename session", "Session", ["selector"]),
	action("app.session.delete", "Delete session", "Session", ["selector"]),
	action("app.session.deleteNoninvasive", "Delete selected session", "Session", ["selector"]),
	action("app.tree.foldOrUp", "Fold tree item", "Session", ["selector"]),
	action("app.tree.unfoldOrDown", "Unfold tree item", "Session", ["selector"]),
	action("app.plan.toggle", "Toggle plan mode", "Mode", ["composer"]),
	action("app.history.search", "Search history", "Navigation", ["composer"]),
	action("app.stt.toggle", "Toggle speech-to-text", "Speech", ["composer"]),
	action("app.irc.sidebar.toggle", "Toggle IRC sidebar", "IRC", ["composer"]),
	action("app.transcript.browse", "Browse transcript", "Transcript", ["composer"]),
	action("app.transcript.prevTurn", "Previous transcript turn", "Transcript", ["composer"]),
	action("app.transcript.nextTurn", "Next transcript turn", "Transcript", ["composer"]),
	action("app.mode.cycle", "Cycle mode", "Mode", ["composer"]),
	action("app.tasks.toggle", "Toggle tasks pane", "Jobs", ["composer"]),
	action("app.queue.togglePane", "Toggle queue pane", "Messages", ["composer"]),
	action("app.message.sendNow", "Send message now", "Messages", ["composer"]),
];

export interface ActionDefinition<Context> extends ActionMetadata {
	availability(context: Context): boolean;
	execute(context: Context): void | Promise<void>;
}

export interface ActionRegistryOptions<Context> {
	context: Context;
	showError(actionId: AppKeybinding): void;
}

export class ActionRegistry<Context> {
	readonly #actions = new Map<AppKeybinding, ActionDefinition<Context>>();
	readonly #busy = new Set<AppKeybinding>();

	constructor(private readonly options: ActionRegistryOptions<Context>) {}

	register(action: ActionDefinition<Context>): void {
		if (this.#actions.has(action.id)) throw new Error(`Action already registered: ${action.id}`);
		this.#actions.set(action.id, action);
	}

	get(id: AppKeybinding): ActionDefinition<Context> | undefined {
		return this.#actions.get(id);
	}
	all(): readonly ActionDefinition<Context>[] {
		return [...this.#actions.values()];
	}

	#reportError(id: AppKeybinding): void {
		try {
			this.options.showError(id);
		} catch {
			console.error(`Failed to report action error: ${id}`);
		}
	}

	isAvailable(id: AppKeybinding): boolean {
		try {
			return Boolean(this.#actions.get(id)?.availability(this.options.context));
		} catch {
			this.#reportError(id);
			return false;
		}
	}

	async execute(id: AppKeybinding): Promise<boolean> {
		const current = this.#actions.get(id);
		if (!current || this.#busy.has(id)) return false;
		this.#busy.add(id);
		try {
			if (!current.availability(this.options.context)) return false;
			await current.execute(this.options.context);
			return true;
		} catch {
			this.#reportError(id);
			return false;
		} finally {
			this.#busy.delete(id);
		}
	}
}
