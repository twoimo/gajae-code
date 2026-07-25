from pathlib import Path


def choose_ours(text: str) -> str:
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    index = 0
    while index < len(lines):
        if not lines[index].startswith("<<<<<<< "):
            out.append(lines[index])
            index += 1
            continue
        index += 1
        ours: list[str] = []
        while index < len(lines) and not lines[index].startswith("======="):
            ours.append(lines[index])
            index += 1
        if index >= len(lines):
            raise SystemExit("unterminated conflict before separator")
        index += 1
        while index < len(lines) and not lines[index].startswith(">>>>>>> "):
            index += 1
        if index >= len(lines):
            raise SystemExit("unterminated conflict after separator")
        index += 1
        out.extend(ours)
    return "".join(out)


capability_path = Path("packages/coding-agent/src/capability/index.ts")
capability = choose_ours(capability_path.read_text())
guard = '''function assertDisabledProvidersWritable(activeSettings: Settings): void {
\tif (activeSettings.canWriteDurableConfig()) return;
\tthrow new Error(
\t\t"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
\t);
}

'''
persist_anchor = "function persistDisabledProviders(activeSettings: Settings, providers: ReadonlySet<string>): void {"
if "function assertDisabledProvidersWritable(" not in capability:
    if persist_anchor not in capability:
        raise SystemExit("capability persist anchor missing")
    capability = capability.replace(persist_anchor, guard + persist_anchor, 1)
provider_anchor = '): void {\n\tconst providers = new Set(activeSettings.get("disabledProviders"));'
if capability.count(provider_anchor) != 2:
    raise SystemExit("capability provider mutation anchors changed")
capability = capability.replace(
    provider_anchor,
    '): void {\n\tassertDisabledProvidersWritable(activeSettings);\n\tconst providers = new Set(activeSettings.get("disabledProviders"));',
)
set_anchor = "): void {\n\tpersistDisabledProviders(activeSettings, new Set(providerIds));"
if set_anchor not in capability:
    raise SystemExit("capability set mutation anchor missing")
capability = capability.replace(
    set_anchor,
    "): void {\n\tassertDisabledProvidersWritable(activeSettings);\n\tpersistDisabledProviders(activeSettings, new Set(providerIds));",
    1,
)
capability_path.write_text(capability)

session_path = Path("packages/coding-agent/src/session/agent-session.ts")
session = choose_ours(session_path.read_text())
next_level_anchor = "\t\t\t\tthis.#thinkingLevel = nextThinkingLevel;"
next_level_guard = '''\t\t\t\tthis.#thinkingLevelMutationRevision++;
\t\t\t\tthis.#thinkingLevelLiveMutationRevision++;
\t\t\t\tthis.#pendingThinkingLevelControlSuccess = undefined;
\t\t\t\tthis.#pendingThinkingLevelControlFailure = undefined;
\t\t\t\tthis.#thinkingVisibilityLiveMutationRevision++;
\t\t\t\tthis.#pendingThinkingVisibilityControlSuccess = undefined;
\t\t\t\tthis.#pendingThinkingVisibilityControlFailure = undefined;
'''
if next_level_guard.strip() not in session:
    if session.count(next_level_anchor) != 1:
        raise SystemExit("switchSession next thinking anchor changed")
    session = session.replace(next_level_anchor, next_level_guard + next_level_anchor, 1)
session = session.replace(
    "\t\t\t\t\tthis.agent.setModel(previousModel);",
    "\t\t\t\t\tthis.#setAgentModelWithReasoningContext(previousModel);",
    1,
)
previous_level_anchor = "\t\t\t\tthis.#thinkingLevel = previousThinkingLevel;"
previous_level_guard = '''\t\t\t\tthis.#thinkingLevelMutationRevision++;
\t\t\t\tthis.#thinkingLevelLiveMutationRevision++;
\t\t\t\tthis.#pendingThinkingLevelControlSuccess = undefined;
\t\t\t\tthis.#pendingThinkingLevelControlFailure = undefined;
\t\t\t\tthis.#thinkingVisibilityLiveMutationRevision++;
\t\t\t\tthis.#pendingThinkingVisibilityControlSuccess = undefined;
\t\t\t\tthis.#pendingThinkingVisibilityControlFailure = undefined;
'''
if previous_level_guard.strip() not in session:
    if session.count(previous_level_anchor) != 1:
        raise SystemExit("switchSession rollback thinking anchor changed")
    session = session.replace(previous_level_anchor, previous_level_guard + previous_level_anchor, 1)
session_path.write_text(session)

