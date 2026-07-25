#!/usr/bin/env bash
set -euo pipefail

TARGET_BRANCH="${1:?target branch is required}"
REPAIR_ROOT="$(cd "${2:-../repair-source}" && pwd)"

export CI=1
git config user.name "twoimo"
git config user.email "32544727+twoimo@users.noreply.github.com"
git remote add upstream https://github.com/Yeachan-Heo/gajae-code.git 2>/dev/null || true
git fetch --no-tags upstream dev

capture_product_files() {
  local output="$1"
  git add -A
  git diff --cached --name-only > "$output"
  if [[ ! -s "$output" ]]; then
    echo "No product files were changed" >&2
    exit 1
  fi
  git reset
}

commit_captured_files() {
  local list="$1"
  local message="$2"
  mapfile -t product_files < "$list"
  git add -- "${product_files[@]}"
  git diff --cached --check
  git commit -m "$message"
}

build_native_for_tests() {
  bun --cwd=packages/natives run build
}

case "$TARGET_BRANCH" in
  successor/model-preset-default-action-current)
    git reset --hard upstream/dev
    git cherry-pick fcd0a24e98e711bf38ffd5b93f497029d48ee0f1

    python3 - <<'PY'
from pathlib import Path
path = Path('packages/coding-agent/test/model-selector-profiles-redteam.test.ts')
text = path.read_text()
text = text.replace(
    'const select = (selection: ModelSelectorSelection) => selections.push(selection);',
    'const select = (selection: ModelSelectorSelection): void => {\n\t\t\tselections.push(selection);\n\t\t};',
)
text = text.replace(
    'const renameSelector = createSelector(selection => renamed.push(selection));',
    'const renameSelector = createSelector(selection => {\n\t\t\trenamed.push(selection);\n\t\t});',
)
text = text.replace(
    'const deleteSelector = createSelector(selection => deleted.push(selection));',
    'const deleteSelector = createSelector(selection => {\n\t\t\tdeleted.push(selection);\n\t\t});',
)
path.write_text(text)
PY

    bun install --frozen-lockfile
    build_native_for_tests
    bunx biome check --write \
      packages/coding-agent/src/modes/components/model-selector.ts \
      packages/coding-agent/test/model-selector-profiles-redteam.test.ts
    bun test --timeout 30000 \
      packages/coding-agent/test/model-selector-profiles.test.ts \
      packages/coding-agent/test/model-selector-profiles-redteam.test.ts \
      packages/coding-agent/test/model-preset-landing-redteam-qa.test.ts \
      packages/coding-agent/test/cli-args-mpreset.test.ts
    bun --cwd=packages/coding-agent run check

    git reset --soft upstream/dev
    git restore --staged .
    git add \
      packages/coding-agent/CHANGELOG.md \
      packages/coding-agent/src/modes/components/model-selector.ts \
      packages/coding-agent/test/model-selector-profiles-redteam.test.ts
    git diff --cached --check
    git commit -m "feat(coding-agent): default preset selection to persistence"
    git push --force origin HEAD:"$TARGET_BRANCH"
    git push --force origin HEAD:verified/model-preset-default-action
    printf '%s\n' MODEL_SUCCESSOR_VERIFIED > /tmp/successor-result
    ;;

  successor/welcome-composer-gutter-current-v2)
    git reset --hard upstream/dev
    python3 "$REPAIR_ROOT/.github/repair/welcome-successor.py"
    bun install --frozen-lockfile
    build_native_for_tests
    bunx biome check --write \
      packages/coding-agent/src/modes/components/welcome.ts \
      packages/coding-agent/src/modes/interactive-mode.ts \
      packages/coding-agent/test/welcome-viewport.test.ts
    bun test --timeout 30000 packages/coding-agent/test/welcome-viewport.test.ts
    bun test --timeout 30000 packages/coding-agent/test/interactive-mode-editor-component.test.ts \
      --test-name-pattern 'welcome|viewport-bound|composer'
    bun --cwd=packages/coding-agent run check

    git add \
      packages/coding-agent/CHANGELOG.md \
      packages/coding-agent/src/modes/components/welcome.ts \
      packages/coding-agent/src/modes/interactive-mode.ts \
      packages/coding-agent/test/welcome-viewport.test.ts
    git diff --cached --check
    git commit -m "fix(coding-agent): align welcome and composer gutters"
    git push --force origin HEAD:"$TARGET_BRANCH"
    git push --force origin HEAD:verified/welcome-composer-gutter
    printf '%s\n' WELCOME_SUCCESSOR_VERIFIED > /tmp/successor-result
    ;;

  successor/malformed-settings-recovery-current)
    git fetch --no-tags origin backup/malformed-settings-e5f15e86
    git diff --binary \
      96f64a8e22eacf496742c87b0be2a38f1821ba91..origin/backup/malformed-settings-e5f15e86 \
      -- . \
      ':(exclude)packages/coding-agent/src/capability/index.ts' \
      ':(exclude)packages/coding-agent/src/session/agent-session.ts' \
      ':(exclude)packages/coding-agent/test/discovery/agent-discovery-disabled-providers.test.ts' \
      ':(exclude)packages/coding-agent/test/input-controller-keybindings.test.ts' \
      > /tmp/settings-successor.patch
    git reset --hard upstream/dev
    git apply --3way --index /tmp/settings-successor.patch
    test -z "$(git diff --name-only --diff-filter=U)"

    python3 "$REPAIR_ROOT/.github/repair/settings-successor.py"
    grep -F '#reasoningControlContextGeneration = 0;' \
      packages/coding-agent/src/session/agent-session.ts
    grep -F '#setAgentModelWithReasoningContext(model: Model): void' \
      packages/coding-agent/src/session/agent-session.ts
    git add -A
    test -z "$(git diff --name-only --diff-filter=U)"

    mapfile -t changed_ts < <(git diff --cached --name-only -- '*.ts' '*.tsx')
    if [[ ${#changed_ts[@]} -gt 0 ]]; then
      bunx biome check --write "${changed_ts[@]}"
      git add -- "${changed_ts[@]}"
    fi
    capture_product_files /tmp/settings-product-files

    bun install --frozen-lockfile
    build_native_for_tests
    bun test --timeout 30000 packages/coding-agent/test/modes/components/settings-selector-pet.test.ts
    bun test --timeout 30000 \
      packages/coding-agent/test/notifications-config.test.ts \
      packages/coding-agent/test/settings-manager.test.ts \
      packages/coding-agent/test/issue-775-repro.test.ts \
      packages/coding-agent/test/modes/components/settings-selector-memory-refresh.test.ts \
      packages/coding-agent/test/modes/components/settings-selector-pet.test.ts \
      packages/coding-agent/test/modes/components/thinking-selector.test.ts \
      packages/coding-agent/test/startup-update-contract.test.ts \
      packages/coding-agent/test/discovery/agent-discovery-disabled-providers.test.ts \
      packages/coding-agent/test/input-controller-keybindings.test.ts
    bun --cwd=packages/coding-agent run check
    bun --cwd=packages/coding-agent run build

    commit_captured_files /tmp/settings-product-files \
      "fix(coding-agent): harden malformed settings recovery"
    git push --force origin HEAD:"$TARGET_BRANCH"
    git push --force origin HEAD:verified/malformed-settings-recovery
    printf '%s\n' SETTINGS_SUCCESSOR_VERIFIED > /tmp/successor-result
    ;;

  fix/memory-guard-domain-scheduler)
    git fetch --no-tags origin feat/memory-guard-observability-dev
    git diff --binary \
      2a7f33d5566faa18c5512e1c8270658431445abd..origin/feat/memory-guard-observability-dev \
      -- . \
      ':(exclude).github/**' \
      ':(exclude)packages/coding-agent/CHANGELOG.md' \
      > /tmp/memory-successor.patch
    git reset --hard upstream/dev
    if ! git apply --3way --index /tmp/memory-successor.patch; then
      git diff --name-only --diff-filter=U | sort > /tmp/memory-conflicts.txt
      echo "Memory patch conflicts:" >&2
      cat /tmp/memory-conflicts.txt >&2
      git diff --cc >&2
      exit 1
    fi

    python3 "$REPAIR_ROOT/.github/repair/memory-guard-final.py"
    python3 - <<'PY'
from pathlib import Path
path = Path('packages/coding-agent/CHANGELOG.md')
text = path.read_text()
entry = '- Added cross-platform memory-pressure observability with effective host/cgroup limits, configurable GC and restart advisory thresholds, typed Linux process probes, and a Windows Job Object native probe; unsupported lifecycle actions remain advisory-only.\n'
if entry not in text:
    marker = '## [Unreleased]\n'
    if marker not in text:
        raise SystemExit('Unreleased changelog anchor missing')
    added = '### Added\n\n' + entry + '\n'
    text = text.replace(marker, marker + added, 1)
path.write_text(text)
PY

    bun install --frozen-lockfile
    build_native_for_tests
    cp packages/natives/native/index.d.ts /tmp/native-index.generated.d.ts
    cp packages/natives/native/index.js /tmp/native-index.generated.js
    bun packages/natives/scripts/gen-enums.ts
    cmp /tmp/native-index.generated.d.ts packages/natives/native/index.d.ts
    cmp /tmp/native-index.generated.js packages/natives/native/index.js
    grep -F "macOS computer-use controller." packages/natives/native/index.d.ts

    mapfile -t changed_ts < <({ git diff --cached --name-only -- '*.ts' '*.tsx'; git diff --name-only -- '*.ts' '*.tsx'; } | sort -u)
    if [[ ${#changed_ts[@]} -gt 0 ]]; then
      bunx biome check --write "${changed_ts[@]}"
      git add -- "${changed_ts[@]}"
    fi
    cargo fmt --all

    bun test --timeout 30000 \
      packages/coding-agent/test/runtime/memory-limit.test.ts \
      packages/coding-agent/test/runtime/memory-domain.test.ts \
      packages/coding-agent/test/runtime/memory-guard.test.ts \
      packages/coding-agent/test/tools/resource-gc.test.ts \
      packages/coding-agent/test/tools/resource-gc-redteam.test.ts \
      packages/coding-agent/test/gjc-runtime/linux-proc.test.ts \
      packages/coding-agent/test/cli-memory-guard-native-smoke.test.ts \
      packages/natives/test/memory-guard-native.test.ts \
      packages/natives/test/memory-guard-build-wiring.test.ts
    bun --cwd=packages/coding-agent run check
    bun run check:schemas
    cargo check -p pi-natives
    bun --cwd=packages/natives test

    rm -f packages/natives/native/*.node
    git add -A
    capture_product_files /tmp/memory-product-files
    commit_captured_files /tmp/memory-product-files \
      "feat(coding-agent): add coherent memory pressure observability"
    git commit --allow-empty -m "test(coding-agent): verify memory pressure successor"
    git push --force origin HEAD:"$TARGET_BRANCH"
    git push --force origin HEAD:verified/memory-guard-domain-scheduler
    printf '%s\n' MEMORY_SUCCESSOR_VERIFIED > /tmp/successor-result
    ;;

  *)
    echo "Unsupported successor branch: $TARGET_BRANCH" >&2
    exit 2
    ;;
esac
