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
(the installer prints the command). Re-run the same command to upgrade.
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
  the agent directory's `SYSTEM.md` is used. zz's operational `ask_user` policy
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
- With empty draft text, **Backspace** removes the last staged image; repeat to
  clear more images. With text present, Backspace edits text normally. This works
  in task, session and peek composers without attachment slash commands.
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
  Draft images are isolated by project/new-task composer and session, and are
  in-memory only until sent. Switching scope cancels late attachment additions.
- Accepted image bytes are saved with prepared input and durable context. Queued
  follow-ups/steering and restart recovery use those bytes, not a mutable file
  path. Supported terminals display inline images; others show a readable image
  fallback. Expanded `read` tool results also display returned images, and the
  agent's `read` tool now uses the image processor for resizing/conversion.
  Text-only models report an error instead of silently discarding attachments.
- Provider thinking appears in separate **Thinking** blocks, including during
  streaming. Click or select a block to collapse/expand it; `/expand` and
  `/collapse` also apply. **Show reasoning** in `/settings` shows/hides all
  thinking blocks and saves that global display preference. It does **not** change
  the model's thinking level;
  Ctrl+T and `/thinking` retain their existing level-picker behavior.
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

- `/model` or Ctrl+L opens a searchable model picker using your logged-in Pi providers.
- `/thinking` or Ctrl+T shows only levels supported by the current model.
- Shift+Tab cycles those supported levels directly, wrapping at the end and
  preserving your draft. In a running session it affects the next model request,
  not the request already in flight.
- On the dashboard, these set defaults for **new sessions**, even if a session row
  is selected. Open a session first to change **that session's next reply**.
- New-session defaults are saved in zz's data directory, not Pi's settings.
  Existing sessions retain their own choices. Model changes wait for a running
  session to finish; thinking changes can be made during a run. A status line below
  the composer always shows the effective model and thinking.
- Pickers support arrows, Ctrl+N/P, Enter, Escape, and mouse selection. Type to
  filter models by provider, ID, or display name; unsent composer text is preserved
  when opening a picker with its shortcut.

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

## Direct Shell

- Start a task/reply with `!` to execute the remainder directly, for example
  `!pwd`, `!git status`, or `!npm test`. No agent/model request or login is needed.
  Pipes, redirects, environment expansion and multiline scripts work; Ctrl+J
  adds a newline before sending.
- Uses the open session, the dashboard-selected session, or the session in an
  existing peek. From a project heading, creates and opens a normal local session
  for its response, without starting an agent. The process-wide working directory
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
- Escape stops the current session's shell first, without stopping its agent;
  `/stop` cancels both when both are active. Navigation or opening settings does
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
  never reports cannot be counted. Codex subscription quota/reset data is not
  currently available, so that segment is omitted rather than guessed.
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
- Escape in an open session, or `/stop` for an open/selected session, cancels active
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

## Compact Activity

Tool calls and results are combined into one collapsed row, showing the tool,
path/command, running/done/error status, and duration when available. `read` calls
for `SKILL.md` are labeled `Skill <directory name>`; that reports a skill-file
read, not a guarantee that every instruction was followed.

```text
    [+] Skill frontend-design                  done 12ms
    [+] bash npm test                          running
```

Inside a session:
- Click a tool row to expand/collapse its arguments, output, and details.
- Tab or Ctrl+N/P selects a tool; Space or Enter toggles it with an
  empty composer. Right expands; Space/Enter collapses again. Left or Ctrl+H with an empty
  composer returns to the dashboard without cancelling work. Text in the composer still
  behaves as ordinary text and Enter sends it.
- `/expand` and `/collapse` show/hide all tool details. Page Up/Down scrolls long
  output. Expansion survives streaming updates and resets when switching sessions.

Activity is presentation only: collapsed output is still retained for the model.

The transcript ends with a shimmering `✻ Working` while a task runs. On completion,
it shows e.g. `✻ Worked for 3s · done 3:22 PM`, using your local time. Timing is
saved per session and resets with each idle-session reply; queued follow-ups keep
the current work timer running until the queue finishes. Failures and input requests are
labelled accordingly. Set `ZZ_REDUCED_MOTION=1` to disable shimmer animation
(`NO_COLOR` also disables it).

## Composer Discovery

- Type `/` at the start of a task or session reply to search commands available
  in the current view. A project row offers `/model`, `/thinking`, `/skills`,
  `/settings`, `/login`, `/logout`, and `/help`. Selecting a session also offers
  `/copy [N]`, `/session`, `/compact`, `/undo`, and `/stop`.
  Opening a session adds transcript actions: `/bottom`, `/expand`, `/collapse`.
  On the dashboard, model/thinking choices apply to **new tasks**, not the selected
  session; in an open session they apply to that session.
  `/help` lists the current view's commands plus the shortcut reference;
  `/skills` opens the skill picker. Manually entering a transcript command outside
  an open session shows a notice instead of starting a task.
- Type `@` to find files in the selected project's directory. Recursive search
  uses an existing `fd` / `fdfind` on PATH or Pi's installed copy; zz never downloads
  it. Without fd, `@` still completes directory/file prefixes (e.g. `@src/`).
- Press Tab to complete a path at the cursor, including `./`, `../`, `~/`, absolute
  paths, and quoted paths with spaces. Peek replies use that session's project.
