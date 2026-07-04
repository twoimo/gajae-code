# Gajae Code GUI Design System

## Provenance and branch

UI workflow branch: **G009 reference-faithful terminal shell**. This document is the first-party source of truth for the Gajae Code desktop GUI and component showcase. It translates the selected public reference analyses into a product UI that is warm, monospaced, hairline-delimited, and explicitly terminal-native.

Selected references loaded from `VoltAgent/awesome-design-md`:

- OpenCode AI — terminal-native identity, 100% monospace type, man-page-like sections, ASCII markers, 4px maximum radii, hairline bordered blocks, no shadows, no gradients, and no raised marketing cards.
- Warp — warm dark brown-charcoal canvas (`#2b2622` family), off-white as the quiet primary color, tight 3–4px radii, warm-tinted neutrals, and understated developer-tool controls.
- Cursor / Claude / VoltAgent — dark developer surfaces, clear agent/tool state grammar, restrained status colors, and compact conversational readability.

Brand palette remains grounded in GJC's red-claw mark. `#f05404` is reserved for the icon edge, focus/active rails, and destructive-adjacent emphasis. It is not a large CTA fill. Blue-crab is a secondary link/info accent only.

## Design principles

1. **Terminal-native shell, not chat-app chrome.** The app must feel closer to a durable TUI/man-page hybrid than a floaty consumer chat surface.
2. **Monospace-first identity.** All chrome, labels, metadata, buttons, thread rows, headings, body copy, and code use the same `ui-monospace` stack.
3. **Continuous frame.** Sidebar, transcript, header, and composer are one full-height shell divided by 1px warm hairlines. Avoid floating cards, glass, blur, gradients, shadows, and large gaps.
4. **Quiet primary action.** Primary buttons are off-white ink on warm charcoal, following Warp's subdued CTA model. Red-claw is a small signal, not a filled pill.
5. **State is labeled and inline.** Running, blocked, approval, error, disconnected, and selected states use text labels plus small dots/rails/borders. Color is never the only cue.
6. **Compact hierarchy.** Body runs 13–16px. Headers are mono labels; no product heading exceeds 20px. Thread titles are 14px or smaller and truncated.

## Tokens

### Color

All neutrals are warm-tinted. Text/background combinations must meet WCAG AA for normal UI text.

| Role | Hex | Use |
| --- | --- | --- |
| `--gjc-bg` | `#2b2622` | Warm dark app canvas; adapted from Warp warmth with GJC red-brown undertone. |
| `--gjc-bg-elevated` | `#302b27` | Sidebar, header, composer, and continuous shell bands. |
| `--gjc-surface` | `#332e2a` | Inline message/tool/approval blocks; flat, never raised. |
| `--gjc-surface-strong` | `#3a342f` | Selected row and user message emphasis. |
| `--gjc-border` | `#3f3a36` | Default 1px warm hairline divider. |
| `--gjc-border-strong` | `#57504a` | Active/focus-adjacent borders. |
| `--gjc-text` | `#f7f5f0` | Primary off-white ink and quiet primary button fill. |
| `--gjc-text-muted` | `#c9c0ad` | Secondary body and message copy. |
| `--gjc-text-dim` | `#948b80` | Metadata, labels, low-emphasis diagnostics. |
| `--gjc-red-claw` | `#f05404` | Brand mark edge, focus outline, selected rail, destructive-adjacent emphasis. No large fills. |
| `--gjc-red-claw-strong` | `#ff7a2f` | Small hover/focus accent where red is already present. |
| `--gjc-red-claw-deep` | `#9f2706` | Pressed/destructive small accents. |
| `--gjc-blue-crab` | `#5ab7d8` | Link/info/tool-running accent. |
| `--gjc-blue-crab-deep` | `#12363b` | Dark blue-crab support field when needed. |
| `--gjc-blue-crab-soft` | `#9fd8ea` | Inline blue text on warm dark. |
| `--gjc-success` | `#79c98d` | Connected/completed dot or border only. |
| `--gjc-warning` | `#d8b76a` | Approval pending/stale session dot or border only. |
| `--gjc-danger` | `#ff7b74` | Error/rejected/disconnected dot or border only. |
| `--gjc-info` | `#5ab7d8` | Alias for blue-crab information accent. |
| `--gjc-code-bg` | `#241f1c` | Terminal/code block field. |
| `--gjc-code-border` | `#3f3a36` | Code block hairline. |
| `--gjc-code-text` | `#f1ede4` | Terminal/code text. |
| `--gjc-code-comment` | `#a89f93` | Comments and elided output. |
| `--gjc-code-add` | `#79c98d` | Added diff/output success. |
| `--gjc-code-remove` | `#ff7b74` | Removed diff/output failure. |
| `--gjc-focus` | `#f05404` | 1px keyboard focus outline. |

