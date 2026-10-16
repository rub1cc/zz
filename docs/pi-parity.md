# zz vs native Pi: parity audit

Compared against the installed `@earendil-works/pi-coding-agent` **1.3.0**, not a future/latest release. This is a source/documentation audit, not a live-provider certification. Native references below are files inside that installed package. Priorities are suggested follow-up work, not implemented commitments.

## Authentication: now implemented

- `/login [provider]` and `/logout [provider]` work from the dashboard and open sessions; `/` discovery and `/help` include them.
- Searchable provider/method selection, stored/ambient status labels, provider-owned API-key and OAuth flows, text/secret/select/manual-code prompts, browser URLs, device codes, progress/info messages, and cancellation.
- Secret entry is masked. Authentication responses never enter the task composer, conversation history, or zz state/database. Persistence, refresh-token rotation, and cross-process credential locking remain Pi's responsibility.
- Shared Pi `auth.json`; stable device ID comes from Pi's settings. Login explicitly refreshes the selected provider's model catalog, including network-only catalogs. Refresh failures retain saved credentials and explain the cached-model fallback.
- If new-task defaults have no model, zz selects the first available chat model for the authenticated provider. Existing models/sessions are not silently switched. `/model` lets the user choose explicitly, without restarting.
- Logout requires confirmation, includes orphaned credentials from providers no longer registered, and warns that it also changes Pi. It removes stored credentials, **not** environment/config authentication or access at the provider. It does not abort work already in flight.
- Credential persistence errors and credentials-changed/model-synchronization errors are distinguished. Closing the dialog or quitting aborts pending login interaction; cancellation cannot undo a credential mutation already committed.

### Remaining native-auth differences

| Native Pi 1.3.0 | zz |
|---|---|
| Top-level account/API-key menu, then providers | One searchable provider + method list |
| Automatically opens OAuth authorization URLs | Displays a clickable URL; **Ctrl+O** opens it and **Ctrl+X** copies it (also works with device-code URLs) |
| Provider argument completion; cancellation returns to earlier login menus | Provider ID/name accepted, but no argument completion; Escape closes the flow, rerun `/login` to retry |
| Selects its known provider default when there is no model | Selects first available provider chat model only when new-task defaults are absent; use `/model` to change it |
| Refreshes catalogs at interactive startup, `/model`, and after login | Explicit network refresh after login; startup and `/model` otherwise use the runtime/cache without network catalog refresh |
| Radius MCP setup offer, llama.cpp connection/model management through built-in extensions, Anthropic extra-usage warning | No built-in extension host: no Radius MCP setup offer, `/llama`, or native extra-usage warning. Provider login alone does not supply those features |

Evidence: zz [`auth.ts`](../src/auth.ts), [`auth-dialog.ts`](../src/auth-dialog.ts), [`pi.ts`](../src/pi.ts), [`controller.ts`](../src/controller.ts); native `docs/providers.md`, `docs/slash-commands.md`, `dist/modes/interactive/interactive-mode.js`.

## Instructions, images and thinking: now implemented

- Automatic per-project instruction loading uses Pi's context resolver for user/ancestor/project `AGENTS.override.md`, `AGENTS.md`/`CLAUDE.md` variants and linked-worktree rules. Project `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md` take precedence over user-level equivalents. Files refresh before each model request. A custom preamble does not remove zz's operational `ask_user` policy.
- The trust boundary is explicit: selecting/launching a project opts its Markdown and ancestor instructions into model context, consistent with zz's existing skill policy. There is still no interactive native `/trust` UI, extension execution, or sandbox.
- Explicit `@image` references, clipboard images/copied image files, and pasted/dragged image paths produce real image content. Backspace with empty draft text removes the last staged image; no attachment slash commands are needed. Pi's worker image processor handles resizing/orientation/conversion, and prepared bytes survive queueing and restart. Inline terminal images have readable fallbacks; image results from `read` are retained and displayed too.
- Thinking blocks now survive final/streaming message projection, can be collapsed/expanded, and have a persisted **Show reasoning** visibility toggle in `/settings`. Provider-redacted content and opaque signatures are not exposed in the display cache. Ctrl+T still opens zz's thinking-level picker rather than adopting native Pi's visibility shortcut.

Remaining attachment differences: no CLI `@file` invocation/print mode, automatic text-file attachment expansion, native image/settings UI, WSL-specific Windows clipboard fallback, or guaranteed animated-image playback. Draft attachments are memory-only until sent. Clipboard helpers and physical inline-image placement still need manual verification on each target terminal/OS.

