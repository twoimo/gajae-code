from pathlib import Path

selector_path = Path("packages/coding-agent/src/modes/components/model-selector.ts")
selector = selector_path.read_text()
replacements = {
    'const PRESET_SCOPE_LABELS = ["Apply for this session", "Set as default"];':
        'const PRESET_SCOPE_LABELS = ["Set as default", "Apply for this session"];',
    'const CUSTOM_PRESET_SCOPE_LABELS = ["Apply for this session", "Set as default", "Rename", "Delete"];':
        'const CUSTOM_PRESET_SCOPE_LABELS = ["Set as default", "Apply for this session", "Rename", "Delete"];',
    'this.#listContainer.addChild(new Text(theme.fg("muted", "  Press Enter to apply this preset"), 0, 0));':
        'this.#listContainer.addChild(new Text(theme.fg("muted", "  Press Enter to choose an action"), 0, 0));',
    'setDefault: this.#presetScopeIndex === 1,': 'setDefault: this.#presetScopeIndex === 0,',
}
for old, new in replacements.items():
    if old in selector:
        selector = selector.replace(old, new, 1)
    elif new not in selector:
        raise SystemExit(f"model-selector anchor mismatch: {old}")
selector_path.write_text(selector)

test_path = Path("packages/coding-agent/test/model-selector-profiles-redteam.test.ts")
tests = test_path.read_text()
old = '''\ttest("profile actions wire Apply for this session to persistDefault false and Set as default to true", async () => {
\t\tconst selections: ModelSelectorSelection[] = [];
\t\tconst applySelector = createSelector(selection => {
\t\t\tselections.push(selection);
\t\t});
\t\tawait renderSelector(applySelector);
\t\tapplySelector.handleInput("\\x1b[C");
\t\tapplySelector.handleInput("\\x1b[B");
\t\tapplySelector.handleInput("\\n");
\t\tapplySelector.handleInput("\\n");
\t\tapplySelector.handleInput("\\n");

\t\tconst defaultSelector = createSelector(selection => {
\t\t\tselections.push(selection);
\t\t});
\t\tawait renderSelector(defaultSelector);
\t\tdefaultSelector.handleInput("\\x1b[C");
\t\tdefaultSelector.handleInput("\\x1b[B");
\t\tdefaultSelector.handleInput("\\n");
\t\tdefaultSelector.handleInput("\\n");
\t\tdefaultSelector.handleInput("\\x1b[B");
\t\tdefaultSelector.handleInput("\\n");

\t\texpect(selections).toEqual([
\t\t\t{ kind: "profile", profileName: "profile-a", setDefault: false },
\t\t\t{ kind: "profile", profileName: "profile-a", setDefault: true },
\t\t]);
\t});
'''
new = '''\ttest("profile actions default to persistence and retain session-only application", async () => {
\t\tconst selections: ModelSelectorSelection[] = [];
\t\tconst select = (selection: ModelSelectorSelection) => {
\t\t\tselections.push(selection);
\t\t};
\t\tconst persistentSelector = createSelector(select);
\t\tawait renderSelector(persistentSelector);
\t\tpersistentSelector.handleInput("\\x1b[C");
\t\tpersistentSelector.handleInput("\\x1b[B");
\t\tpersistentSelector.handleInput("\\n");
\t\tpersistentSelector.handleInput("\\n");

\t\tconst menu = normalizeRenderedText(persistentSelector.render(240).join("\\n"));
\t\texpect(menu).toContain("Set as default");
\t\texpect(menu).toContain("Apply for this session");
\t\tpersistentSelector.handleInput("\\n");

\t\tconst sessionSelector = createSelector(select);
\t\tawait renderSelector(sessionSelector);
\t\tsessionSelector.handleInput("\\x1b[C");
\t\tsessionSelector.handleInput("\\x1b[B");
\t\tsessionSelector.handleInput("\\n");
\t\tsessionSelector.handleInput("\\n");
\t\tsessionSelector.handleInput("\\x1b[B");
\t\tsessionSelector.handleInput("\\n");

\t\texpect(selections).toEqual([
\t\t\t{ kind: "profile", profileName: "profile-a", setDefault: true },
\t\t\t{ kind: "profile", profileName: "profile-a", setDefault: false },
\t\t]);
\t});

\ttest("custom profile action indices retain rename and delete", async () => {
\t\tconst renamed: ModelSelectorSelection[] = [];
\t\tconst renameSelector = createSelector(selection => renamed.push(selection));
\t\tawait renderSelector(renameSelector);
\t\trenameSelector.refreshPresetProfiles("profile-a");
\t\trenameSelector.handleInput("\\n");
\t\trenameSelector.handleInput("\\x1b[B");
\t\trenameSelector.handleInput("\\x1b[B");
\t\trenameSelector.handleInput("\\n");

\t\tconst deleted: ModelSelectorSelection[] = [];
\t\tconst deleteSelector = createSelector(selection => deleted.push(selection));
\t\tawait renderSelector(deleteSelector);
\t\tdeleteSelector.refreshPresetProfiles("profile-a");
\t\tdeleteSelector.handleInput("\\n");
\t\tdeleteSelector.handleInput("\\x1b[B");
\t\tdeleteSelector.handleInput("\\x1b[B");
\t\tdeleteSelector.handleInput("\\x1b[B");
\t\tdeleteSelector.handleInput("\\n");

\t\texpect(renamed).toEqual([{ kind: "renameProfile", profileName: "profile-a" }]);
\t\texpect(deleted).toEqual([{ kind: "deleteProfile", profileName: "profile-a" }]);
\t});
'''
if old in tests:
    tests = tests.replace(old, new, 1)
elif 'test("profile actions default to persistence and retain session-only application"' not in tests:
    raise SystemExit("model selector red-team anchor mismatch")
test_path.write_text(tests)

changelog_path = Path("packages/coding-agent/CHANGELOG.md")
changelog = changelog_path.read_text()
entry = "- `/model` preset selection now offers `Set as default` as the first action while retaining `Apply for this session`, custom preset rename, and delete actions.\n"
if entry not in changelog:
    anchor = "## [Unreleased]\n\n"
    if changelog.count(anchor) != 1:
        raise SystemExit("changelog Unreleased anchor mismatch")
    changelog = changelog.replace(anchor, anchor + "### Changed\n\n" + entry + "\n", 1)
    changelog_path.write_text(changelog)
