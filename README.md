# zz

A small terminal dashboard for agent sessions, grouped by project directory.
Built with `@earendil-works/pi-durable` and `@earendil-works/pi-tui` (pinned to 1.3.0).

## Install

Requires **Node.js 22.19+ (with npm)**, curl, and macOS or Linux.

```sh
curl -fsSL https://github.com/rub1cc/zz/releases/latest/download/install.sh | bash
zz
```

The installer downloads the latest GitHub release, verifies its SHA-256 checksum,
and uses npm to install the prebuilt command and locked production dependencies.
It does not install Node.js, run dependency install scripts, or require sudo.
The default prefix is `~/.local`; if needed, add `~/.local/bin` to your `PATH`
(the installer prints the command). Check your version and upgrade with:

```sh
zz --version
zz upgrade
```

`zz upgrade` checks GitHub's latest stable release first. It downloads and installs
only when that version is newer; otherwise it reports that zz is up to date.
If the update check fails, nothing is downloaded or installed.

Upgrades use the same checksum-verified installer, keep the current global npm
install prefix, and leave sessions and Pi credentials untouched. `ZZ_INSTALL_PREFIX`
overrides the destination; source checkouts default to `~/.local`. `ZZ_VERSION` is
ignored by `zz upgrade`; the installer uses the exact release found by the update
check. Use `zz ./upgrade` to open a project directory named `upgrade`.
A published GitHub release is required; the first release is **v0.0.1**.

To pin a version or choose a different install prefix:

```sh
curl -fsSL https://github.com/rub1cc/zz/releases/download/v0.0.1/install.sh | ZZ_VERSION=v0.0.1 ZZ_INSTALL_PREFIX="$HOME/.local" bash
```

To review before running, download `install.sh` and inspect it first. To uninstall:
`npm uninstall --global --prefix "$HOME/.local" zz` (use your custom prefix if set).
Uninstalling does not remove your sessions or Pi credentials.

## Run From Source

Requires Node.js 22.19+.

```sh
npm install --ignore-scripts
npm run build
npm start
```

For development, `npm run dev`. To install the local `zz` command, run
`npm link` after building, then launch `zz` from any project directory.

```sh
zz ~/r/rub1cc
# Optional: override the model using your existing Pi login:
zz --model openai/gpt-5.4
```

`zz` reuses your existing Pi login/subscription through Pi's official
`ModelRuntime`: no separate credentials are required. Sign in directly in zz with
`/login [provider]`; `/model` selects a model without restarting. Existing Pi
logins work too.

`--model` overrides `ZZ_MODEL`; otherwise zz uses Pi's saved default model.
If the default is unavailable, it prefers a model from a logged-in subscription.
Model choices are stored per session, so changing the flag affects new sessions.
Pi's `auth.json`, `models.json`, and saved model settings are loaded from
`~/.pi/agent` (or `PI_CODING_AGENT_DIR`). Pi handles OAuth token refresh and shared
credential-file locking. Credentials are not copied into zz's database.
The dashboard can open without a login; starting an agent requires a configured
Pi provider. This shares Pi's login and model configuration, not its existing
JSONL conversation history; zz conversations remain in durable storage.

## Login And Logout

- `/login` opens a searchable list of providers and their account/API-key methods.
  `/login openai` (or another provider ID/name) narrows it to that provider.
- Pi owns the authentication flow: API-key entry (masked), browser OAuth,
  device codes, selection prompts and pasted callback URLs/codes are supported.
  Sign-in links are clickable; **Ctrl+O** opens the browser and **Ctrl+X** copies
  the full URL. Escape cancels; Ctrl+C quits and cancels pending sign-in prompts.
- After login, zz refreshes that provider's model catalog. If refresh fails,
  credentials remain saved and cached models are used. If no new-task model was
  configured, zz selects the first available chat model for that provider;
  `/model` lets you change it. Existing sessions retain their selections.
- `/logout` lists only stored credentials, including providers no longer installed.
  `/logout provider` selects one directly. **Enter confirms removal from both zz
  and Pi**; Escape cancels. This affects all sessions using that shared credential,
  but does not stop requests already in flight or revoke access at the provider.
  Environment variables and `models.json` authentication remain active.
- Credentials stay in Pi's `auth.json`, not zz's database or conversation history.
  OAuth refresh and credential-file locking use Pi's official runtime. Cancelling
  cannot roll back a credential write already committed. A local synchronization
  failure is reported separately from a failed credential write.
- Ambient/cloud authentication methods without an interactive login show external
  setup guidance. Custom provider sign-in methods that require coding-agent
  extensions are unavailable because zz does not load those extensions.

See [the native Pi parity audit](docs/pi-parity.md) for remaining differences and
prioritized gaps, including context files, extensions/MCP, attachments and export.

## Project Instructions

zz automatically loads instruction Markdown for each session's **own working
directory**, not the directory where zz happened to launch:

