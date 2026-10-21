# TUI Response Inventory

This inventory is based on zz's installed Pi durable 1.3.0 SDK, `applyView` in
`src/engine.ts`, the message types in `src/model.ts`, and the local shell runner.
It describes zz's implementation, not undocumented Claude Code internals.

## Rendering Contract

The existing Pi TUI remains the terminal renderer. No React, Ink, alternate
agent loop, or additional filesystem operations are introduced. Presentation is:

- A prompt marker for sent user text and the editable composer; user text stays literal.
- Sent user text has a full-width light-grey background and dark text, including wrapped and blank lines.
- A filled bullet for assistant Markdown and smaller dots for tool headings; only tool names are bold, not commands, paths or other heading details.
- An indented result branch for concise tool summaries and tail-first streaming shell previews; expansion reveals full commands/output.
- A muted thinking heading/body, with the existing visibility and expansion controls.
- SDK edit diffs default to full and can collapse to 24 rows; numbered writes preview three rows.
- Pi's public `renderDiff()` colors additions/removals and inverses changed words in single-line replacement pairs; numbering, colors and highlights survive wrapping.
- Assistant/tool chrome and diff context keep the terminal's background; changed diff content rows receive subtle fills. Full-width composer borders and wrapped continuation lines remain.

See the README's Compact Activity section for live and settled examples.
Group headers and individual calls have separate identities and expansion state.
Opening a group reveals member headings; opening a member reveals its full result.
Closing a group preserves member state. Global `/expand` and `/collapse` affect
both levels and override local diff views. Keyboard selection visits the group
and its visible members. Header clicks toggle only that level; member/output
clicks toggle only that call. Native images retain their host-owned rendering.

Live previews are view-local. They retain the latest useful executing operation
through settlement and incomplete next arguments, switching to count receipts
when prose or another visible boundary appears. Execution-start observations are
collected during durable projection, not inferred from completion or repaint order.
Historical replay shows summaries. Native call IDs pair slots/results; entry-scoped
presentation IDs distinguish reused provider IDs and preserve streaming identity.
Provider content is projected in original block order to preserve boundaries.

## Message And Tool Scenarios

| Input/state | Compact presentation | Expanded/other behavior |
| --- | --- | --- |
| User prompt, multiline/paste | Prompt marker, literal source, full-width light-grey background, wrapped continuations | Dark readable text; styling resets before assistant/tool rows; never rewrites the model input |
| Assistant text, partial or final | Bullet, streaming Markdown | Same layout after completion |
| Headings, lists, quotes, links | Existing Pi Markdown formatting | Wraps within the response indent |
| Code fences and tables | Existing Pi Markdown code/table renderer | No synthetic tool operation for code in prose |
| Empty assistant text | No phantom text bubble | Images still render if present |
| Provider thinking | Visible reasoning separates groups; hidden reasoning disappears and permits grouping | Standalone controls and Show reasoning are retained |
| Empty non-redacted thinking | No heading, blank row or navigation target | Retained transcript and model context remain unchanged |
| Provider-redacted thinking | Redacted placeholder only | Never shows the redacted payload or opaque signatures |
| Tool pending | Tool name/target and Pending | Arguments/output/details available |
| Tool running | Live target/output preview or bounded standalone heading | Latest three wrapped shell rows remain visible during execution |
| Tool done | Tool-specific summary/output preview | Raw arguments, output, and result details |
| Tool error | Red Failed status, or leading grouped failure count and bounded first diagnostic | Full error and diagnostics remain inspectable |
| Tool interrupted/abandoned | Completion not confirmed; excluded from groups | Retained shell tail remains visible; no success claim |
| Read text, empty file | Distinct-file count receipt or live basename/path preview | Contents hidden until expansion, then highlighted when recognized |
| Read offset/limit/truncation | Requested range in heading; standalone truncation marker and diagnostics | Counts exclude appended harness diagnostics |
| Read image | Can collapse into file counts | Individual expansion reveals native image/fallback |
| Read SKILL.md / explicit skill load | SKILL.md is a regular read; explicit skill loads remain separate compact cards | Instructions stay inspectable |
| Write/create/overwrite success | Written line count and three visual rows of numbered content | Full highlighted content, arguments/output/details |
| Write pending/error/interrupted | Lifecycle status, no successful-write preview | Proposed arguments remain inspectable |
| Edit success with SDK diff | Actual added/removed counts and full Pi-rendered diff initially | Click header/body toggles 24-row preview; global controls override |
| Edit without diff metadata | Retained replacement fragments; no invented line numbers | Same full-default/collapsible behavior as SDK diffs |
| Bash / PowerShell, standalone | First command line, actual duration, explicit lifecycle and three-row tail preview | Full command, retained output and diagnostics |
| Routine reads/shell calls, optionally separated by thinking | Latest live operation, then muted count receipt; singletons included | Group reveals headings; individual results expand independently |
| Running / pending group members | Actual latest-started target; waiting before first start | Replayed queued calls use counts, not invented live previews |
| Generic tool text | Literal three-row leading preview, one-row heading | Full retained output and metadata |
| Empty successful shell output | No output placeholder in live/standalone previews | No invented command output |
| Empty successful generic output | Explicit no-text-output result | Does not manufacture results or an exit code |
| Nonzero exit, timeout, truncation, spill path | Failure details stay visible; warnings/truncation/spill diagnostics stay outside groups | Full retained output/details available |
| Direct chat question | Question tool summary and projected question text | Normal composer remains available |
| Structured questions | Question tool summary, existing inline question composer | Option descriptions, validation, review, submit unchanged |
| Historical ask_user calls | Compatible tool heading and question handling | Historical structured answers still recognized |
| Checklist task tools | Successful rows hidden without splitting activity; failures, warnings and image artifacts remain visible | Global expansion does not reveal successful rows; `/tasks` and checklist unchanged |
| Submitted structured answers | Compact question/answer summary | Model receives the original answer payload unchanged |
| Unknown tool name / legacy tool-only message | Generic heading/output fallback | All available arguments/output/details inspectable |
| Image-only user/assistant message | Native image or textual fallback | Existing image caching/conversion unchanged |
| Tool images | Count and expand hint | Native images/fallback when expanded |

