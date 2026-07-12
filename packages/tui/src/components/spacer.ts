import type { Component } from "../tui";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	#lines: number;

	constructor(lines: number = 1) {
		this.#lines = lines;
	}

	setLines(lines: number): void {
		this.#lines = lines;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(_width: number): string[] {
		const result: string[] = [];
		for (let i = 0; i < this.#lines; i++) {
			result.push("");
		}
		return result;
	}

	getLogicalRowCount(_width: number): number {
		return this.#lines;
	}

	renderRows(_width: number, start: number, end: number): string[] {
		return Array.from({ length: Math.max(0, Math.min(this.#lines, end) - Math.max(0, start)) }, () => "");
	}
}