- Pi's user/agent directory first, then ancestors from the filesystem root down
  to the selected project. At each directory, the first existing context file
  wins: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`.
  Pi's resolver handles duplicate paths and nested linked-worktree shadowing.
- `.pi/SYSTEM.md` in the project replaces the default coding preamble; otherwise
  the agent directory's `SYSTEM.md` is used. zz's operational question-tool policy
  remains present so questions still pause the session for your reply.
- `.pi/APPEND_SYSTEM.md` in the project takes precedence over the agent
  directory's `APPEND_SYSTEM.md`. This is independent of `SYSTEM.md`; the two
  files at the same level are not substitutes for each other.
- Context files and addenda are still included with a custom system preamble.
  Files are reread before each model request, including replies and subsequent
  tool rounds; changes affect the next request, not a request already in flight.
  Relative instruction references resolve against that instruction file's directory.

**Launching in or selecting a project opts its Markdown instructions, ancestor
instructions and skills into model context.** Review them before using an
untrusted repository. This is not native Pi's interactive `/trust` policy and is
not a sandbox. No project extension or package code is executed to load these
files. Coding-agent extensions and MCP remain disabled.

## Images And Thinking Blocks

- **Ctrl+V** reads an image, copied image files, or text from the system clipboard.
  On Linux, install `wl-clipboard` (Wayland) or `xclip` (X11) for clipboard access.
  Other platforms use Pi TUI's native clipboard helper when available. zz does
  not install clipboard utilities. If clipboard access is unavailable, use an
  `@image.png` reference or paste an image path. OS/terminal clipboard permissions
  can still prevent a paste.
- Pasted or dragged images insert inline `[Image #1]`, `[Image #2]`, etc. tags at
  the composer cursor. Place tags among captions or on separate lines with
  **Ctrl+J**. Arrow keys cross a tag as one unit; **Backspace** immediately after
  a tag (or **Delete** before it) removes the whole tag and its attachment.
  Undo restores both. This works in task, session and peek composers.
- Dragging/pasting a complete, quoted or shell-escaped local image path stages it.
  `@image.png` or `@"path with spaces/image.png"` in a prompt attaches the image
  when sent. Ordinary text-file `@` references remain paths, not file attachments.
- PNG, JPEG, GIF, WebP and BMP are decoded/oriented/resized using Pi's image
  processor, off the UI thread. Limits: eight images per message, 20 MiB per
  source file, 40 megapixels per attachment decode, 2000×2000 output dimensions,
  and 4.5 MiB of base64 per prepared image. Formats may be converted; animated
  images are not guaranteed to preserve animation.
- Enter sends staged images even without text (with a short default image request).
  Preparing images blocks sending until preparation finishes. Rejected submissions
  retain their draft; UI commands such as `/model` do not discard staged images.
  Draft text and inline images are isolated by project/new-task composer and
  session, and are in-memory only until sent. Switching scope restores that
  scope's draft and cancels late attachment additions. Image numbers remain
  stable while editing; removing an earlier image does not relabel later tags.
- Accepted image bytes are saved with prepared input and durable context. Queued
  follow-ups/steering and restart recovery use those bytes, not a mutable file
  path. Supported terminals display inline images; others show a readable image
  fallback. Expanded `read` tool results also display returned images, and the
  agent's `read` tool now uses the image processor for resizing/conversion.
  Text-only models report an error instead of silently discarding attachments.
- Provider thinking appears in **Thinking** blocks, including during streaming;
  empty non-redacted blocks are omitted. Visible thinking separates activity
  groups; hiding it lets adjacent routine calls group across reasoning.
  Standalone blocks support click/keyboard expansion. `/expand` and `/collapse`
  also apply. **Show reasoning** in `/settings` shows/hides thinking and
  saves that global display preference. It does **not** change
  the model's thinking level; `/thinking` opens the level picker.
  Redacted thinking gets a placeholder; opaque signatures are never displayed or
  copied into the presentation cache. Providers that return no thinking have
  nothing to show.

Sent images and visible thinking can be sensitive: like prompts and source code,
they are retained in zz's private data directory and durable audit history.
Deleting a session from the dashboard is not a secure purge of that history.

## Settings

`/settings` (alias `/config`) opens the settings page. Use arrows or Ctrl+N/P to
navigate, Enter to change a value or open a picker, and Escape to return. Changes
save immediately in zz's data directory; no restart is needed.

- **Busy-session replies** applies globally to future sends in all sessions:
  - **Follow-up** (default) waits until the current run finishes.
  - **Steer** delivers after the current tool round, before the next model request.
    It does not abort running tools.
- Messages already queued keep their original delivery mode, even after changing
  settings or restarting. The transcript distinguishes steering from follow-ups.
- **Show reasoning** (On by default) shows or hides provider thinking blocks in
  all sessions. This is display-only: it does not change the thinking level or
  request hidden reasoning from a provider.
- **Auto-compaction** (On by default) controls threshold compaction and recovery
  from provider context-overflow errors, globally for current and future sessions.
  Off still allows manual `/compact` and does not cancel compactions in progress.
- **Compaction reserve**, **Keep recent tokens**, and **Background lead** edit the
  token budgets described under [Compaction](#compaction). Enter opens an inline
  numeric field; Enter saves, Escape discards the edit without closing settings.
  Use whole counts without commas or units. These settings are saved in zz, not Pi.
- **Model** and **thinking** open the existing pickers. On the dashboard these
  configure new-task defaults; inside a session they configure only that session.
  Selecting or cancelling a picker returns to the settings page. Busy-reply
  behavior can change during a run; the existing model/thinking restrictions apply.

## Model And Thinking

- `/model` opens a searchable model picker using your logged-in Pi providers.
- `/thinking` shows only levels supported by the current model.
- On the dashboard, these set defaults for **new sessions**, even if a session row
  is selected. Open a session first to change **that session's next reply**.
- New-session defaults are saved in zz's data directory, not Pi's settings.
  Existing sessions retain their own choices. Model changes wait for a running
  session to finish; thinking changes can be made during a run. A status line below
  the composer always shows the effective model and thinking.
- Pickers support arrows, Ctrl+N/P, Enter, Escape, and mouse selection. Type to
  filter models by provider, ID, or display name. Slash commands preserve staged
  images; finish or save draft text before entering a command.

Initial thinking follows Pi's per-model preference or `defaultThinkingLevel`.
After that, zz remembers its own defaults. CLI flags/environment variables take
priority over zz's saved defaults; unsupported levels are clamped for the model.

```sh
npm run dev -- --model openai/gpt-5.4 --thinking high
# Or: ZZ_THINKING=high npm run dev
```

## Copy Responses

- `/copy` copies the latest assistant or local shell response; `/copy 1` is equivalent.
  `/copy 2` copies the second-latest, `/copy 3` the third-latest, and so on.
- Uses the open session, or the selected session row on the dashboard. It never
  copies from another project/session implicitly and does not send a model request.
- Copies the original Markdown text, including code fences and line breaks, not
  terminal styling. N counts nonempty assistant messages and local shell outputs
  in the current transcript. Shell copies contain stdout/stderr only, without the
  command heading or exit-code footer. User input, thinking, agent tool output,
  error notices and image-only messages are excluded. Older messages removed by compaction or undo are not searched in
  the audit history.
- During streaming, copies the text available when the command is invoked.
  Invalid/out-of-range indexes, missing responses and clipboard failures show a
  notice. Clipboard access uses Pi's official clipboard helper and its platform
  fallbacks.

## Workspaces And Worktrees

New coding tasks in Git projects get their own worktree by default. Each task
starts from the current committed `HEAD`, on a branch such as
`zz/fix-auth-a1b2c3d4`. Tasks outside Git use the project directory instead.
Existing sessions keep their original directories and conversations unless you
explicitly ask the agent to switch workspace.

The dashboard shows the workspace choice above the composer and worktree labels
beside session titles. Open `/workspace` before sending a task to choose:

- **New worktree**: a separate checkout for each new session.
- **Main checkout**: work directly in the project directory.
- **Existing worktree**: choose a checkout discovered automatically by Git, whether or not zz created it.

The choice is saved for that project and applies only to new sessions. Shortcuts
on the dashboard are `/workspace main`, `/workspace new [base-ref]`, and
`/workspace use PATH`. Base refs can be local branches, tags, commits, or existing
remote-tracking refs; zz does not fetch automatically. Inside a session,
`/workspace` shows its directory, ownership, and sharing, and can make that
workspace the default for new sessions without moving the current conversation.

New worktrees contain committed files, not the main checkout's uncommitted edits,
untracked files, ignored `.env` files, or installed dependencies. Initialize
submodules and install dependencies yourself in the workspace when needed; this
version does not run setup hooks or copy local configuration automatically.
Skills, instructions, file completion, image references, tools, and session shell
commands use the session's workspace. Before a new checkout exists, dashboard
completion and skill discovery use the project directory. For projects rooted in
a repository subfolder, the session keeps that same relative subfolder in its
new worktree.

Checkout preparation is saved before Git creation and can recover after restart.
Failed preparation does not run the agent in the main checkout: fix the reported
Git problem, then reply to retry the same checkout. An established checkout that
is missing must be restored at its original path or replaced by a new session;
it is not silently recreated, since local work might be missing.

Multiple sessions may share a workspace; their file changes are shared too.
`/undo` waits for work in that directory, not every session in the project.
Deleting sessions or removing projects never removes worktrees or branches.
Available worktrees come directly from `git worktree list`; there is no zz
registration inventory. Worktrees without sessions remain selectable while they
exist. Use `git worktree remove PATH` to remove a checkout and `git worktree prune`
to clean up Git metadata for deleted directories. Missing, unused checkouts do not
linger in zz's picker. Missing session bindings remain attached to their original
paths. Review and merge work with Git; automatic merge and removal are not included.
Worktrees separate files and branches, but are not security sandboxes.

### Agent Workspace Handoffs

Ask the agent to "create a worktree for this fix and continue there", "use the
existing review workspace", or "return to the main checkout". The conversation,
title, model, and checklist stay with the same session. The agent has three tools:

- `workspace_list`: inspect the current binding and Git-discovered worktrees,
  including branch, availability, local changes, and session sharing. Results are
  paginated with `cursor` and `limit` (25 by default, at most 50).
- `workspace_enter`: pass `create: { baseRef: "main" }` to create and enter a
  worktree, optionally naming `branch`, or pass `path` (or `workspaceId` from the
  list) to enter an existing one. The default creation base is committed local `HEAD`.
- `workspace_exit`: return to the project's main directory, keeping the checkout,
  branch, and edits you left behind. Already being in main is a no-op.

Creation is only allowed from the main workspace. A session already in a worktree
can enter an existing workspace or return to main, but cannot create another new
one directly. Use another session for independent work. Existing worktrees must
belong to this project's Git repository; no registration step is needed.

Entry into a checkout with retained zz-managed session metadata is automatic.
Other existing checkouts, including those whose last zz session was deleted, are
treated as external. Entry into an external worktree waits for explicit approval,
without another model request. Open `/workspace` in
that session and choose Approve or Deny, or use `/workspace approve` or
`/workspace deny`. The destination and instruction-loading scope are shown before
you decide. Ordinary chat replies do not count as approval. A denial keeps the
session in its original checkout. Approval requests survive restart; `/stop`
cancels the request.

Switch tools must be called alone in their tool round. zz prepares and validates
the destination, waits for that round to settle, and commits the conversation's
working directory and workspace binding together. It then ends the turn and
continues automatically. Already queued replies resume in order in the new
workspace; otherwise zz admits one deduplicated internal continuation. Tools,
instructions, skills, completion, and direct shell all follow the new binding.
The process-wide working directory never changes.

No edits are copied, stashed, merged, or deleted. If an accepted handoff fails,
zz keeps the previous checkout and withdraws queued replies rather than running
them there accidentally; inspect the reported error and resend after fixing it.
A stop after the new binding committed leaves the session in that destination,
but cancels further work. Direct shell, undo, and manual compaction cannot overlap
a handoff for that session or a conflicting restore.

Each switch creates an **undo boundary**: `/undo` offers only turns after the most
recent switch. Earlier conversation history, checkpoints, and file changes remain
intact, including when you later return to the same checkout.

## Direct Shell

- Start a task/reply with `!` to execute the remainder directly, for example
  `!pwd`, `!git status`, or `!npm test`. No agent/model request or login is needed.
  Pipes, redirects, environment expansion and multiline scripts work; Ctrl+J
  adds a newline before sending.
- Uses the open session, the dashboard-selected session, or the session in an
  existing peek. From a project heading, creates and opens a normal local session
  for its response, without starting an agent. Existing sessions use their workspace;
  a project-only shell uses the main directory or the selected existing workspace,
  without creating a new worktree. The process-wide working directory
  never changes. A `!` elsewhere in ordinary prompt text is not a shell shortcut.
- Plain stdout/stderr streams **inline as an expanded response**, with the command,
  working directory, and exit code/error. No shell popup opens. Normal transcript
  scrolling and follow-end behavior apply. An existing peek shows the shell result
  as its latest reply without replacing the peek or losing staged images.
- Commands and bounded output are saved in the session's local `state.json`
  history and remain readable after reopening; `/copy [N]` includes shell output.
  They are kept separate from model context and never replayed as executable work.
  Output retains only the last 256 KiB / 2000 lines per response, with an omission
  notice when truncated. Redirect to a file if you need a full log. Command text
  and output may contain secrets, so treat this saved history as sensitive.
- `/stop` or Escape in an open session cancels its shell and agent when both are active.
  Escape dismisses suggestions/dialogs first. Navigation or opening settings does
  not cancel a shell in the background. Deleting its session or closing zz stops
  the active command. A crash leaves a readable interrupted response on restart,
  not a re-executed command.
- Each invocation uses a fresh noninteractive shell through Pi durable's execution
  environment. `cd` and `export` affect only that invocation. Stdin is closed;
  interactive editors, password prompts and full-screen programs need a normal
  terminal instead. There is no separate native-Pi `!!` context-inclusion mode.
- Only one direct command runs at a time. Other agent work may continue while it
  runs. Programs deliberately daemonized/backgrounded beyond the shell's lifetime
  must be managed separately.
- Shell commands run with **your OS permissions** and can modify/delete files or
  have external effects. They are not sandboxed or tracked by `/undo`, and stopping
  them cannot undo completed effects. Direct shell and `/undo` cannot run together
  in the same project. Shell response history is not removed by `/undo`, since
  its effects are not rolled back. Staged image drafts are preserved by shell
  commands; project-heading drafts remain with that project's new-task composer.

## Context And Cost

An always-visible status line sits below the composer, including in peek replies.
Shortcut hints and the `? shortcuts` toggle are removed:

```text
openai-codex/gpt-6.1-sol · high · ███████░ ~90%/500k · ◉ 99% · ~$13.37
```

- Model and thinking describe the next request. The dashboard shows new-task
  defaults; session and peek composers show that session's settings and usage.
- The eight-cell bar and percentage estimate the conversation's share of the
  model's context window. It uses the latest applicable response's token usage
  plus trailing messages, including tool output. Without a measurement it estimates
  the derived context, including system instructions and tool schemas. This is
  approximate, not a guarantee that another request will fit. Unsent drafts and
  title requests are excluded; unknown measurements or limits display `?`.
- `◉` is the latest conversation prompt's cache-read percentage, not a quota.
  Unknown cache hit rates display `?`; measured zero remains `0%`.
- `~$` is estimated USD cost from recorded provider usage/catalog rates, **not a
  subscription charge or remaining quota**. Unknown cost displays `cost ?`;
  zero may mean the model is unpriced. In-flight requests and usage the provider
  never reports cannot be counted.
- With OpenAI subscription login (`openai-codex` or `openai`), the status line
  also shows `codex 72% ↻ 4d9h`: **weekly quota remaining** and time until reset.
  This is provider-reported account-wide usage, including activity outside zz,
  not the current session's token usage. It refreshes in the background every
  three minutes while that provider is selected, including in peek replies.
  API keys do not expose this subscription quota. Loading, unavailable, stale,
  or expired quota data is omitted rather than guessed. Quota requests reuse
  Pi's OAuth login; zz does not save the quota or tokens in session metadata.
  The Codex usage backend is not a stable public API and may become unavailable.
- `/session` opens a scrollable breakdown for the open session or selected session
  row. It includes the separate title request in totals and lists that overhead
  separately. Older title requests made before usage tracking cannot be recovered.
  The command does not send a model request.

Conversation totals come from Pi durable's usage ledger, including recorded tool
usage, failed/retried responses, and summarization. Reopening, changing models, or
shrinking the active context does not reset the totals. Title usage and display
caches are saved with zz's session metadata. Context warnings start above 70%.

## Context Compaction

- `/compact [instructions]` summarizes older context in the open session, or the
  selected session on the dashboard. For example: `/compact Keep exact paths and
  the failing test names`. It calls Pi durable's built-in summarizer, not a new
  agent prompt. Short conversations may report "Nothing to compact" because the
  recent context is kept verbatim.
- Manual compaction can run alongside a response. The summary is applied at the
  next safe turn boundary; zz reports success only after it is applied. Duplicate
  requests are rejected while that session is compacting.
- Automatic compaction defaults to On with the durable SDK's token budgets.
  Configure it in `/settings`; changes apply to the next policy check in existing
  and new sessions, including work already running, without aborting its requests.
  Applied or in-progress summaries are not cancelled or undone by changing settings.
- **Compaction reserve** (16,384 by default) keeps room for the answer: block and
  compact above `contextWindow - reserveTokens` estimated tokens. It also caps a
  summary's output at 80% of the reserve (subject to the model's own output limit).
  Minimum: 2 tokens; choose a practical answer budget smaller than the context window.
- **Keep recent tokens** (20,000) is the approximate recent context kept verbatim;
  older eligible turns are summarized. This also applies to manual `/compact`.
- **Background lead** (32,768) starts a background summary that many tokens before
  the blocking threshold. The default is `contextWindow - 49,152`. Set it to 0 to
  disable only background compaction, retaining blocking/overflow recovery when On.
  Settings show the resulting thresholds for the current/default model.
- Provider context-overflow errors trigger compaction and one retry when automatic
  compaction is On. Off disables both threshold and overflow compaction, but manual
  `/compact` still works with the configured reserve/recent-context budgets. These
  are token estimates, not fixed percentages, and require an eligible older prefix.
- Running compactions show their manual/automatic reason, blocking status, and
  retry errors in the transcript and dashboard preview. Failures remain visible
  until a later summary succeeds. A failed blocking automatic compaction fails the
  response rather than sending a request the engine considers too large.
- Applied summaries appear as expandable **Context compacted** activity cards,
  followed by the retained recent messages. Older messages remain in SQLite's
  audit history; they are no longer part of the active transcript/model context.
  Compaction never resets usage/cost totals, and summarization usage is included.
- `/stop` for an open/selected session cancels active
  summarization as well as any running response. Cancelling only a compaction does
  not mark an otherwise idle conversation stopped. Already committed summaries
  are not undone. Closing zz checkpoints unfinished compactions for restart.

No separate model, dependency, or hand-written summarization pipeline is used.
The saved configuration feeds Pi durable's live policy directly; Pi's own saved
compaction settings are not imported or overwritten.

## Undo

- `/undo` opens a **checkpoint picker** for the open session, or the selected
  session on the dashboard. Nothing is restored automatically. Browse with arrows
  or Ctrl+N/P, type to filter prompts, then press Enter to restore the selected
  checkpoint. Escape cancels without changing the conversation or files.
- Each checkpoint is the state **before its prompt**. Selecting an older one
  rewinds that turn and every later turn, restoring both conversation and tracked
  file edits. The picker shows the prompt, turn/file counts, and any shell warning.
  In an open session, the selected prompt returns to the composer for editing or
  resending. Opening or using the picker never sends a model request.
- Checkpoints and file backups survive restarting zz. Existing conversations gain
  checkpoints on their next turn; older turns cannot be restored retroactively.
  Queued follow-ups get separate checkpoints when they start. Steering messages
  belong to the turn already in progress, so undo restores that whole turn.
- Only direct `write`/`edit` tool changes are tracked. Existing file contents and
  permissions are restored; files created by those tools are removed. Shell
  commands, external effects, and directory creation are **not undone**. A notice
  explicitly warns when the restored turn ran shell commands.
- Stop or finish all working sessions in the same project before undoing. If a
  tracked file has changed since the agent edited it, undo refuses rather than
  overwriting your work. Changes made between checkpoints also block an older
  restore; choose a newer checkpoint instead. Linked/non-regular files and replaced
  parent directories are refused for safety; direct agent writes to linked files
  are also blocked.
- The original conversation remains in durable audit history, and recorded usage
  and cost totals are retained. There is currently no `/redo` command or picker for
  abandoned branches. Backups are private files in the data directory's `undo/`
  folder and are retained with the audit history, including after session deletion.
- An interrupted multi-file undo resumes the **same selected checkpoint** on
  restart. If an I/O error prevents completion, fix it and reopen `/undo` to resume
  that restore before sending another prompt; its target cannot be changed midway.

Undo is session-level recovery, not a replacement for Git or backups.

## Task Checklists

For substantial multi-step work, the agent can track progress using three tools:
`task_update` creates, updates or deletes tasks in an atomic batch; `task_list`
inspects the checklist and `task_get` reads one task's full details. Simple
questions and one-step edits do not need a checklist. Tasks belong to their
session, not the whole project.

```text
3 tasks (1 done, 1 in progress, 1 open) (/tasks)
  ☒ Inspect authentication
  ■ Implementing password reset
  ☐ Test password reset
```

- A live, height-bounded checklist appears above the session or peek composer;
  dashboard session rows show the same total, done, in-progress and open counts.
  For example: `6 tasks (0 done, 1 in progress, 5 open)`. Normally up to five tasks
  are visible; shorter terminals show three or four, with only the summary at ten
  rows or fewer. Tall drafts can reduce the visible count further to protect the
  composer. Empty lists occupy no space; structured question forms temporarily
  take precedence. Task IDs stay available to tools but have no visible prefixes.
- When every task fits, rows stay in creation order. On overflow, tasks completed
  during this run remain prioritized for **30 seconds**, followed by in-progress
  tasks, unblocked pending tasks, blocked pending tasks, and older completed tasks.
  Each group stays in creation order. Hidden rows are counted by status, such as
  `... +2 pending, 1 completed`; `/tasks` always shows the full list in creation
  order. Newly completed rows can therefore move after the grace period expires.
  Session and peek views share these presentation timers and refresh even while
  idle or with reduced motion. Already-completed tasks on initial load are not
  treated as newly finished; display recency is not persisted or restored by undo.
- `/tasks` opens scrollable active-checklist titles, statuses and descriptions for
  the open session or selected dashboard session. It also works directly in a peek
  reply. It never sends an agent request and is not a completed-task archive.
- Tasks default to `pending`; the agent explicitly marks them `in_progress` and
  then `completed` after required verification. Creation can also set a status.
  Pending tasks use a dim `☐`; active tasks use an amber `■` followed by bold
  black text; completed tasks use a green `☒`. `activeForm` supplies ongoing
  wording. Ending a response, stopping work or closing zz does not complete tasks.
- Dependencies are functional but are not annotated in the checklist or details
  view. Task tools expose prerequisites to the agent; the backend rejects missing
  IDs, cycles and starting/completing blocked tasks. Completing a prerequisite
  unblocks its dependents without starting them. When reopening a prerequisite,
  return any active/completed dependents to pending in the same batch. Deleting
  an obsolete task removes its dependency references, without completing its dependents.
- While any work remains open, completed tasks stay in the checklist. Once every
  task is completed, the finished list remains visible for **five seconds**. zz
  then atomically rechecks and clears the active list, hiding session/peek rows
  and dashboard counts. New or reopened work cancels cleanup; finishing it starts
  a fresh grace period. Editing an already-finished list does not extend the timer.
- After cleanup, `task_list({})` returns `[]`, `/tasks` shows an empty checklist,
  and `task_get` reports cleared IDs as not found. No model request is made, no
  IDs are reused, and replay receipts remain intact. Existing tool activity and
  durable audit history remain; there is no archive screen or `includeCompleted`
  option. Cleanup does not stop an agent that is still writing its final response.
- Checklist state and the completion deadline live in durable SQLite storage and
  survive compaction, cancellation and restart. Reopening uses the remaining
  grace period, or clears an overdue list immediately. Older completed lists
  without a saved deadline receive one five-second grace period when loaded.
  `/undo` restores the checklist at the selected conversation checkpoint; an
  atomic bookkeeping entry anchors background cleanup for later checkpoints.
  The display cache in `state.json` is not authoritative. Mutation receipts keep
  interrupted tool replay from applying twice or recreating cleared tasks.
- A compact current-state summary and task-use guidance are included in model
  context, even with a custom `.pi/SYSTEM.md`. Full descriptions are available
  through `task_get`. Task ownership/delegation and cross-session lists are not
  implemented. A session supports up to 1000 tasks; deleting tasks does not reuse
  their IDs within the active conversation branch.

`task_update` always takes an `operations` array, even for a single change:

```js
task_update({
  operations: [
    { action: "create", subject: "Inspect authentication", ref: "inspect", status: "in_progress" },
    { action: "create", subject: "Implement password reset", blockedBy: [{ ref: "inspect" }] }
  ]
})
```

A later batch can finish a prerequisite and start its dependent together:

```js
task_update({
  operations: [
    { action: "update", taskId: "1", status: "completed" },
    { action: "update", taskId: "2", status: "in_progress" }
  ]
})
```

The second example assumes the earlier results returned IDs `1` and `2`; real
calls use those returned IDs, not guessed numbers. Deletion uses
`{ action: "delete", taskId: "3" }` for an existing obsolete task.
Each batch accepts 1-100 operations, targets each task at most once, and validates
the final dependency
graph. If any operation fails, nothing changes and no IDs are consumed. New tasks
can have unique `ref` names; dependency lists accept `{ ref: "name" }`, including
forward references within that batch. Refs are not persisted or reusable in a
later batch. Results follow operation order and contain each action, `taskId`,
final status, and optional create ref; descriptions are read through `task_get`.

Existing unfinished task data and historical tool activity remain readable.
New provider requests advertise
only the three tools. A compatibility handler retains old `task_create` execution
and single-task `task_update` arguments for interrupted calls, with old replay
receipts preserved. No separate create or delete tool is advertised.

Successful task-tool rows are hidden from the interactive transcript, including
global expansion, without splitting activity groups. Failures, warning diagnostics
and image artifacts remain visible; saved records remain unchanged. `/tasks` and
the live checklist remain the task controls. Checklist entries record agent-reported progress, not
independent proof of test success, and may contain sensitive project information.

## Compact Activity

The conversation uses `❯` for literal user prompts, `●` for assistant Markdown,
small `•` dots for tool headings, and `⎿` output gutters. Only tool names are bold.
User prompts keep their full-width light-grey background; assistant/tool output
keeps the terminal background.

During a run, routine reads and shell calls share a replace-in-place preview:

```text
❯ Fix authentication and run its tests.

● I'll inspect authentication first.

  Reading auth.ts
  ⎿ /project/src/auth.ts

✽ Working (3s)
```

When the shell starts, that same slot becomes:

```text
  Running npm test
  ⎿ PASS auth.test.ts
    PASS session.test.ts
    All tests passed
```

The latest useful preview stays through completion and while the next call's
arguments stream. Before execution, complete queued calls say Waiting to read/run;
incomplete routine arguments have no placeholder. Parallel calls select the most
recently observed start, not whichever older operation finishes last. When prose
resumes, the preview becomes a muted, dot-free receipt:

```text
  Read 2 files, ran 1 shell command

● Authentication is fixed. All tests pass.
```

Single calls use the same lifecycle. Historical replay shows counts, never
invented live activity. A live run ending without prose keeps its last preview.
File counts deduplicate lexical paths relative to the workspace, including `@`,
`~`, `file://`, `.` and `..` aliases, without filesystem reads or resolving symlinks.
Repeated reads show their invocation count separately. Shell calls count tool
invocations, never inferred reads, safety, or commands within a script.

- Click a group to reveal individual tool headings, then expand just the result
  you want. Closing a group preserves individual expansion state.
- Tab or Ctrl+N/P selects groups, visible members and thinking. Space/Enter
  toggles the selection when the composer is empty; Right expands it.
- `/expand` opens groups and all member details; `/collapse` closes them. These
  also override local diff expansion. State survives redraw/resize, not session switches.
- Visible thinking, prose, mutations, explicit skill loads, questions, compaction,
  interruptions and unknown actions separate groups. Hidden thinking, empty text
  and successful task-tool rows do not. A `SKILL.md` read is a normal read.
- Failed inspections remain grouped with a leading failure count and bounded
  diagnostic. Warnings, truncation and continuation diagnostics remain standalone.
  Image reads can group; expanded results display the native image/fallback.
  Non-read image artifacts remain standalone.
- While scrolled up, a one-line contextual user prompt appears above the transcript.
  Click it to jump to the original prompt. It hides when that original first row
  is visible, at the bottom, and on tiny terminals.

Standalone tool labels distinguish preparing, waiting, running and Failed.
Shell headings show only the first command line and SDK-supplied duration when
available. Output previews show the last three wrapped shell rows (including
streaming output) and the first three generic rows. Omission hints count hidden
visual rows. Empty shell output explicitly says No output. Full commands, retained
output and metadata stay available on expansion. Local `!command` history is unchanged.

Read headings show compact paths and requested ranges; expanded reads use language
highlighting when recognized. Writes show a three-row numbered, highlighted preview.
Edit diffs default to all retained rows; clicking the header/body toggles a 24-row
preview. Diff state survives redraw and resize, and global controls override it.
Diffs use the SDK's actual result and Pi's public `renderDiff()`; changed rows have
subtle terminal-background-aware fills and retain word highlights through wrapping.
Legacy edits show retained replacement fragments without invented line numbers.
Failed/interrupted mutations never show proposed content as applied.

Activity is presentation only: execution, scheduling, undo, model context and
saved tool results are unchanged. All content is bounded by the SDK's retained
output; a spill path does not load the file automatically. Web/browser/Agent/codemode
integrations are not added by this renderer change.

The transcript ends with a shimmering working/thinking, retry or stopping row,
e.g. `✽ Working (1m 2s)`. The clock includes days/hours/minutes/seconds with
intermediate zero units. Stored work statistics retain their existing lifecycle;
queued follow-ups share the current work period. Successful runs lasting at least
ten seconds leave a muted `✽ Worked for 12s` receipt in the observing view. Short,
failed, cancelled or input-waiting runs leave no receipt. Receipts disappear on
later transcript activity or session changes and are not reconstructed on replay.
Failures and waiting states retain their explicit error/answer/continue notices.
Shimmer follows reported terminal colors. `ZZ_REDUCED_MOTION=1` or `NO_COLOR`
disables animation; elapsed time still refreshes once per second.

See the [response inventory](docs/tui-rendering.md) for behavior and test coverage.

## Composer Discovery

- Type `/` at the start of a task or session reply to search commands available
  in the current view. A project row offers `/model`, `/thinking`, `/skills`,
  `/settings`, `/login`, `/logout`, and `/help`. Selecting a session also offers
  `/copy [N]`, `/session`, `/tasks`, `/compact`, `/undo`, and `/stop`.
  Opening a session adds transcript actions: `/bottom`, `/expand`, `/collapse`.
  On the dashboard, model/thinking choices apply to **new tasks**, not the selected
  session; in an open session they apply to that session.
  `/help` lists the current view's commands plus the shortcut reference;
  `/skills` opens the skill picker. Manually entering a transcript command outside
  an open session shows a notice instead of starting a task.
- Type `$` at the start of a prompt to search skills for that project. Arrows or
  Ctrl+N/P select; Tab or Enter fills `$skill-name ` without sending. Add your
  request, then press Enter to invoke it. This also works in peek replies.
- Type `@` to find files in the selected project's directory. Recursive search
  uses an existing `fd` / `fdfind` on PATH or Pi's installed copy; zz never downloads
  it. Without fd, `@` still completes directory/file prefixes (e.g. `@src/`).
- Press Tab to complete a path at the cursor, including `./`, `../`, `~/`, absolute
  paths, and quoted paths with spaces. Peek replies use that session's project.
- With suggestions open, arrows or Ctrl+N/P select; Tab fills the draft
  **without sending**. Enter immediately runs the selected slash command.
  Skill and file/path suggestions only fill the draft; press Enter again to send the prompt.
  Escape dismisses suggestions first, preserving the draft without stopping work.
  Outside completion, existing project and tool navigation shortcuts are unchanged.

Text-file references insert paths, not file contents; ask the agent to read them
when needed. Explicit `@` image references attach image content on send. Peek
replies offer skill/file/path completion and clipboard images, not dashboard
command completion; `/tasks` can still open that peek's checklist details.

## Skills

- `/skills` opens a searchable picker for the selected project (or open session).
  Selecting a skill fills `$skill-name ` in the composer; add your request and
  press Enter to load it.
- `$skill-name [request]` explicitly loads the skill instructions into the model's
  input, including skills marked `disable-model-invocation`. The transcript keeps
  your short command and a collapsed skill card with the loaded text.
  `/skill:name [request]` remains supported as a compatibility alias.
- Available skill names, descriptions, and paths are also advertised to the model
  automatically. It can read a matching skill as needed. Disabled automatic
  invocation skills are excluded from this advertisement.
- Discovery uses Pi's resolver for user/project `.pi/skills`, user/ancestor
  `.agents/skills`, configured paths and filters, and already-installed Pi packages.
  Missing packages are skipped, not installed; manage them through `pi install`.
- `/skills` refreshes discovery for that project. Catalogs are scoped to each
  working directory, and relative skill references resolve against its directory.

Selecting a project opts its Markdown skill settings into discovery. Trust its
skills and package declarations before using it: instructions can tell an agent
to execute commands. zz does not execute coding-agent extensions during discovery.

## Chat Scrolling

Opening a chat starts at the bottom. While you remain there, new messages and
streamed text keep the viewport at the end. Scrolling up with the wheel, scrollbar,
or Page Up pauses following so new output does not move what you are reading.

Chat wheel scrolling starts at three lines per event and accelerates with faster
wheel gestures, up to 18 lines per event. A pause or direction change resets the
speed. Tightly batched trackpad/terminal events keep the base speed to avoid extra
acceleration. Alt+wheel moves five times farther; dashboard lists keep fine,
one-line scrolling. Ctrl+Home or `/top` jumps directly to the oldest chat output.

Click **Scroll to bottom** or enter `/bottom` to jump to the end
and resume following. Scrolling back to the bottom manually also resumes following.
The jump control appears only when a chat is scrolled away from the end. Project
and session lists never follow chat output.

## Session Orchestration

Sessions can delegate work and collaborate with other sessions in the **same project**.
For example: "Implement checkout. Delegate backend and frontend work, have them
coordinate the API, then review the results." No separate worker service is needed.

A worker is a normal, visible session with its own conversation and optional model
selection. It is nested under its coordinator in the dashboard; independent peers
stay at the project level. Enter opens any session and Space peeks/replies as usual.
With an empty dashboard composer, **Tab** folds/unfolds the selected session's workers.
Workers needing input (and their ancestor rows) remain visible inside folded groups.
A coordinator whose turn has ended shows **Waiting**, not Done, while delegated work
or an explicit wait is outstanding. Waiting makes no model requests or polling calls.

The agent tools are:

- `session_list` / `session_read`: discover IDs, workspace/model selections, owners,
  status, and bounded conversation content. Reads use message-offset cursors; restart
  at cursor zero after undo because offsets can change.
- `session_delegate`: start a worker with a self-contained task and optional title
  and `model: { provider, modelId }`. Model/thinking inherit unless overridden.
- `session_create`: start an independent top-level session when requested by the user.
- `session_update`: a worker reports on its own original delegated task to its parent
  with `kind: "progress" | "blocker" | "result"` and `message`. Progress is passive;
  a blocker queues a notification for safe delivery. An explicit result is a passive
  draft, not completion: the runtime publishes the task result when the worker
  actually finishes. This tool is worker-only, not a way to message arbitrary peers.
- `session_send`: message an existing session without changing ownership. Default
  `queue` follows active work or resumes an idle session; explicit `steer` redirects
  at a tool-round boundary. Agent messages are labeled separately from human input.
- `session_wait`: call alone to end the current turn and resume when all selected
  sessions finish or one needs input. Self/ancestor/cyclic waits are refused.
- `session_cancel`: stop another session and its delegated descendants, preserving
  conversation history and files. Independent collaborators are not stopped.

Delegation and independent creation default to **worktree isolation**, starting at
the caller's current committed HEAD. Parent conversation history and uncommitted
edits are not copied, and results never merge branches automatically. Non-Git projects
must explicitly use `isolation: "shared"`; it is also useful for read-only research or
intentionally coordinated edits in the caller's checkout. Shared workspaces are not
file locks: concurrent edits can conflict. There are limits of twelve active workers
per coordinator, four delegation levels, and 32 active sessions per project for
agent-created work. Existing user-created sessions are not capped by these limits.

Worker reports appear in a separate **Worker updates** transcript section with the
worker title, report kind and delivery state. It shows the latest ten reports from
the latest-50 presentation cache as single-line previews capped at 240 characters
(wrapped on narrow terminals). Truncated previews point to `session_read` for details;
cached and durable history are unchanged. Passive
reports remain visible while idle and do not start a model request. Human queued
follow-ups/steering stay separate from **Queued agent messages**; ordinary
`session_send` messages still queue or steer exactly as before, rather than becoming
passive reports.

Delegated results and blockers return automatically. Nested work must finish before
its parent's task result is delivered. Ready completions are batched for delivery;
reading a worker's terminal result with `session_read`, or receiving its terminal
result through `session_wait`, acknowledges that completion so it is not delivered
again as a separate notification. Reporting a draft result does not acknowledge or
publish completion. Delivery is durable across restart and uses stable submission
IDs to avoid duplicate sessions/messages on replay. Automatic notifications wait
for the active turn to end and do not answer a pending human question or workspace
approval: they wait until that interaction is resolved. Stopping a coordinator
cancels its waits, pending notifications, and delegated workers. A stopped session
requires a human reply to resume; another agent cannot silently restart it.

A worker conversation remains available after its original task finishes; subsequent
messages are ordinary session collaboration, not a reopening of the published task.
Deleting a coordinator stops its workers but removes only the selected session;
surviving worker histories remain accessible. No files or worktrees are deleted.
`/undo` does not retract messages already sent to peers, delete worker sessions, or
undo other sessions' file changes. Finish or stop outstanding orchestration before undo.

Cross-session tools deliberately allow project-wide access, not just access to owned
workers. This is not a sandbox or a per-session permission system: project agents
already have shell/file access. Treat peer results as task data, not human authorization.
External-workspace approvals remain human decisions in the worker's `/workspace` UI.

## Interface

```text
  1 awaiting input / 1 working / 2 completed

> ~/r/rub1cc                         2 sessions
  ? api client retries     Retry on 429 or surface the error?       12m
  * dark mode toggle       Running edit                            3m

  ~/work/web-app                     2 sessions
  . flaky checkout test    Fixed the checkout race                 40m
  . cli flag docs          Updated docs for the new flags           1h

  New task in ~/r/rub1cc
  ------------------------------------------------------------------
  > describe a task for a new session
  ------------------------------------------------------------------
  openai-codex/gpt-6.1-sol · high · ?/500k · ◉ ? · cost ?
```

- Up/down or Ctrl+P/Ctrl+N selects project headings and sessions, including in
  project management. With a multiline draft, arrows move the text cursor instead;
  Ctrl+P/Ctrl+N still navigate the list. Mouse hover selects rows;
  double-click opens a session. Some terminal multiplexers limit hover reporting.
- Typing a task and pressing Enter **creates a new session in the selected
  row's project**, even when a session row is selected.
- New sessions generate a short title from the first prompt using one extra,
  tool-free request to the session's model. This runs in the background without
  delaying the task; errors or a 15-second timeout keep the prompt-based fallback.
  Titles are saved and do not change on replies.
- With an empty composer, Enter opens the selected session's transcript.
  Space peeks at its latest agent reply in a dialog with a reply field.
- In an open session or peek dialog, Enter sends a reply to that same session.
  While it is working, replies enter Pi Durable's persisted inbox. By default
  they follow up one at a time after the current run finishes; `/settings` can
  switch future sends to steering at the next tool-round boundary.
  The transcript shows queued messages separately until they enter the conversation;
  the reply footer and peek show the queue count. Queued replies survive restart,
  including replies sent while the initial conversation is still starting.
  `/stop` cancels the active work and withdraws queued replies.
  If a run fails, Pi retains the queue until another reply resumes processing.
- In an open session or peek reply, ↑ recalls earlier sent prompts from that
  session; ↓ moves forward and restores your unsent draft after the newest entry.
  Start with an empty draft, or place the cursor at the start of its first line.
  Arrows still move through multiline text; suggestions take priority when open.
  Recalled prompts are editable and are not sent until you press Enter.
- Ctrl+J inserts a newline in task and reply drafts (including peeks); Enter sends.
  Multiline text and pasted blocks are preserved.
- Ctrl+G opens the draft in `$VISUAL`, then `$EDITOR`, falling back to `vim`.
  Save and exit (`:wq` in Vim) to return the text to the composer without sending.
  Use a waiting command for GUI editors (for example, `EDITOR="code --wait"`).
  Editor failures leave the original draft intact; temporary draft files are removed.
- `/projects` opens project management. `a` adds an existing directory;
  Enter selects a project and returns to sessions; Escape returns without changing
  the project. The Add project dialog suggests directories as you type (including
  `~/` and relative paths). Up/Down or Ctrl+P/N selects a suggestion; Tab fills it
  and browses its subdirectories; Enter adds the typed directory. Spaces need no
  quotes. Escape dismisses suggestions first, then cancels the dialog.
- In `/projects`, press `r` twice to remove the selected project from the list.
  Any other key cancels confirmation. Files and sessions stay intact, and running
  work continues. Re-add the same directory to bring its sessions back, even after
  restarting zz. Ctrl+X remains a separate action that deletes sessions instead.
- Shift+Up/Down moves the selected dashboard session within its project. The first
  move saves that project's visible session order, which remains stable as session
  statuses change and survives restart. New sessions appear above the saved order.
- Ctrl+R edits the selected dashboard session's name inline, with the cursor at the
  end. Enter saves; Escape cancels. Your task draft stays intact. Names survive
  restart and are not overwritten by background title generation.
- Ctrl+X on a session replaces its row preview with **ctrl+x again to delete** in red (no popup).
  Any other key cancels. Deleting stops its active work and removes it from the list.
- Ctrl+X on a project marks only its session rows for deletion in red; the project header stays unchanged.
  Ctrl+X again stops and deletes all its sessions, keeping the project in the list.
  This also works in project management. Any other key cancels. Project files are never deleted.
- Escape dismisses suggestions/dialogs first; otherwise, in an open session it
  triggers `/stop`, preserving history and your draft and staying in the session.
- Left Arrow or Ctrl+H returns to the dashboard only when the composer is empty.
  With text, normal editing behavior is preserved. Going back does not stop a running task.
- `/stop` stops the open or selected session without deleting it. Reply when stopped
  to continue with the same conversation; stopped work is not automatically resumed
  on restart.
- Page Up/Down scrolls transcripts and peeks. Model, thinking, context and cost
  stay below the composer; important notices stay above it. `?` is ordinary draft
  text, not a shortcut toggle. `/help` opens the full shortcut reference.
  Ctrl+C quits zz, checkpointing unfinished work for later recovery. The terminal
  is restored immediately while cleanup finishes. A second Ctrl+C forces exit;
  stalled cleanup also exits after five seconds rather than hanging indefinitely.

Stopping alone cannot undo file edits or external effects that have already
happened. Once idle, `/undo` lets you choose a checkpoint to restore tracked file
edits and conversation; shell-command changes and external effects remain.

`*` means working, `?` needs input, `.` completed, `!` failed, and `-` paused.
Agents use `ask_question` by default whenever they expect a conversational answer,
including clarification, decisions, approval requests, and casual questions. It
shows the question in chat and keeps the normal composer available for your reply.

Use `ask_multiple_questions` for structured choices or related questions that
benefit from a wizard. Only this tool replaces the composer with a question form.
Both tools enter `needs-input` and pause work until you reply. Rhetorical, quoted,
or example questions do not require either tool; a question mark in ordinary prose
alone does not change the session state.

### Question Wizard

Opening or peeking a session awaiting an `ask_multiple_questions` response opens
its wizard in place of the composer, not in a popup. A direct `ask_question` never
opens the wizard. The transcript stays visible and scrollable above it. The wizard
collects one or more structured questions with these controls:

- `radio`: numbered single choices, with required descriptions on indented lines underneath.
- `select`: an alias for the same single-choice list; no searching or filtering.
- `multiselect`: numbered `[x]` / `[ ]` checkboxes; Space toggles options, and a separate `Next` action continues.
- `input`: a free-text answer.

Each choice question has at most five options total, including the editable custom
answer row. With `allowOther` enabled (the default), supply up to four listed
options; with it disabled, supply up to five. Every listed option needs a concise,
nonempty `description`. The composer grows to show all options and descriptions
at once instead of using a scrollable option viewport. On shorter terminals it
removes blank spacing first, never option descriptions. Older saved options that
lack descriptions show `No description provided.` rather than invented details.

Use arrows to browse and Enter to choose or activate an action. Tab moves to the
next question; Shift+Tab (or Ctrl+B) goes back, preserving answers and drafts.
These keys navigate the wizard instead of completing text.
You may skip questions with Tab, but unanswered questions are flagged on the final
`Submit` step and prevent submission. That last step reviews every answer and
provides explicit `Submit answers` and `Cancel` choices. Arrows or Ctrl+N/Ctrl+P
select between those choices; Enter activates the selected action. Tab never sends
answers; only activating `Submit answers` sends them together to the same session.
No model requests run between steps. Submitted answers appear in the transcript
as a compact question-and-answer summary using option labels, not a raw JSON user
message. The structured input sent to the agent remains unchanged; saved replies
use the same readable rendering after reopening.

Choice questions include an inline `type something` row unless the agent sets
`allowOther: false`. Move to or click that row and type directly without opening a
separate input screen. A multiselect custom answer automatically checks when it
has text and unchecks when cleared. Move away and back to use Space to toggle its
checkbox without deleting its text; spaces entered while typing remain ordinary
spaces.

Escape returns to the normal composer without answering or stopping the session;
any unsent composer draft is kept. `/answer` reopens the inline wizard for the open
or selected session; question drafts survive closing and reopening
within this zz instance (up to 20 recent forms), not a restart. You can also reply
normally instead of using the form. Unanswered questions survive restart through
the durable tool history. Questions in other sessions never steal focus.

`ask_question` accepts `{ "question": "Your question?" }` and waits for a plain chat
reply. `ask_multiple_questions` requires a title and one to twelve uniquely
identified steps. The old `ask_user` tool is no longer advertised, but its saved
history remains readable: old plain questions stay in chat, and old structured
question sets still open their wizard.

Example `ask_multiple_questions` arguments:

```json
{
  "question": "Build preferences",
  "questions": [
    {
      "id": "target",
      "question": "What should I build?",
      "type": "radio",
      "options": [
        { "value": "cli", "label": "CLI", "description": "A terminal app" },
        { "value": "web", "label": "Website", "description": "A browser app" }
      ]
    },
    { "id": "name", "question": "Project name?", "type": "input" }
  ]
}
```

## Persistence And Execution

Data lives in `~/.zz`. Override it with `--data-dir PATH` or `ZZ_DATA_DIR`
(the flag takes precedence). `XDG_DATA_HOME` does not affect this location.
Existing data is not moved automatically: with zz stopped, move the previous
data directory (`~/.local/share/zz` or `$XDG_DATA_HOME/zz`) to `~/.zz`, or keep
using it with an explicit override. Move the whole directory, not just `state.json`.

- `state.json`: projects, stable project identities, defaults, session workspace bindings, and cached display history.
- `worktrees/`: retained managed Git checkouts, grouped by project and workspace ID.
- `state.v1.backup.json` / `state.v2.backup.json`: original indexes saved before their respective migrations.
- `sessions.sqlite`: durable conversations, model context, tools, and checkpoints.
- `undo/`: persistent file backups for `/undo` (may contain sensitive source contents).
- A heartbeat lock permits only one dashboard per data directory. After a crash,
  allow 10 seconds for the stale lock to expire.

Each session has a separate conversation and an assigned workspace; sessions can run
concurrently and may share a workspace. The process never changes its global working directory. Startup
registers the launch directory and selects it. Closing checkpoints running work;
reopening resumes it, deduplicating previously submitted input. Work does not run
while zz is closed. An interrupted model request may be retried and billed again.
Forced shutdown relies on the last committed durable checkpoint; pending inputs
were saved before execution. It does not undo effects of tools already executed.

Live-only agent updates repaint without requesting JSON snapshots. Background saves
serialize and write in one worker, coalesce pending updates, and flush on shutdown;
accepted inputs and synchronous UI changes retain their recovery checkpoints.
See [multi-agent performance](docs/performance.md) for the reproducible benchmark,
before/after results, and memory trade-offs.

**Agents can read/write files and execute shell commands with your permissions.**
A workspace is not a sandbox. Concurrent sessions sharing a checkout can edit the
same files. Only use trusted projects and prompts.
zz supplies skill discovery, explicit skill loading and automatic instruction-file
loading. Coding-agent extensions and MCP are not loaded by this application.

Deleting sessions individually or by project never deletes project files. Session
deletion removes its UI record, but the underlying durable audit history remains
in SQLite (the current durable API has no conversation-purge operation). Back up
the complete data directory and the original repositories while zz is stopped if
you need to preserve managed worktrees and their Git metadata. Worktree and
conversation paths are absolute: moving the data directory does not relocate
existing checkouts or repair their Git links. Choose a data location before
creating worktrees and retain existing paths when changing it.

Startup migrates older indexes to format 3. Workspace metadata lives on sessions,
not in a separate checkout inventory. Existing bindings and interrupted creation
metadata are preserved, existing-worktree defaults become paths, and unused zz
registrations are discarded without touching files or branches. Format 1 indexes
also receive stable project IDs and original-directory bindings. Backups are kept
as `state.v1.backup.json` and/or `state.v2.backup.json`; old zz versions refuse the
new format. Removing and re-adding the same directory still reconnects its retained
sessions, including sessions whose project is currently hidden.

## Releases

Pushing a stable version tag runs `.github/workflows/release.yml`. It type-checks,
executes the test suite, and smoke-tests the packaged command on macOS/Linux with
Node.js 22.19 and 24. Only after all checks pass does it create a GitHub release
with `zz.tgz`, `zz.tgz.sha256`, and `install.sh`. No npm registry publish or npm
publish token is needed; the workflow uses the repository's `GITHUB_TOKEN`.

To release, first commit your changes on `main` so the working tree is clean, then:

```sh
npm run check
npm test
npm version patch
git push --atomic origin main --follow-tags
```

Use `minor` or `major` instead of `patch` when appropriate. `npm version` updates
`package.json` and `package-lock.json`, commits both, and creates the matching
annotated `vX.Y.Z` tag. Do not bump the version or create the tag separately.
Packaging still rejects mismatches between the tag, package.json, and lockfile.

The atomic push sends the commit and tag together. Only a pushed version tag
triggers a release; ordinary pushes to `main` do not. `npm version` alone stays
local until you push.

To inspect a release package locally:

```sh
npm run build
npm run package:release
# Outputs release/zz.tgz, release/zz.tgz.sha256, and release/install.sh
```

The archive contains compiled JavaScript and an npm shrinkwrap derived from the
lockfile, not a standalone binary. Node.js and npm registry access are still
required on the installing machine.

## Verify

```sh
npm run check
npm run build
npm test
```

Workspace tests cover real Git checkout isolation, migration, shared workspaces,
subdirectory projects, base pinning, failed/interrupted preparation, retained
checkouts, workspace-scoped shell/skills/undo, and narrow/wide workspace controls. Agent handoff tests cover enter/exit, current
branch and sharing inventory, explicit approval and stale decisions, queued input
ordering, failure withdrawal, both continuation crash gaps, binding recovery,
cancellation, updated cwd/instructions, and undo boundaries.
Tests cover project scoping, peek/reply/open, project removal and restoration,
double-confirm deletion, narrow and wide-character rendering, real durable
storage and tools with an offline test provider, interrupted-run recovery, skill
discovery/loading, slash-command model/thinking controls, follow-end/jump-to-bottom scrolling, and
context/usage accounting, title overhead, restore, and narrow usage dialogs.
Compaction tests cover manual instructions, no-ops, concurrent responses, history
and spend retention, cancellation, restart, background/blocking thresholds, overflow
recovery, failures, and narrow activity rendering.
Checklist tests cover lifecycle/schema validation, dependency cycles and blockers,
atomic mixed batches and rollback, forward references, compact batch results,
concurrent creation, replay receipts, session isolation, compaction, restart and
interrupted old/new tool recovery, three-tool provider requests, stale cache
replacement, undo, task details, and narrow session/peek/dashboard rendering
without dependency annotations. Cleanup tests cover the five-second grace period,
atomic state rechecks, reopening/new work, stale and in-flight timers, shutdown,
remaining/overdue deadlines on restart, old lists without deadlines, replay safety,
model-context removal, undo boundaries and disappearing UI rows. Task display
coverage also checks five-task capacity, status-based overflow counts, numeric
creation order, ready/blocked priority, exact 30-second recency, idle/reduced-motion
refresh, shared session/peek timing, initial-load behavior and timer cancellation.
Authentication tests also cover shared Pi credential storage, prompt variants,
secret masking/redaction, cancellation, logout confirmation and catalog failures.
Direct-shell tests run real local processes for project/session/peek scoping, pipes,
streaming inline responses, nonzero exits, cancellation/shutdown, bounded output,
safe rendering, saved history, interrupted-run recovery and model-context isolation.
Copy tests cover response ordering, scope, raw Markdown, invalid indexes, clipboard
failures, streaming snapshots and restored history.
Instruction/image tests cover hierarchy and overrides, project scoping, request-time
refresh, image validation/resizing, clipboard adapters, queued-image recovery, inline
rendering/fallbacks, streaming thinking and redaction. They do not call a paid model
provider or perform a real browser/account sign-in. Physical clipboard access and
terminal image placement still need platform-specific manual smoke testing.