discovery_path = Path("packages/coding-agent/test/discovery/agent-discovery-disabled-providers.test.ts")
discovery = choose_ours(discovery_path.read_text())
discovery = discovery.replace(
    'import { afterEach, beforeEach, describe, expect, test } from "bun:test";',
    'import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";',
    1,
)
discovery = discovery.replace(
    'import { disableProvider, enableProvider } from "../../src/capability";',
    '''import {
\tdisableProvider,
\tenableProvider,
\tgetDisabledProviders,
\tisProviderEnabled,
\tsetDisabledProviders,
} from "../../src/capability";''',
    1,
)
read_only_test = '''\ttest("rejects provider toggles before mutating session settings when config is read-only", () => {
\t\tconst readOnlySettings = Settings.isolated({ disabledProviders: ["already-disabled"] });
\t\tconst canWrite = vi.spyOn(readOnlySettings, "canWriteDurableConfig").mockReturnValue(false);
\t\ttry {
\t\t\texpect(() => disableProvider("new-provider", readOnlySettings)).toThrow("Repair config.yml");
\t\t\texpect(isProviderEnabled("new-provider", readOnlySettings)).toBe(true);
\t\t\texpect(() => enableProvider("already-disabled", readOnlySettings)).toThrow("Repair config.yml");
\t\t\texpect(isProviderEnabled("already-disabled", readOnlySettings)).toBe(false);
\t\t\texpect(() => setDisabledProviders(["replacement"], readOnlySettings)).toThrow("Repair config.yml");
\t\t\texpect(getDisabledProviders(readOnlySettings)).toEqual(["already-disabled"]);
\t\t} finally {
\t\t\tcanWrite.mockRestore();
\t\t}
\t});
'''
if "rejects provider toggles before mutating session settings when config is read-only" not in discovery:
    end = discovery.rfind("\n});")
    if end < 0:
        raise SystemExit("discovery describe terminator missing")
    discovery = discovery[:end] + "\n" + read_only_test + discovery[end:]
discovery_path.write_text(discovery)

input_path = Path("packages/coding-agent/test/input-controller-keybindings.test.ts")
input_test = choose_ours(input_path.read_text())
settings_import = 'import { resetSettingsForTest, Settings } from "../src/config/settings";\n'
if settings_import not in input_test:
    path_import = 'import * as path from "node:path";\n'
    if path_import not in input_test:
        raise SystemExit("input-controller path import missing")
    input_test = input_test.replace(path_import, path_import + settings_import, 1)
visibility_test = '''\tit("routes accepted thinking visibility changes through the session", async () => {
\t\tconst activeSettings = await Settings.init({ inMemory: true });
\t\tconst set = vi.spyOn(activeSettings, "set");
\t\tconst { InputController, ctx } = await createContext();
\t\tconst setThinkingVisibility = vi.fn();
\t\tconst session = ctx.session as unknown as { setThinkingVisibility: (visibility: "visible" | "hidden") => void };
\t\tsession.setThinkingVisibility = setThinkingVisibility;
\t\tctx.hideThinkingBlock = false;
\t\tctx.chatContainer = {
\t\t\tdetachChild: vi.fn(),
\t\t\taddChild: vi.fn(),
\t\t} as unknown as InteractiveModeContext["chatContainer"];
\t\tctx.rebuildChatFromMessages = vi.fn();
\t\ttry {
\t\t\tnew InputController(ctx).toggleThinkingBlockVisibility();
\t\t\texpect(set).toHaveBeenCalledWith("hideThinkingBlock", true);
\t\t\texpect(setThinkingVisibility).toHaveBeenCalledWith("hidden");
\t\t\texpect(set.mock.invocationCallOrder[0]).toBeLessThan(setThinkingVisibility.mock.invocationCallOrder[0]);
\t\t} finally {
\t\t\tset.mockRestore();
\t\t\tresetSettingsForTest();
\t\t}
\t});

'''
if "routes accepted thinking visibility changes through the session" not in input_test:
    marker = '\tit("registers the default IRC sidebar shortcut and consumes its dispatch", async () => {'
    if marker not in input_test:
        raise SystemExit("input-controller test insertion anchor missing")
    input_test = input_test.replace(marker, visibility_test + marker, 1)
input_path.write_text(input_test)

pet_path = Path("packages/coding-agent/test/modes/components/settings-selector-pet.test.ts")
pet = pet_path.read_text()
old_signature = "function makeComponent(petAvailable: boolean, callbacks: Record<string, unknown>): SettingsSelectorComponent {"
new_signature = '''function makeComponent(
\tpetAvailable: boolean,
\tcallbacks: Record<string, unknown>,
\tterminalEnv?: NodeJS.ProcessEnv,
): SettingsSelectorComponent {'''
if old_signature in pet:
    pet = pet.replace(old_signature, new_signature, 1)
if "\t\t\tterminalEnv," not in pet:
    pet = pet.replace("\t\t\tpetAvailable,\n", "\t\t\tpetAvailable,\n\t\t\tterminalEnv,\n", 1)
warning_test = 'it("shows the actionable unavailable warning inside the pet submenu", () => {'
warning_at = pet.find(warning_test)
if warning_at < 0:
    raise SystemExit("pet warning test missing")
next_test = pet.find("\n\tit(", warning_at + len(warning_test))
if next_test < 0:
    next_test = len(pet)
warning_block = pet[warning_at:next_test]
warning_block_new = warning_block.replace("makeComponent(false, {});", "makeComponent(false, {}, {});", 1)
if warning_block_new == warning_block and "makeComponent(false, {}, {})" not in warning_block:
    raise SystemExit("pet warning component anchor changed")
pet = pet[:warning_at] + warning_block_new + pet[next_test:]
pet_path.write_text(pet)

for path in (capability_path, session_path, discovery_path, input_path, pet_path):
    text = path.read_text()
    if "<<<<<<< " in text or "=======" in text or ">>>>>>> " in text:
        raise SystemExit(f"unresolved conflict marker in {path}")