Evidence: [`instructions.ts`](../src/instructions.ts), [`attachments.ts`](../src/attachments.ts), [`image-display.ts`](../src/image-display.ts), [`composer.ts`](../src/composer.ts), [`engine.ts`](../src/engine.ts), [`transcript.ts`](../src/transcript.ts).

## Auto-compaction: now configurable

- `/settings` exposes the durable SDK's enabled flag, answer reserve, recent-context retention, and background lead in tokens. The defaults still come from the installed SDK.
- Values persist globally in zz and feed the harness's live policy, including existing and restored sessions. Thresholds are shown for the current/default model; these are estimates, not a percentage guarantee.
- Off disables threshold compaction and overflow recovery, not manual `/compact` or compactions already in progress. A zero background lead disables only background compaction. Reserve/recent-context budgets also apply to manual compaction.
- Native Pi's compaction settings are neither imported nor overwritten. There is no second summarization pipeline or per-session policy override.

Evidence: [`compaction-settings.ts`](../src/compaction-settings.ts), [`settings-page.ts`](../src/settings-page.ts), [`store.ts`](../src/store.ts), [`engine.ts`](../src/engine.ts). Offline tests cover numeric validation, save rollback, narrow terminals, live changes during requests, custom/background-disabled thresholds, overflow toggling, manual compaction budgets, and restoration.

## Highest-impact gaps

| Priority | Capability | Native Pi | Current zz / consequence | Likely implementation layer |
|---|---|---|---|---|
| P1 | Extensions, MCP, custom tools/providers | Extension host; built-in MCP, codemode, tool search and llama.cpp extensions; custom commands, hooks, providers, UI | zz does **not** execute coding-agent extensions or load `mcp.json`. A skill being discovered from a package does not mean that package's extensions/tools/providers work | Substantial adapter/host work; durable registry can host tools, but coding-agent extensions are not drop-in |
| P1 | Session interchange/recovery UX | `/tree`, `/fork`, `/clone`, `/import`, JSONL history and branch navigation | Separate durable SQLite history; no native JSONL import, tree, fork/clone UI, redo or abandoned-branch picker. `/undo` provides tracked-file + conversation checkpoints, **not** native tree navigation | zz UI/storage adapters over durable conversation/history APIs; format conversion for JSONL |
| P2 | Export/share | `/export` HTML/JSONL, `/share` | `/copy [N]` now copies assistant and local shell output, but there is no session export or sharing. Terminal selection is not a session export; `/export` currently becomes ordinary task text | zz commands + serializers; explicit review/consent for upload |
| P2 | Runtime settings parity | Trust, tool allowlists, retry/network/transport/cache warming, shell, compaction thresholds, themes/keybindings, etc. | Pi's saved startup model/thinking and skill discovery settings are reused; most native settings are **not applied**. zz has its own settings page, including a live global auto-compaction toggle and reserve/recent-context/background token budgets, saved independently of Pi | Selective settings translation, not copying settings.json blindly |

## Other workflow differences

- **New/resume/name:** dashboard typing creates a new session, Enter opens one, and restart restores durable work. No `/new`, `/resume`, `/name`, CLI `--continue`/`--session`, manual rename or searchable cross-project resume picker. These are partly alternate UX, not missing persistence.
- **Model controls:** `/model`, `/thinking`, Shift+Tab and session/default selection exist. No `/model provider/id` or `/thinking level` direct arguments, `/scoped-models`, scoped model cycling, fuzzy CLI model shorthand, `--api-key`, or `--list-models`. Typing an unsupported argument form may become ordinary task text.
- **Resource reload/templates:** instruction Markdown refreshes before every model request; `/skills` refreshes its project's skill catalog and explicit `/skill:name` works. No prompt templates, native extension commands, `/reload`, themes or keybinding reload. Skill discovery intentionally skips package installation and extension execution.
- **Shell shortcuts/tools:** user `!command` runs immediately and streams a bounded local response inline in the selected/open session or existing peek. From a project heading it creates a local session without starting an agent. Command/output history persists in state.json and participates in `/copy`, but is never sent to the model or replayed as commands after restart. Native Pi's `!` context inclusion and separate `!!` mode are not provided. Agent `read`, `write`, `edit`, `bash`, and zz's `ask_user` exist; there is still no configurable tool allowlist, optional native `grep`/`find`/`ls`, or codemode/tool-search adapter.
- **Queue editing:** persisted steering/follow-ups, a global delivery-mode preference, cancellation and restart recovery exist. No per-send native Alt+Enter alternative or Alt+Up recall/edit of queued messages. Stopping withdraws queued inputs rather than returning them to the composer.
- **CLI/automation:** zz requires a TTY and accepts only a project path, model, thinking and data-directory options. No print, piped-input, JSON event stream, RPC mode, package-management/auth diagnostic subcommands or native SDK-compatible session interface.
- **Diagnostics/display:** `/help`, tool expansion, follow-end scrolling, context/cost statistics and compaction cards exist. No native `/hotkeys`, `/debug`, `/bug`, `/changelog`, regular-scrollback mode, or comprehensive terminal/theme settings. Ctrl+T chooses thinking level in zz; in native Pi it toggles thinking visibility.
- **Trust/security:** neither application is a sandbox. Native Pi resolves project trust before loading project resources. zz opts selected-project and ancestor Markdown instructions, plus skills/package discovery, into context without loading executable extensions; there is no `/trust` decision UI. An executable extension bridge still needs a deliberate trust policy.
- **Unknown commands:** zz recognizes its own command set and `/skill:name`; most other slash-prefixed input is ordinary prompt text. Missing native commands should not be tried on the assumption they are implemented. A fail-safe unknown-command notice is a useful follow-up before expanding parity.