SDK edit diffs are sanitized before calling the public Pi coding-agent
`renderDiff()` helper. Its default system theme initializes once for diffs; zz
retains the generated ANSI through Pi TUI's width-aware wrapping, resetting each
row so inverse highlights cannot spill into padding or later UI. The current Pi
helper only word-highlights exactly one removed line followed by one added line;
multi-line replacement blocks retain line coloring. If word matching normalizes
whitespace, the affected row is rendered separately by Pi to preserve the exact
SDK text. No file reads or invented line numbers are added by the diff renderer;
expanded reads and write previews use Pi language highlighting when recognized. Legacy fragments without SDK diff metadata retain their existing
explicit, unnumbered red/green rendering without row fills.

Numbered added/removed rows receive a faint green/red background, mixed at 12% into
the terminal's reported default background. Fills cover the diff content width,
including the line number, wrapped continuations and trailing space, not the
transcript indent. Pi's inverse word spans remain inside the code; inverse is
closed before padding and each row ends with a style reset. Context rows, tool
headings, summaries and expanded raw sections stay unfilled. The CLI queries
terminal colors at startup without blocking input and invalidates the transcript
when an initial or late background report arrives. Unknown backgrounds and
`NO_COLOR` retain existing unfilled rendering. Colors use Pi TUI's truecolor/256-color
encoding; dark neutral 256-color terminals use a quiet gray approximation rather
than the much stronger dark red/green blocks available in that palette.

Writes preview three visual rows; edit diffs default to full retained content and
can collapse locally to 24 rows. Global controls override local views. Pending,
failed and interrupted mutations never claim proposed code was applied. Read/write
source highlighting is display-only. No source files or spill files are opened by
rendering; counts, diffs and content come only from retained tool data.

Shell headings stay on one row and show only the first command line. Complete
scripts remain expansion-only. Streaming and settled output uses the last three
visual rows; generic tools use the first three. Omission hints report visual row
counts. Empty shell output says No output. Diagnostics prioritize errors/warnings,
show at most two compact lines, and retain all diagnostics on expansion.

Routine native read/bash/powershell calls group, including singletons and failed
inspections. Interrupted calls remain standalone. Image reads can group; non-read
image artifacts remain separate. Truncation, warning and continuation diagnostics
remain standalone. Prose, visible reasoning, mutations, explicit skill loads,
questions, compaction and local shell responses are boundaries. Hidden reasoning,
empty text and successful task rows do not split groups. Thinking visibility is
a display setting, never a change to provider reasoning or saved messages.

File counts deduplicate lexical aliases relative to the workspace (`@`, `~`,
`file://`, `.` and `..`), without filesystem I/O or symlink resolution. Shell
counts are tool invocations, not inferred command effects or read-only guarantees.
Failures lead collapsed receipts and retain a bounded separate diagnostic; live
previews continue to show the actual latest operation with failure details beneath.