Large chromatic fills are prohibited in v1. Red, blue, success, warning, and danger appear as dots, rails, labels, focus outlines, or hairline borders.

### Typography

- UI font: `ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace`.
- Code font: same stack via `--gjc-font-code`.
- No proportional sans-serif in app chrome.
- No display typography above 20px.

| Token | Size / line | Weight | Use |
| --- | --- | --- | --- |
| `shell-title` | 18 / 24 | 650 | Showcase-only top label; product app rarely needs this size. |
| `thread-title` | 13–14 / 20 | 650 | Active thread and sidebar row title; truncate with ellipsis. |
| `body` | 14 / 21 | 400 | Transcript and normal UI copy. |
| `body-strong` | 14 / 21 | 650 | Message author, row title, button text. |
| `caption` | 12 / 16 | 650 | Metadata, badges, mono-caps eyebrows. |
| `code` | 13 / 20 | 400 | Tool output and command snippets. |

CJK and mixed CJK/Latin copy must preserve line breaks. Use `overflow-wrap: anywhere` only for hashes, URLs, and generated IDs; normal prose uses `overflow-wrap: break-word` and `line-break: strict`.

### Spacing and density

Base spacing is 4px: `2`, `4`, `6`, `8`, `12`, `16`, `20`, `24`, `32`, `40`, `56`, `72`.

- Shell outer edge: no floaty page gutter; the app frame touches the viewport with a 1px border.
- Sidebar padding: 12px.
- Header padding: 12px vertical / 16px horizontal.
- Transcript gap: 8px between blocks; transcript content max width 920px.
- Composer padding: 12px; sticky to the bottom edge and connected to the frame.
- Thread rows: 8px padding, 4px internal gap.

### Radius, borders, depth

- `radius-xs: 2px` for micro affordances.
- `radius-sm: 3px` for buttons, inputs, thread rows, and badges.
- `radius-md: 4px` for blocks and composer.
- `radius-lg: 4px`; large radii are intentionally collapsed to the OpenCode/Warp 4px maximum.
- `radius-pill: 4px`; pill badges are squared off, not capsule-shaped.
- Borders are 1px solid warm hairlines by default.
- Shadows are disabled for app surfaces. Overlays may define their own future depth, but transcript/sidebar/composer do not use shadows.

### Motion

- Default transition: 120ms ease-out for color/background/border only.
- Streaming pulse: opacity-only caret; never moves layout.
- Loading shimmer remains subtle and is disabled under `prefers-reduced-motion`.

### Focus and interaction

- Every interactive component exposes `:focus-visible` with a 1px red-claw outline and 2px offset.
- Hover changes surface or border only.
- Selected/current state includes a red-claw rail, label, or explicit text state.
- Hit targets: 32px minimum for dense controls.

## Layout grammar

### App shell

The desktop GUI has two durable columns inside one continuous terminal shell:

1. **Sidebar / thread list** — 232–300px. Contains brand mark, new-thread action, thread list, loading/empty state, and model/connection footer. It is full height on desktop and separated by a 1px right border.
2. **Transcript workspace** — flexible column. Header, transcript, and composer share the same warm canvas. Header is a 1px bottom-delimited bar; composer is sticky and attached to the bottom with a hairline border.

