import { describe, expect, test } from "bun:test";

const tokenPairs = [
	["primary text on app background", "#f7f5f0", "#2b2622", 4.5],
	["muted text on elevated background", "#c9c0ad", "#302b27", 4.5],
	["dim text on surface", "#a89f93", "#332e2a", 4.5],
	["danger text on app background", "#ff7b74", "#2b2622", 4.5],
	["warning text on app background", "#d8b76a", "#2b2622", 4.5],
	["success text on app background", "#79c98d", "#2b2622", 4.5],
	["info text on app background", "#5ab7d8", "#2b2622", 4.5],
	["code text on code background", "#f1ede4", "#241f1c", 4.5],
	["code comment on code background", "#a89f93", "#241f1c", 4.5],
	["primary action text on light fill", "#2b2622", "#f7f5f0", 4.5],
	["focus/red UI component on app background", "#f05404", "#2b2622", 3],
	["danger small-text label on surface", "#ff7b74", "#332e2a", 4.5],
	["danger small-text label on elevated background", "#ff7b74", "#302b27", 4.5],
] as const;

function luminance(hex: string): number {
	const channels = hex
		.slice(1)
		.match(/.{2}/g)
		?.map(channel => Number.parseInt(channel, 16) / 255);
	if (channels?.length !== 3) throw new Error(`Invalid hex color: ${hex}`);
	const [red, green, blue] = channels.map(value =>
		value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
	const lighter = Math.max(luminance(foreground), luminance(background));
	const darker = Math.min(luminance(foreground), luminance(background));
	return (lighter + 0.05) / (darker + 0.05);
}

describe("GJC GUI accessibility contrast", () => {
	test("design-token text and UI pairs meet WCAG AA thresholds", () => {
		const checked = tokenPairs.map(([label, foreground, background, minimum]) => ({
			label,
			ratio: Number(contrastRatio(foreground, background).toFixed(2)),
			minimum,
		}));

		expect(checked).toEqual([
			{ label: "primary text on app background", ratio: 13.74, minimum: 4.5 },
			{ label: "muted text on elevated background", ratio: 7.75, minimum: 4.5 },
			{ label: "dim text on surface", ratio: 5.14, minimum: 4.5 },
			{ label: "danger text on app background", ratio: 5.94, minimum: 4.5 },
			{ label: "warning text on app background", ratio: 7.77, minimum: 4.5 },
			{ label: "success text on app background", ratio: 7.52, minimum: 4.5 },
			{ label: "info text on app background", ratio: 6.56, minimum: 4.5 },
			{ label: "code text on code background", ratio: 13.96, minimum: 4.5 },
			{ label: "code comment on code background", ratio: 6.25, minimum: 4.5 },
			{ label: "primary action text on light fill", ratio: 13.74, minimum: 4.5 },
			{ label: "focus/red UI component on app background", ratio: 4.26, minimum: 3 },
			{ label: "danger small-text label on surface", ratio: 5.33, minimum: 4.5 },
			{ label: "danger small-text label on elevated background", ratio: 5.56, minimum: 4.5 },
		]);
		for (const pair of checked) expect(pair.ratio).toBeGreaterThanOrEqual(pair.minimum);
	});
});