While scrolled up, `src/sticky-prompt.ts` displays the prompt owning the top
visible transcript section. Click to jump to its original row. It hides at that
row, at the bottom and on tiny terminals. It uses transcript row positions and
native ScrollView layout; it does not introduce another scroll state or saved data.

## Session And Local States

| State | Presentation |
| --- | --- |
| Waiting for model / working | Animated work indicator plus compact elapsed time; thinking when reported by the projection |
| Model retry | Retry message from the session's projected preview |
| Explicit cancellation in progress | Stopping indicator |
| Stopped / paused | Reply-to-continue notice; no false done label |
| Completed / failed / awaiting input | View-local receipt only for successful runs of at least ten seconds; other states retain explicit notices | Receipts disappear on later activity and do not replay |
| Question awaiting reply | Explicit waiting-for-answer notice |
| Queued follow-ups / steering / mixed queue | Separate numbered queue, delivery modes and image counts |
| Manual/automatic/overflow compaction | Existing reason, blocking/retry status, failure text |
| Saved compaction summary | Compact tool summary, expandable content |
| Session/peek checklist | Height-bounded total/done/in-progress/open summary above composer; amber `■` with bold black active text; no dependency annotations |
| Long checklist | Up to five tasks normally; recent completions prioritized for 30 seconds, then active/ready/blocked/older-completed work; hidden counts by status |
| Dashboard checklist | Same total/done/in-progress/open summary on session rows, including narrow wrapped rows |
| Fitting checklist / full details | Numeric creation order, no task ID prefixes; full details never use overflow priority |
| Checklist recency expiry | Session/peek share conversation-scoped presentation timers; idle/reduced-motion views redraw at 30 seconds; reopened/cleared/deleted/undone state cancels obsolete timers |
| Empty checklist / question wizard | No checklist rows; structured questions retain composer precedence |
| All tasks completed | Finished checklist remains for five seconds, then an atomic reset removes panel rows and dashboard counts |
| Work added/reopened during grace | Cleanup cancels; completed rows remain alongside open work |
| Cleared checklist details | `/tasks` shows an empty list; task tools have no archive or completed-only filter |
| Checklist restart/compaction/undo | Unfinished state and completion deadline persist; overdue lists clear on restore; undo respects the cleanup audit boundary |
| Local !command | Prompt marker, explicitly local shell heading, full retained inline output |
| Local shell running/stopping | Waiting/output text and shell lifecycle status |
| Local shell done/failed | Actual exit code/error, including empty output |
| Local shell cancelled/interrupted | Explicit cancelled/interrupted status; never restarted by rendering |
| Local shell output truncation | Existing bounded-tail notice; retained output remains visible |
| No open session | No transcript rows |
| Session switch/reopen | Clears presentation selection/expansion; renders persisted content |
| Resize, narrow widths, Unicode | Wraps response bodies, truncates tool/group headings to one row, drops indentation when space is scarce |
| Reduced motion | ZZ_REDUCED_MOTION / NO_COLOR disable shimmer and icon animation; working elapsed time still refreshes once per second |

The work indicator appends compact elapsed time, e.g. `(12s)`, `(1m2s)`,
`(2h3m4s)` or `(1d20m15s)`, to working, thinking, retry and stopping states.
Zero-valued units are omitted, with `0s` for a just-started run. It does not
display token counts. Missing start times
show `?s`. Queued replies share the work period; an idle reply resets it.
Completed-work labels and underlying usage accounting are unchanged.

Apart from checklist counts and the new task details dialog, the dashboard,
authentication/settings dialogs, usage footer, undo picker, and peek's
latest-reply-only transcript scope are unchanged. The shared composer and local shell
heading also use the new markers in peek. Native approval/sandbox prompts,
MCP-specific cards, subagents, and unsupported provider block types are not
invented: zz does not currently expose those event types. Structured approval
questions continue to work through the existing question tools.

## Checklist Coverage

`src/tasks.ts` defines the task policy, validated tools and rewindable durable
state. Its model-facing API is `task_update` (atomic create/update/delete batches),
`task_list`, and `task_get`. Each batch publishes one final task graph; failed
batches publish no partial task state. Batch-local references resolve to IDs and
compact ordered results avoid echoing descriptions. Old create handlers remain
executable for recovery, but a request hook removes their definitions before
provider dispatch. Old single-update arguments and stored replay receipts remain
supported, including execution-phase intents that bypass argument preparation.
`src/engine.ts` observes this custom document separately from Pi's built-in
conversation view. `src/task-cleanup.ts` schedules from the persisted completion
deadline and rechecks the list in one transaction before clearing it. It preserves
ID counters and replay receipts, cancels for open work, pauses during undo, and
stops timers before shutdown. The reset appends a model-free `zz.tasks_cleared`
entry in the same commit so the next prompt's undo checkpoint sees the empty
state rather than resurrecting completed tasks. `src/task-display.ts` renders only
committed presentation caches and tracks newly observed completions separately
for display priority. This presentation-only 30-second grace is independent of
the durable five-second all-complete reset. Initial completed rows have no fresh
display grace; undo forks and restarts do not restore it. Dependency IDs affect
ready-versus-blocked overflow priority but are not UI annotations.