No region floats above the canvas. No backdrop blur, radial lighting, shadowed cards, large card gutters, or rounded panel islands.

### Thread title and identity

- Product header title is a single-line 14px monospace label.
- Sidebar thread titles are single-line 13px labels.
- Generated UUID/session labels must be humanized to `Thread 019f27…b61a` style or replaced by a first-message excerpt.
- Titles truncate with ellipsis and never wrap into a giant headline.

### Transcript rhythm

- Assistant messages are flat bordered terminal blocks on the canvas.
- User messages use the same block grammar with a small red-claw left rail.
- Streaming messages show a labeled live region and a small opacity-pulsing caret.
- Long content uses code blocks with internal scrolling.
- Empty transcript is a flat dashed block with one quiet primary action.

### Sidebar / thread list

- Rows contain title and metadata only; status is represented by label/dot/rail.
- Current row uses a red-claw rail plus stronger warm surface.
- Unread uses a small `[new]` label.
- Error uses danger rail/border; the whole row never turns red.

### Tool and approval cards

Tool cards follow a terminal block model:

- Header: tool name, status chip, elapsed/detail metadata.
- Body: command/arguments summary or monospace output.
- Running: blue-crab border/chip, not a final success color.
- Success: success chip/border only; output remains neutral.
- Error: danger chip/border with concise error text.

Approval gates are high-friction inline blocks:

- Warning border and explicit `Approval gate · state` eyebrow.
- Clear requested action, risk summary, exact choices.
- Approval button is off-white unless the action is explicitly destructive; red-claw remains focus/rail emphasis.
- Keyboard order: details, approve, reject, copy/details.

### Model/session status

- Model badge is a compact squared label with a 7px status dot.
- Connected uses success dot; reconnecting/degraded uses warning; disconnected uses danger; offline uses dim text.
- Session status appears in sidebar and composer/header contexts.

### Empty, loading, error

- Empty: flat dashed border, concise copy, no fake transcript messages.
- Loading: subdued warm skeleton rows.
- Connection error: persistent flat panel with cause, retry, and safe diagnostics. Tokens are never displayed.
- Permission/approval failure remains inline at the blocked point in transcript.

### Responsive behavior

- `<760px`: sidebar stacks above transcript and loses the right border; header and composer footer stack.
- `760–1180px`: standard two-column shell; showcase grid becomes one column when needed.
- `>1180px`: sidebar 300px and showcase grid can use two columns.
- Minimum supported content width is 360px. Page-level horizontal scroll is prohibited; code/tool output may scroll internally.

## Component state rules

- **Message:** `user`, `assistant`, `streaming`, `interrupted`, long content. Must support copied code, CJK/mixed text, and interrupted streams.
- **Tool card:** `running`, `success`, `error`; status chip text is required.
- **Approval gate:** `pending`, `focused`, `approved`, `rejected`; pending must be distinct from ordinary warning copy.
- **Composer:** `idle`, `focused`, `multiline`, `disabled/disconnected`, `submitting/stoppable`. Submit and stop are mutually exclusive.
- **Thread list:** `default`, `hover`, `selected`, `unread`, `error`, `empty`, `loading`.
- **Model badge:** `connected`, `reconnecting`, `disconnected`, `degraded`, `offline`.
- **Connection error:** visible cause, retry control, diagnostics; never expose secrets.
- **Focus states:** showcase includes keyboard-visible focus examples for thread action, tool action, approval button, and composer.

## Implementation contract

- `packages/gjc-gui/src/design-tokens` owns the CSS custom properties listed here.
- `packages/gjc-gui/src/app/styles.css` and `packages/gjc-gui/src/showcase/showcase.css` implement the same warm mono shell grammar.
- `packages/gjc-gui/src/app/main.tsx` may alter presentation labels only; client logic, transport, and protocol contracts remain untouched.
- Product screens import shared tokens/classes rather than redefining colors locally.
- Future visual QA must capture showcase states at mobile/tablet/desktop widths, scrollable transcript top/middle/bottom, and CJK/mixed wrapping.
