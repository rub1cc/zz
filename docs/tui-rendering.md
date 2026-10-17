# TUI Response Inventory

This inventory is based on zz's installed Pi durable 1.3.0 SDK, `applyView` in
`src/engine.ts`, the message types in `src/model.ts`, and the local shell runner.
It describes zz's implementation, not undocumented Claude Code internals.

## Rendering Contract

The existing Pi TUI remains the terminal renderer. No React, Ink, alternate
agent loop, or additional filesystem operations are introduced. Presentation is:

- A prompt marker for sent user text and the editable composer; user text stays literal.
- Sent user text has a full-width light-grey background and dark text, including wrapped and blank lines.
- A filled bullet for assistant Markdown and tool headings.
- An indented result branch for concise tool summaries; shell commands/stdout require expansion.
- A muted thinking heading/body, with the existing visibility and expansion controls.
- Complete SDK edit diffs and numbered written content stay visible in both compact and expanded cards.
- Green additions and red removals retain line numbers and colors across wrapped rows.
- Assistant/tool rows keep the terminal's background; full-width composer borders and wrapped continuation lines remain.

See the rendered example in the README's Compact Activity section. Expansion is
per call ID, not per projected object. A group uses its first member's call ID;
expanding it reveals every member's full arguments, output and details. A group is
one keyboard target; clicking its heading or expanded content toggles the group.
Standalone tools keep their existing per-call controls.
The selected tool/thinking heading uses a selection arrow. Existing keyboard
navigation, follow-end scrolling, and explicit scroll-to-bottom remain intact.

## Message And Tool Scenarios

| Input/state | Compact presentation | Expanded/other behavior |
| --- | --- | --- |
| User prompt, multiline/paste | Prompt marker, literal source, full-width light-grey background, wrapped continuations | Dark readable text; styling resets before assistant/tool rows; never rewrites the model input |
| Assistant text, partial or final | Bullet, streaming Markdown | Same layout after completion |
| Headings, lists, quotes, links | Existing Pi Markdown formatting | Wraps within the response indent |
| Code fences and tables | Existing Pi Markdown code/table renderer | No synthetic tool operation for code in prose |
| Empty assistant text | No phantom text bubble | Images still render if present |
| Provider thinking | Muted thinking heading and body | Click, keyboard, expand/collapse; Show reasoning setting retained |
| Provider-redacted thinking | Redacted placeholder only | Never shows the redacted payload or opaque signatures |
| Tool pending | Tool name/target and Pending | Arguments/output/details available |
| Tool running | Bounded heading and Running; routine calls may be grouped | Shell output stays hidden until expansion, even while streaming |
| Tool done | Tool-specific summary/output preview | Raw arguments, output, and result details |
| Tool error | Warning-colored Error and bounded error output | Diagnostics remain visible even without expansion |
| Tool interrupted/abandoned | Completion not confirmed; excluded from groups | Retained shell output requires expansion; no success claim |
| Read text, empty file | Returned line count when standalone; distinct-file count when grouped | File contents hidden until expansion |
| Read offset/limit/truncation | Returned count, truncation marker when supplied, SDK continuation diagnostics | Counts exclude the appended harness diagnostics |
| Read image | Image count and expand hint | Existing native image renderer/fallback |
| Read SKILL.md / explicit skill load | Skill name, compact status | Instruction text hidden until expansion |
| Write/create/overwrite success | Written content's line count and complete numbered content | Code remains visible; expansion adds raw arguments/output/details |
| Write pending/error/interrupted | Lifecycle status, no successful-write preview | Proposed arguments remain inspectable |
| Edit success with SDK diff | Actual added/removed counts and every colored diff hunk | Code remains visible; expansion adds raw metadata |
| Edit without diff metadata | All retained applied replacement fragments, explicitly without line numbers; unavailable notice if no fragments remain | Never invents file context, diffstats or line numbers |
| Bash / PowerShell, standalone | Tool name plus lifecycle summary; no command text or stdout | Full command/arguments, retained stdout/stderr and diagnostics |
| Adjacent routine reads/shell calls | One line such as Read 1 file, ran 1 shell command | All member calls expand together |
| Running / pending group members | Reading/running/queued counts, not past-tense success | Stable group anchor while calls settle or more calls arrive |
| Generic tool text | Literal six-row output preview, one-row heading | Full retained output and metadata |
| Empty successful shell output | Ran-shell-command summary; no fabricated output | Explicit no-text-output placeholder in expansion |
| Empty successful generic output | Explicit no-text-output result | Does not manufacture results or an exit code |
| Nonzero exit, timeout, truncation, spill path | Error/status plus short diagnostic lines, outside any group | Full raw retained output/details available |
| Direct chat question | Question tool summary and projected question text | Normal composer remains available |
| Structured questions | Question tool summary, existing inline question composer | Option descriptions, validation, review, submit unchanged |
| Historical ask_user calls | Compatible tool heading and question handling | Historical structured answers still recognized |
| Submitted structured answers | Compact question/answer summary | Model receives the original answer payload unchanged |
| Unknown tool name / legacy tool-only message | Generic heading/output fallback | All available arguments/output/details inspectable |
| Image-only user/assistant message | Native image or textual fallback | Existing image caching/conversion unchanged |
| Tool images | Count and expand hint | Native images/fallback when expanded |