- With suggestions open, arrows or Ctrl+N/P select; Tab or Enter fills the draft
  **without sending**. Press Enter again to run a command or send the prompt.
  Escape dismisses suggestions first, preserving the draft, before leaving the view.
  Outside completion, existing project and tool navigation shortcuts are unchanged.

Text-file references insert paths, not file contents; ask the agent to read them
when needed. Explicit `@` image references attach image content on send. Peek
replies offer file/path completion and clipboard images, not dashboard commands.

## Skills

- `/skills` opens a searchable picker for the selected project (or open session).
  Selecting a skill fills `/skill:name ` in the composer; add your request and
  press Enter to load it.
- `/skill:name [request]` explicitly loads the skill instructions into the model's
  input, including skills marked `disable-model-invocation`. The transcript keeps
  your short command and a collapsed skill card with the loaded text.
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

Click **Scroll to bottom**, press Ctrl+End, or enter `/bottom` to jump to the end
and resume following. Scrolling back to the bottom manually also resumes following.
The jump control appears only when a chat is scrolled away from the end. Project
and session lists never follow chat output.

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
  Escape in the session or `/stop` cancels the active work and withdraws queued replies.
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
- Ctrl+O switches to project management. `a` adds an existing directory;
  Enter selects a project and returns to sessions. `~` paths are supported.
- Ctrl+X on a session replaces its row preview with **ctrl+x again to delete** in red (no popup).
  Any other key cancels. Deleting stops its active work and removes it from the list.
- Ctrl+X on a project marks only its session rows for deletion in red; the project header stays unchanged.
  Ctrl+X again stops and deletes all its sessions, keeping the project in the list.
  This also works in project management. Any other key cancels. Project files are never deleted.
- Escape dismisses suggestions/dialogs first. In a session it stops active model
  and tool work, preserves history and your draft, and stays in the session.
- Left Arrow or Ctrl+H returns to the dashboard only when the composer is empty.
  With text, normal editing behavior is preserved. Going back does not stop a running task.
- `/stop` stops the open or selected session without deleting it. Repeated Escape
  while stopping does not leave the session. Reply when stopped to continue with
  the same conversation; stopped work is not automatically resumed on restart.
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
Agents are instructed to use the explicit `ask_user` tool whenever they expect an
answer, including conversational/random questions, clarification, decisions, and
approval requests. These all enter `needs-input` until you reply. Rhetorical,
quoted, or example questions do not require the tool; a question mark in ordinary
prose alone does not change the session state.

## Persistence And Execution

Data lives in `$XDG_DATA_HOME/zz` (default `~/.local/share/zz`). Override it with
`--data-dir PATH` or `ZZ_DATA_DIR`.

- `state.json`: project list, selection, session index, and cached display history.
- `sessions.sqlite`: durable conversations, model context, tools, and checkpoints.
- `undo/`: persistent file backups for `/undo` (may contain sensitive source contents).
- A heartbeat lock permits only one dashboard per data directory. After a crash,
  allow 10 seconds for the stale lock to expire.

Each session has a separate conversation and working directory; sessions can run
concurrently. The process never changes its global working directory. Startup
registers the launch directory and selects it. Closing checkpoints running work;
reopening resumes it, deduplicating previously submitted input. Work does not run
while zz is closed. An interrupted model request may be retried and billed again.
Forced shutdown relies on the last committed durable checkpoint; pending inputs
were saved before execution. It does not undo effects of tools already executed.

**Agents can read/write files and execute shell commands with your permissions.**
A project directory is not a sandbox or Git worktree. Concurrent sessions in the
same directory can edit the same files. Only use trusted projects and prompts.
zz supplies skill discovery, explicit skill loading and automatic instruction-file
loading. Coding-agent extensions and MCP are not loaded by this application.

Deleting sessions individually or by project never deletes project files. Session
deletion removes its UI record, but the underlying durable audit history remains
in SQLite (the current durable API has no conversation-purge operation). Back up
the complete data directory while zz is stopped if you need to preserve it.

## Releases

Pushing a stable version tag runs `.github/workflows/release.yml`. It type-checks,
executes the test suite, and smoke-tests the packaged command on macOS/Linux with
Node.js 22.19 and 24. Only after all checks pass does it create a GitHub release
with `zz.tgz`, `zz.tgz.sha256`, and `install.sh`. No npm registry publish or npm
publish token is needed; the workflow uses the repository's `GITHUB_TOKEN`.

For the first release, commit the release setup and push it along with the tag:

```sh
git tag v0.0.1
git push origin main
git push origin v0.0.1
```

For subsequent releases, run `npm version patch --no-git-tag-version` (or choose
`minor`/`major`), commit both package files, then tag that commit with the matching
`vX.Y.Z`. Packaging rejects mismatches between the tag, package.json, and lockfile.

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

Tests cover project scoping, peek/reply/open, project removal and restoration,
double-confirm deletion, narrow and wide-character rendering, real durable
storage and tools with an offline test provider, interrupted-run recovery, skill
discovery/loading, thinking cycling, follow-end/jump-to-bottom scrolling, and
context/usage accounting, title overhead, restore, and narrow usage dialogs.
Compaction tests cover manual instructions, no-ops, concurrent responses, history
and spend retention, cancellation, restart, background/blocking thresholds, overflow
recovery, failures, and narrow activity rendering.
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
