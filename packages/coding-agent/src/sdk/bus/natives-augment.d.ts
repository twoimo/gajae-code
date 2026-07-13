/**
 * Worktree-local module augmentation for the v3 SDK connection lane added to
 * the pi-natives NotificationServer in this branch (onSdkFrame / sendTo /
 * onConnectionClose). Linked sibling checkouts sharing the root node_modules
 * can dedupe `@gajae-code/natives` declarations by package ID to an older
 * generated file; this augmentation guarantees the new members are visible and
 * is a harmless re-declaration when the resolved declarations already have
 * them.
 */
import "@gajae-code/natives";

declare module "@gajae-code/natives" {
	interface SdkFrameEvent {
		connectionId: string;
		json: string;
	}
	interface NotificationServer {
		/** Register the raw v3 SDK frame callback. Must be called before start. */
		onSdkFrame(callback: (err: null | Error, frame: SdkFrameEvent) => void): void;
		/** Register the connection-close callback. Must be called before start. */
		onConnectionClose(callback: (err: null | Error, connectionId: string) => void): void;
		/** Directed send of a JSON text frame to one connection. */
		sendTo(connectionId: string, json: string): void;
	}
}