## Capabilities already present / intentionally different

Shared provider configuration and token refresh, model/thinking pickers, automatic instructions, explicit skill loading, image attachments/display, thinking blocks, external editor, prompt history, `/copy [N]` for assistant and local shell responses, local `!command` execution, tool activity, steering/follow-up queues, stop, automatic/manual compaction, usage/cost estimates and persistent conversations are present. Their storage and keyboard semantics are not identical to native Pi.

zz additionally supplies multi-project grouping, concurrently running durable conversations, peek/reply, and checkpoint-based tracked-file undo. Native Pi's single-session interaction and JSONL tree are not the architecture zz is wrapping; importing an interactive Pi component would not make the entire native feature set appear.

## Suggested next order

1. Fail-safe command handling, manual rename and export.
2. Branch/fork navigation and JSONL import/export, with explicit durable/native format semantics.
3. Scope an extension/MCP bridge separately; avoid executing arbitrary Pi extensions merely to obtain one feature.

## Evidence and verification

zz entry points: [`engine.ts`](../src/engine.ts) (`open`, `applyView`, `listModels`), [`ui.ts`](../src/ui.ts) (command dispatch), [`discovery.ts`](../src/discovery.ts), [`skills.ts`](../src/skills.ts), [`cli.ts`](../src/cli.ts), [`model.ts`](../src/model.ts).

Native package references: `docs/slash-commands.md`, `docs/usage.md`, `docs/configuration.md`, `docs/cli.md`, `docs/settings.md`, `docs/how-pi-works.md`, `docs/extensions.md`, `docs/mcp.md`; `dist/core/model-runtime.d.ts` and the interactive auth implementation. Durable tool reference: `@earendil-works/pi-durable/dist/tools/index.js` and `read.d.ts`.

Authentication tests use the real Pi runtime and temporary auth/settings files with offline fixture providers. They cover storage preservation, prompt variants, stable device identity, secret masking/redaction, provider and persistence errors, cancellation, orphaned logout, confirmation, catalog failures, command dispatch and shutdown. No real browser/account approval or paid-model request is exercised; actual provider sign-in still needs manual smoke testing.

Instruction/image tests additionally exercise real durable requests, live instruction edits and restart, actual PNG decoding/resizing, native/Wayland clipboard adapters, image-only sends, queue recovery after source deletion, tool-result images, streaming thinking and redacted-payload exclusion. All providers are offline fixtures.

`/copy` copies the latest nonempty assistant or local shell output; `/copy N` selects the Nth-latest in the current transcript, excluding thinking/tools/errors. It uses the open or dashboard-selected session, copies raw Markdown, snapshots streaming text at invocation, and reports clipboard failures. Compacted-away/undone audit history is not searched. Clipboard writes are tested with injected writers; actual OS clipboard access remains platform-dependent.

Direct-shell tests execute real local shell processes (no model requests) for project/session/peek cwd isolation, shell pipelines/redirects, inline response streaming/truncation, terminal-control sanitization, cancellation, cleanup, noninteractive stdin, saved/interrupted history, `/copy`, and protection against overlapping undo. A real durable integration test confirms local responses survive view updates/restart without entering model context. Direct command effects are not backed up by zz.