`test/tasks.test.ts` covers lifecycle, schemas, cycles, blockers, deletion,
final-graph validation, atomic rollback, local references, compact ordered results,
idempotent replay and bounded rendering. `test/engine.test.ts` exercises actual
SQLite tools, parallel creates, session isolation, compaction, interruption,
restart, stale caches, undo and the three-tool provider surface. Recovery tests
reopen persisted old create/update and new batch execution intents, both before
mutation and after an idempotency receipt was committed. `test/dashboard.test.ts` covers live session/peek
checklists, dashboard counts and scoped, scrollable `/tasks` details across narrow
terminals. `test/task-cleanup.test.ts` uses a manual clock to cover five-second
timing, stale timers, blocked restores, transaction races, shutdown and replay;
engine tests exercise real SQLite persistence, remaining/overdue deadlines,
legacy deadline initialization, routine-context removal and undo on both sides
of cleanup. `test/task-display.test.ts` covers capacity, ordering, readiness,
hidden status counts, exact recency expiry, old restored rows, reopening, stale
timers, per-session isolation and shutdown. Dashboard tests exercise shared
session/peek recency and idle redraw under reduced motion with a manual clock.
`test/tool-response.test.ts` verifies compact cards, expanded raw data
and visible errors; discovery tests cover command availability.

## Claude Code Research

Research uses official published documentation/changelog and the locally installed
`@anthropic-ai/claude-code` 2.1.301 (`claude --version` and its `sdk-tools.d.ts`).
No authenticated Claude session or paid request was launched. These sources
support the compact-vs-expanded design, not a claim that zz duplicates every
version's exact rendering or internal grouping algorithm.

