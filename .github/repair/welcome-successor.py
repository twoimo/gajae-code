from pathlib import Path

welcome_path = Path("packages/coding-agent/src/modes/components/welcome.ts")
welcome = welcome_path.read_text()
replacements = [
    (
        "\tchangelogMarkdown?: string;\n\tcollapseChangelog?: boolean;",
        "\tchangelogMarkdown?: string;\n\trightGutterWidth?: number;\n\tcollapseChangelog?: boolean;",
    ),
    (
        "\t\tconst boxWidth = Math.max(0, termWidth);",
        "\t\tconst rightGutterWidth = this.#rightGutterWidth(termWidth);\n\t\tconst boxWidth = Math.max(0, termWidth - rightGutterWidth);",
    ),
    (
        "\t\tif (outputRows === 1) {\n\t\t\treturn lines;\n\t\t}",
        "\t\tif (outputRows === 1) {\n\t\t\treturn this.#withRightGutter(lines, rightGutterWidth);\n\t\t}",
    ),
    (
        "\t\treturn lines;\n\t}\n\n\t/** Center text within a given width */",
        "\t\treturn this.#withRightGutter(lines, rightGutterWidth);\n\t}\n\n\t/** Center text within a given width */",
    ),
    (
        "\t#targetRows(termWidth: number): number | undefined {",
        """\t#rightGutterWidth(termWidth: number): number {
\t\tconst configured = this.options.rightGutterWidth ?? 0;
\t\tif (!Number.isFinite(configured) || configured <= 0) return 0;
\t\tconst gutterWidth = Math.floor(configured);
\t\treturn Math.min(gutterWidth, Math.max(0, termWidth - 4));
\t}

\t#withRightGutter(lines: string[], rightGutterWidth: number): string[] {
\t\tif (rightGutterWidth <= 0) return lines;
\t\tconst gutter = padding(rightGutterWidth);
\t\treturn lines.map(line => line + gutter);
\t}

\t#targetRows(termWidth: number): number | undefined {""",
    ),
]
for old, new in replacements:
    if old not in welcome:
        raise SystemExit(f"welcome anchor mismatch: {old[:80]}")
    welcome = welcome.replace(old, new, 1)
welcome_path.write_text(welcome)

mode_path = Path("packages/coding-agent/src/modes/interactive-mode.ts")
mode = mode_path.read_text()
replacements = [
    (
        "const WELCOME_RESERVED_CONTAINER_CHILD_LIMIT = 8;\n",
        "const WELCOME_RESERVED_CONTAINER_CHILD_LIMIT = 8;\nconst COMPOSER_RIGHT_GUTTER_WIDTH = 1;\n",
    ),
    (
        "\teditor.setRightGutterWidth(1);",
        "\teditor.setRightGutterWidth(COMPOSER_RIGHT_GUTTER_WIDTH);",
    ),
    (
        "\t\t\t\t\tchangelogMarkdown: this.#changelogMarkdown,\n\t\t\t\t\tcollapseChangelog:",
        "\t\t\t\t\tchangelogMarkdown: this.#changelogMarkdown,\n\t\t\t\t\trightGutterWidth: COMPOSER_RIGHT_GUTTER_WIDTH,\n\t\t\t\t\tcollapseChangelog:",
    ),
]
for old, new in replacements:
    if old not in mode:
        raise SystemExit(f"interactive-mode anchor mismatch: {old[:80]}")
    mode = mode.replace(old, new, 1)
mode_path.write_text(mode)

test_path = Path("packages/coding-agent/test/welcome-viewport.test.ts")
tests = test_path.read_text()
marker = '\tit("renders the build label from metadata instead of defaulting to dev", () => {'
regression = '''\tit("reserves the composer gutter for normal and one-row welcome layouts", () => {
\t\tconst normal = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
\t\t\trightGutterWidth: 1,
\t\t});
\t\tfor (const line of normal.render(100).map(stripRenderControls)) {
\t\t\texpect(visibleWidth(line)).toBe(100);
\t\t\texpect(line.endsWith(" ")).toBe(true);
\t\t\texpect(visibleWidth(line.trimEnd())).toBe(99);
\t\t}

\t\tconst constrained = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
\t\t\trightGutterWidth: 1,
\t\t\tgetViewportRows: () => 1,
\t\t\tgetReservedBottomRows: () => 0,
\t\t});
\t\tconst lines = constrained.render(100).map(stripRenderControls);
\t\texpect(lines).toHaveLength(1);
\t\texpect(visibleWidth(lines[0]!)).toBe(100);
\t\texpect(lines[0]!.endsWith(" ")).toBe(true);
\t\texpect(visibleWidth(lines[0]!.trimEnd())).toBe(99);
\t});

'''
if tests.count(marker) != 1:
    raise SystemExit("welcome test insertion anchor mismatch")
tests = tests.replace(marker, regression + marker, 1)
test_path.write_text(tests)

changelog_path = Path("packages/coding-agent/CHANGELOG.md")
changelog = changelog_path.read_text()
entry = "- Aligned the startup GJC Forge splash border with the composer trailing gutter, including the one-row constrained fallback.\n"
if entry not in changelog:
    anchor = "### Fixed\n\n"
    if anchor not in changelog:
        raise SystemExit("changelog Fixed anchor mismatch")
    changelog = changelog.replace(anchor, anchor + entry, 1)
changelog_path.write_text(changelog)
