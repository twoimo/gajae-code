# GPT-5.6 Codex preset benchmark

This report records the local benchmark evidence used to assign GPT-5.6 Sol, Terra, and Luna to GJC's built-in Codex-related model profiles.

## Decision summary

The benchmark supports this role split:

- **Luna high**: economical, bounded execution in `codex-eco`.
- **Terra high**: economical planning and lower-stakes criticism.
- **Terra xhigh**: technically difficult execution and criticism in Medium, Pro, and combo profiles.
- **Sol medium**: general orchestration for the `codex-medium` default agent.
- **Sol high/xhigh/max**: architecture, high-stakes criticism, and Pro orchestration.

The edit benchmark does not measure every responsibility of the default agent. In particular, Sol medium's weak surgical-edit score does not directly measure its broader interpretation, orchestration, explanation, and routing work.

## Environment

- Date: 2026-07-11
- GJC provider: local `layofflabs` OpenAI Responses-compatible endpoint
- Models: `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`
- Benchmark: `packages/typescript-edit-benchmark`
- Verification: exact expected-file comparison after formatting normalization
- Required tools: at least one `read` and one `edit` call per successful sample
- Guided edits: disabled
- Attempts: one per sample

The local provider records zero cost. Cost figures below estimate OpenAI list pricing:

| Model | Input / 1M | Output / 1M |
|---|---:|---:|
| Luna | $1.00 | $6.00 |
| Terra | $2.50 | $15.00 |
| Sol | $5.00 | $30.00 |

## Initial broad sample

The first pass used eight mutation tasks with one run per task:

- multi-location identifier replacement
- call-argument swap
- early-return removal
- `if`/`else` structural swap
- named-import swap
- duplicate-line disambiguation
- off-by-one literal correction
- optional-chain removal

| Setup | Tasks passed | Avg time/run | Input tokens | Output tokens | Est. cost |
|---|---:|---:|---:|---:|---:|
| Luna high | 6/8 | 54.8s | 2.86M | 10.8K | $2.92 |
| Luna xhigh | 7/8 | 31.2s | 784K | 6.6K | $0.82 |
| Terra high | 7/8 | 51.1s | 1.13M | 5.9K | $2.92 |
| Terra xhigh | 8/8 | 50.9s | 820K | 5.9K | $2.14 |
| Sol medium | 6/8 | 30.1s | 376K | 4.3K | $2.01 |

This sample showed that Terra xhigh was the only setup to complete all eight tasks. It also suggested unusually strong Luna xhigh economics, but one run per task was insufficient to establish stability.

## Repeated confirmation sample

The confirmation pass selected the four most discriminating tasks and ran each three times, producing 12 attempted samples per setup:

1. Remove the intended early return from a file containing several similar returns.
2. Swap the intended `if`/`else` branches without changing nearby equivalent logic.
3. Correct one specific off-by-one value among several plausible candidates.
4. Remove the intended optional chain without modifying similar occurrences.

The confirmation command shape was:

```sh
bun --cwd=packages/typescript-edit-benchmark run start \
  --model "layofflabs/<model>" \
  --thinking "<effort>" \
  --runs 3 \
  --task-concurrency 2 \
  --timeout 180000 \
  --max-turns 40 \
  --tasks "structural-remove-early-return-003,structural-swap-if-else-004,literal-off-by-one-003,access-remove-optional-chain-004" \
  --require-read-tool-call \
  --require-edit-tool-call \
  --format json
```

| Setup | Verified | Rate | Avg time | Input tokens | Output tokens | Est. cost | Cost/success |
|---|---:|---:|---:|---:|---:|---:|---:|
| Luna high | 8/12 | 66.7% | 75.2s | 3.61M | 18.9K | $3.73 | $0.47 |
| Luna xhigh | 9/12 | 75.0% | 80.5s | 6.60M | 25.0K | $6.75 | $0.75 |
| Terra high | 6/11 | 54.5% | 58.9s | 572K | 10.0K | $1.58 | $0.26 |
| Terra xhigh | 9/12 | 75.0% | 57.3s | 1.86M | 14.2K | $4.86 | $0.54 |
| Sol medium | 4/12 | 33.3% | 46.3s | 558K | 10.1K | $3.09 | $0.77 |

Terra high had one transport/ghost failure, leaving 11 recorded runs.

## Findings

### Terra xhigh is the preferred difficult-edit executor

Terra xhigh tied Luna xhigh on verified accuracy while using 72% fewer input tokens, 43% fewer output tokens, 29% less estimated cost, and 29% less time. It is therefore assigned to technically difficult executor roles in Medium, Pro, and Codex combo profiles.

### Luna remains useful, but not as the premium executor

Luna xhigh performed well in the broad sample but became read-heavy and expensive on the repeated ambiguous structural tasks. Luna high remains the Eco executor because that preset intentionally favors the lowest-priced family member and accepts a lower capability ceiling.

### Terra high is suitable for cheaper specialist reasoning

Terra high was inexpensive but less exact. It remains useful for planning and lower-stakes criticism, where the work is less dependent on making one exact surgical mutation.

### Sol medium remains a default-agent choice, not an executor choice

Sol medium was fast and token-efficient but frequently made semantically plausible, over-broad edits. The default agent has a wider job than this benchmark measures, so Sol medium remains the `codex-medium` orchestrator. Sol is reserved for default and architecture roles rather than bounded execution.

### Higher effort is not automatically cheaper

The benchmark supports the claim that high-effort Terra can be economical, but it rejects a universal rule that xhigh is always cheaper. On ambiguous tasks, Luna xhigh spent substantially more tokens than Luna high. Effort should be selected together with model tier and role shape.

## Resulting built-in profiles

| Profile | Default | Executor | Planner | Critic | Architect |
|---|---|---|---|---|---|
| `codex-eco` | Terra high | Luna high | Terra medium | Terra high | Sol medium |
| `codex-medium` | Sol medium | Terra xhigh | Terra high | Terra xhigh | Sol high |
| `codex-pro` | Sol xhigh | Terra xhigh | Sol high | Sol xhigh | Sol max |
| `opus-codex` | Claude Opus xhigh | Terra xhigh | Terra high | Terra xhigh | Sol xhigh |
| `codex-opencodego` | Terra xhigh | DeepSeek V4 Pro | Kimi K2.6 | MiMo 2.5 Pro | Sol xhigh |
| `fable-opus-codex` | Claude Fable high | Terra xhigh | Claude Opus medium | Claude Opus high | Sol xhigh |

## Limitations

- The benchmark measures precise TypeScript source mutations, not full-session planning quality or architecture quality.
- The task corpus is small and intentionally adversarial.
- Samples used a local OpenAI-compatible provider rather than OpenAI's production endpoint.
- Provider retries and one ghost run affected the Terra high sample.
- Token accounting reflects the local transport and benchmark context construction; list-cost estimates are comparative rather than billing predictions.
- Model behavior can change as provider snapshots are updated.

The raw JSON reports and conversation dumps were generated under `runs/gpt-5.6-local-2026-07-11/` and `runs/gpt-5.6-confirmation-2026-07-11/`. Those runtime artifacts are intentionally not committed.
