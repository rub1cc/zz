# zz

A small terminal dashboard for agent sessions, grouped by project directory.
Built with `@earendil-works/pi-durable` and `@earendil-works/pi-tui` (pinned to 1.3.0).

## Run

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
`ModelRuntime`: no separate API key or login is required. If you are not already
signed in, run `pi`, use `/login`, and save a model with `/model` (Ctrl+S), then
restart `zz`.

`--model` overrides `ZZ_MODEL`; otherwise zz uses Pi's saved default model.
If the default is unavailable, it prefers a model from a logged-in subscription.
Model choices are stored per session, so changing the flag affects new sessions.
Pi's `auth.json`, `models.json`, and saved model settings are loaded from
`~/.pi/agent` (or `PI_CODING_AGENT_DIR`). Pi handles OAuth token refresh and shared
credential-file locking. Credentials are not copied into zz's database.
The dashboard can open without a login; starting an agent requires a configured
Pi provider. This shares Pi's login and model configuration, not its existing
JSONL conversation history; zz conversations remain in durable storage.

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
This adds visibility only: it does not add `/compact` or change the durable
harness's existing compaction behavior.

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
saved per session and resets with each reply; failures and input requests are
labelled accordingly. Set `ZZ_REDUCED_MOTION=1` to disable shimmer animation
(`NO_COLOR` also disables it).

## Composer Discovery

- Type `/` at the start of a task or session reply to search commands. Session-only
  actions (`/bottom`, `/expand`, `/collapse`) appear only in an open session.
  `/help` opens the shortcut reference; `/skills` opens the skill picker.
- Type `@` to find files in the selected project's directory. Recursive search
  uses an existing `fd` / `fdfind` on PATH or Pi's installed copy; zz never downloads
  it. Without fd, `@` still completes directory/file prefixes (e.g. `@src/`).
- Press Tab to complete a path at the cursor, including `./`, `../`, `~/`, absolute
  paths, and quoted paths with spaces. Peek replies use that session's project.
- With suggestions open, arrows or Ctrl+N/P select; Tab or Enter fills the draft
  **without sending**. Press Enter again to run a command or send the prompt.
  Escape dismisses suggestions first, preserving the draft, before leaving the view.
  Outside completion, existing project and tool navigation shortcuts are unchanged.

File references insert path text, not attachments or file contents. Ask the agent
to read the referenced file when needed. Peek replies offer file/path completion,
not dashboard slash commands.

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
  A running session must finish before it can accept another reply.
- Ctrl+J inserts a newline in task and reply drafts (including peeks); Enter sends.
  Multiline text and pasted blocks are preserved.
- Ctrl+G opens the draft in `$VISUAL`, then `$EDITOR`, falling back to `vim`.
  Save and exit (`:wq` in Vim) to return the text to the composer without sending.
  Use a waiting command for GUI editors (for example, `EDITOR="code --wait"`).
  Editor failures leave the original draft intact; temporary draft files are removed.
- Ctrl+O switches to project management. `a` adds an existing directory;
  Enter selects a project and returns to sessions. `~` paths are supported.
- Ctrl+X on a session opens a confirmation: **ctrl+x again to delete**.
  Any other key cancels. Deleting stops its active work and removes it from the list.
- In project management, Ctrl+X twice removes the project from the list.
  Its sessions and running work are retained; re-adding the path restores the group.
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

Stopping cannot undo file edits or external effects that have already happened.

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
zz supplies skill discovery and explicit skill loading. Coding-agent extensions
and AGENTS.md loading are not automatically provided by the durable package.

Neither deleting a session nor removing a project deletes project files. Session
deletion removes its UI record, but the underlying durable audit history remains
in SQLite (the current durable API has no conversation-purge operation). Back up
the complete data directory while zz is stopped if you need to preserve it.

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
They do not call a paid model provider.
