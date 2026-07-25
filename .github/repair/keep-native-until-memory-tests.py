from pathlib import Path

path = Path(".github/repair/run-successor-verification.sh")
text = path.read_text()
old = '''    grep -F "macOS computer-use controller." packages/natives/native/index.d.ts
    rm -f packages/natives/native/*.node

    mapfile -t changed_ts < <({ git diff --cached --name-only -- '*.ts' '*.tsx'; git diff --name-only -- '*.ts' '*.tsx'; } | sort -u)
    if [[ ${#changed_ts[@]} -gt 0 ]]; then
      bunx biome check --write "${changed_ts[@]}"
      git add -- "${changed_ts[@]}"
    fi
    cargo fmt --all
    git add -A
    capture_product_files /tmp/memory-product-files

    bun test --timeout 30000 \\
      packages/coding-agent/test/runtime/memory-limit.test.ts \\
      packages/coding-agent/test/runtime/memory-domain.test.ts \\
      packages/coding-agent/test/runtime/memory-guard.test.ts \\
      packages/coding-agent/test/tools/resource-gc.test.ts \\
      packages/coding-agent/test/tools/resource-gc-redteam.test.ts \\
      packages/coding-agent/test/gjc-runtime/linux-proc.test.ts \\
      packages/coding-agent/test/cli-memory-guard-native-smoke.test.ts \\
      packages/natives/test/memory-guard-native.test.ts \\
      packages/natives/test/memory-guard-build-wiring.test.ts
    bun --cwd=packages/coding-agent run check
    bun run check:schemas
    cargo check -p pi-natives
    bun --cwd=packages/natives test

    commit_captured_files /tmp/memory-product-files \\
'''
new = '''    grep -F "macOS computer-use controller." packages/natives/native/index.d.ts

    mapfile -t changed_ts < <({ git diff --cached --name-only -- '*.ts' '*.tsx'; git diff --name-only -- '*.ts' '*.tsx'; } | sort -u)
    if [[ ${#changed_ts[@]} -gt 0 ]]; then
      bunx biome check --write "${changed_ts[@]}"
      git add -- "${changed_ts[@]}"
    fi
    cargo fmt --all

    bun test --timeout 30000 \\
      packages/coding-agent/test/runtime/memory-limit.test.ts \\
      packages/coding-agent/test/runtime/memory-domain.test.ts \\
      packages/coding-agent/test/runtime/memory-guard.test.ts \\
      packages/coding-agent/test/tools/resource-gc.test.ts \\
      packages/coding-agent/test/tools/resource-gc-redteam.test.ts \\
      packages/coding-agent/test/gjc-runtime/linux-proc.test.ts \\
      packages/coding-agent/test/cli-memory-guard-native-smoke.test.ts \\
      packages/natives/test/memory-guard-native.test.ts \\
      packages/natives/test/memory-guard-build-wiring.test.ts
    bun --cwd=packages/coding-agent run check
    bun run check:schemas
    cargo check -p pi-natives
    bun --cwd=packages/natives test

    rm -f packages/natives/native/*.node
    git add -A
    capture_product_files /tmp/memory-product-files
    commit_captured_files /tmp/memory-product-files \\
'''
if old not in text:
    raise SystemExit("memory native lifecycle anchor missing")
path.write_text(text.replace(old, new, 1))
