import "./tokens.css";

export const brandTokens = {
	redClaw: "#f05404",
	blueCrab: "#5ab7d8",
	canvas: "#2b2622",
	surface: "#332e2a",
	text: "#f7f5f0",
} as const;

export type BrandTokenName = keyof typeof brandTokens;