Successful write content and edit diffs are never capped to a preview or hidden
by collapse. They wrap to the terminal width and scroll with the transcript;
"always visible" means no expansion is required, not that every row fits on screen.
Pending, failed and interrupted mutations do not claim their proposed code was
applied. Generic output previews remain limited by rendered rows, with an expand
hint when content is omitted. All content is still bounded by what the SDK
retained; a spill-path diagnostic does not load the spill file automatically.
Durations are displayed only when the SDK supplies them. A successful write can
create or overwrite a file; the UI does not claim it necessarily created one.

Every tool heading is limited to one terminal row. Bash/PowerShell headings never
include raw commands (including huge heredocs and inline scripts). Compact shell
errors without structured diagnostics may show one bounded first output line.
Structured diagnostics prioritize errors/warnings and show at most two one-row
messages, with an expansion notice if more exist. Expanded diagnostics retain
their original order. Hiding content is a display preference, not secret
redaction: commands and output remain in durable history and model context.

Only adjacent native read/bash/powershell calls without images, diagnostics,
truncation, errors or interruptions are groupable. Groups do not cross any other
message, including thinking, or mutation/question/skill/compaction cards. A group
counts distinct normalized path strings for file reads and tool invocations for
shell calls. Path aliases are not resolved; shell scripts are not parsed to
infer reads, directories, side effects, or safety. Repeated reads of the same
path within a lifecycle phase count once. Shell calls can mutate files; their
grouping does not imply they are read-only. Local user-entered shell responses
are not grouped or hidden.

## Session And Local States

| State | Presentation |
| --- | --- |
| Waiting for model / working | Existing animated work indicator; thinking when reported by the projection |
| Model retry | Retry message from the session's projected preview |
| Explicit cancellation in progress | Stopping indicator |
| Stopped / paused | Reply-to-continue notice; no false done label |
| Completed / failed / awaiting input | Existing elapsed-time/local completion label, with the actual outcome |
| Question awaiting reply | Explicit waiting-for-answer notice |
| Queued follow-ups / steering / mixed queue | Separate numbered queue, delivery modes and image counts |
| Manual/automatic/overflow compaction | Existing reason, blocking/retry status, failure text |
| Saved compaction summary | Compact tool summary, expandable content |
| Local !command | Prompt marker, explicitly local shell heading, full retained inline output |
| Local shell running/stopping | Waiting/output text and shell lifecycle status |
| Local shell done/failed | Actual exit code/error, including empty output |
| Local shell cancelled/interrupted | Explicit cancelled/interrupted status; never restarted by rendering |
| Local shell output truncation | Existing bounded-tail notice; retained output remains visible |
| No open session | No transcript rows |
| Session switch/reopen | Clears presentation selection/expansion; renders persisted content |
| Resize, narrow widths, Unicode | Wraps response bodies, truncates tool/group headings to one row, drops indentation when space is scarce |
| Reduced motion | Existing ZZ_REDUCED_MOTION / NO_COLOR behavior retained |

The dashboard, authentication/settings dialogs, usage footer, undo picker, and
peek's latest-reply-only scope are unchanged. The shared composer and local shell
heading also use the new markers in peek. Native approval/sandbox prompts,
MCP-specific cards, subagents, and unsupported provider block types are not
invented: zz does not currently expose those event types. Structured approval
questions continue to work through the existing question tools.

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
all retained successful write content and SDK edit diffs remain visible even
when raw tool details are collapsed. There is no new `/diff` panel or filesystem
snapshotting here. Arbitrary shell mutations do not supply structured file diffs
through Pi's Bash result, so zz does not invent them from command text; shell
commands/output retain their existing expansion controls.

The screenshot's failure came from flattening the entire `arguments.command`
into a heading and wrapping that heading without a row bound. zz now never
renders that argument in a collapsed shell heading. Native Claude Code can
classify shell reads/listings and has additional transcript/focus behaviors;
zz deliberately uses conservative adjacent-call groups and preserves its own
keyboard bindings (use `/projects` for project management; click or `/expand`
for tool details).

## Verification

- `test/tool-groups.test.ts`: exact mixed-group output, lifecycle counts,
  boundaries, error breakout, merging/appending, click/keyboard controls, restart,
  saved-history preservation, and bounded headings/diagnostics.
- `test/tool-response.test.ts`: huge heredoc and hidden-stdout regressions;
  real SDK read/write/edit executions against
  temporary files; lifecycle matrix, complete multi-hunk diffs and writes in both
  expansion states, wrapped diff colors, legacy replacement fragments, diagnostics, unknown tools,
  images, sanitization, tiny widths, and expansion.
- `test/transcript-rendering.test.ts`: exact full-conversation output, durable
  streaming projection/card replacement, Markdown variants, images, thinking,
  waiting/retry/stop/queue states, preview clicks, collapse/group/session-switch
  code visibility, and full TUI resize/cursor tests.
- Existing dashboard, question/answer, shell, image, work-timer, and engine suites
  cover the remaining form, persistence, compaction, shell, and recovery behavior.

Tests use the real Pi TUI with a fake terminal and offline fixtures; they do not
certify physical glyph/image placement in every terminal emulator or paid-model
behavior. Source changes must be rebuilt before running the installed dist CLI.