- [Interactive mode](https://code.claude.com/docs/en/interactive-mode#general-controls):
  Ctrl+O opens detailed tool usage and expands default-collapsed rows; the docs
  give an MCP example of a grouped Called-server-N-times line.
- [Fullscreen mouse controls](https://code.claude.com/docs/en/fullscreen#use-the-mouse):
  a collapsed tool call and result expand together, revealing full output.
- [Fullscreen focus view](https://code.claude.com/docs/en/fullscreen):
  `/focus` is a separate quieter mode with the prompt, a one-line tool summary
  including edit diffstats, and the final response. It is not identical to
  normal read/search grouping; zz does not add a `/focus` mode here.
- [Official changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md):
  2.1.20 documents present-tense vs past-tense collapsed read/search groups;
  2.1.45 documents the active file/pattern beneath those groups;
  2.1.149 discusses hidden-line counts in collapsed Bash output;
  2.1.224 explicitly says Bash output is shown to the model, not reliably to the user.
- Installed 2.1.301 `sdk-tools.d.ts`, `BashInput.description`: the optional
  description is intended for users who often do not see the raw command.
  Pi durable 1.3.0's Bash schema has command/timeout, not that description field.
  zz therefore uses a generic honest shell summary instead of guessing a
  description, requesting another model summary, or changing execution schemas.

### Checklist Ordering Research

The installed Claude Code 2.1.301 executable's bundled checklist renderer was
inspected without starting a model request. It chooses zero visible tasks at ten
terminal rows or fewer, otherwise `min(5, max(3, rows - 14))`. A fitting list is
sorted by numeric task ID. On overflow it orders recently observed completions
(first 30 seconds), in-progress tasks, pending tasks with no unfinished blockers,
pending tasks with unfinished blockers, and older completions. IDs order tasks
inside each priority group. Hidden counts are shown by status. Completed rows
present at initial mount are not given fresh recency.

zz follows that capacity and ordering while retaining its own summary styling,
number-free rows, icons/colors and composer-safe space budget. Very constrained
layouts or tall drafts may leave room for fewer items. Session and peek share
presentation recency; the 30-second timer does not mutate durable task state.

### Completed Checklist Cleanup Research

The installed Claude Code 2.1.301 executable's bundled task-list controller and
storage helper were inspected without launching an authenticated model request.
The interactive controller keeps an all-complete list visible for approximately
five seconds, then rechecks and resets the active list under a lock. Its reset
retains the highest task ID. `TaskList` itself returns a snapshot of all current
non-internal tasks, including completed ones before reset; it has no
`includeCompleted` parameter. After reset it returns no tasks, rather than
providing an archive accessible through `TaskGet`.

The [official TaskList reference](https://code.claude.com/docs/en/agent-sdk/typescript#tasklist)
and installed `sdk-tools.d.ts` corroborate the empty input and current-list output
shapes. The five-second reset is version-specific implementation evidence, not
a timing promise in the public documentation. zz adopts the completion grace and
active-list reset, while preserving its own durable audit and undo semantics.

### Code Change Visibility Research

The official interactive/fullscreen documentation and changelog were fetched again
for the code-visibility change. No authenticated session or model request was run.

- [Review changes with /diff](https://code.claude.com/docs/en/interactive-mode#review-changes-with-%2Fdiff)
  documents a live fullscreen diff panel and a classic diff dialog. The panel
  lists changed files with added/removed counts and each file's diff; it can open
  automatically at 144 columns or wider. Turn views track file-tool edits;
  shell changes appear only in the Current working-tree view.
- The same documentation distinguishes working-tree changes from Claude's own
  edits: Current also includes pre-existing and other uncommitted changes.
- Changelog 2.1.246 explicitly bounds extremely long single diff lines to avoid
  transcript slowdowns; Claude does not promise every source byte is always
  expanded. Changelog 2.1.293 warns that files changing during Bash may include
  writes from other processes, so such changes cannot safely be attributed to
  the command alone.

zz adopts an explicit inline policy rather than claiming exact Claude parity:
SDK edit diffs default to full retained content and can collapse to 24 visual
rows; writes use three-row previews. There is no new `/diff` panel or filesystem
snapshotting here. Arbitrary shell mutations do not supply structured file diffs
through Pi's Bash result, so zz does not invent them from command text. Full shell
commands and output remain available through expansion.

The screenshot's failure came from flattening the entire `arguments.command`
into a heading and wrapping that heading without a row bound. zz now shows only
the first command line in standalone shell headings and truncates it to one row;
script bodies stay hidden until expansion. Native Claude Code can
classify shell reads/listings and has additional transcript/focus behaviors;
zz groups only native reads and shells, bridges hidden thinking/bookkeeping, and preserves its own
keyboard bindings (use `/projects` for project management; click or `/expand`
for tool details).

## Verification

- `test/diff-background.test.ts`: light/dark tint values, 256-color fallback,
  unknown backgrounds, no-color behavior, full-width wrapped fills, inverse padding
  boundaries, and unchanged context/chrome/raw sections.
- `test/tool-groups.test.ts`: exact mixed-group output, lifecycle counts,
  boundaries, grouped errors, singleton/live lifecycles, independent click/keyboard controls, replay,
  saved-history preservation, thinking-aware ordering/visibility/redaction, empty
  thinking suppression, stable parallel previews and bounded headings/diagnostics.
- `test/tool-response.test.ts`: huge heredoc, lifecycle-aware shell previews,
  empty results, wrapped preview bounds, heading durations and full-expansion regressions;
  real SDK read/write/edit executions against
  temporary files; lifecycle matrix, collapsible multi-hunk diffs and bounded writes, native Pi word highlights and wrapped ANSI resets, exact SDK text
  when Pi normalizes whitespace, no-color fallback, legacy replacement fragments, diagnostics, unknown tools,
  images, sanitization, tiny widths, and expansion.
- `test/transcript-rendering.test.ts`: exact full-conversation output, durable
  streaming projection/card replacement, Markdown variants, images, thinking,
  waiting/retry/stop/queue states, preview clicks, collapse/group/session-switch
  code visibility, view-local receipts, sticky prompt scroll/click routing, and full TUI resize/cursor tests.
- `test/work.test.ts` and `test/usage.test.ts`: elapsed seconds, reduced-motion
  refresh cadence, per-work token baselines, partial-to-final handoff, retries,
  replay, persistence, unknown legacy measurements and idle-reply resets.
- Existing dashboard, question/answer, shell, image, work-timer, and engine suites
  cover the remaining form, persistence, compaction, shell, and recovery behavior.

Tests use the real Pi TUI with a fake terminal and offline fixtures; they do not
certify physical glyph/image placement in every terminal emulator or paid-model
behavior. Source changes must be rebuilt before running the installed dist CLI.
