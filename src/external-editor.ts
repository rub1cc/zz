import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";

type TerminalUI = Pick<TUI, "start" | "stop" | "requestRender">;
const active = new WeakMap<TerminalUI, { abort: AbortController; done: Promise<void> }>();

export const isExternalEditorOpen = (tui: TerminalUI): boolean => active.has(tui);
export function cancelExternalEditor(tui: TerminalUI): Promise<void> {
  const editor = active.get(tui);
  editor?.abort.abort();
  return editor?.done ?? Promise.resolve();
}

export function editorCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || "vim";
}

/** Temporarily return the terminal to a local editor; never submit the resulting draft. */
export async function editExternally(tui: TerminalUI, text: string, command = editorCommand()): Promise<string> {
  if (active.has(tui)) throw new Error("An editor is already open.");
  const directory = mkdtempSync(join(tmpdir(), "zz-editor-"));
  const file = join(directory, "prompt.md");
  const abort = new AbortController();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let suspended = false;
  active.set(tui, { abort, done });
  try {
    writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    tui.stop();
    suspended = true;
    await new Promise<void>((resolve, reject) => {
      // The command is trusted local configuration. Pass the filename separately so
      // quotes/arguments in $EDITOR work without interpolating a path into shell code.
      const child = process.platform === "win32"
        ? spawn(command, [file], { shell: true, stdio: "inherit", signal: abort.signal })
        : spawn("/bin/sh", ["-c", `exec ${command} "$@"`, "zz-editor", file], { stdio: "inherit", signal: abort.signal });
      let failure: Error | undefined;
      child.on("error", (error) => { failure = error; });
      child.on("close", (code, signal) => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new Error(`Editor exited ${signal ? `with ${signal}` : `with code ${code}`}. Draft kept.`));
      });
    });
    return readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\n$/, "");
  } finally {
    active.delete(tui);
    try { rmSync(directory, { recursive: true, force: true }); }
    finally {
      try { if (suspended && !abort.signal.aborted) { tui.start(); tui.requestRender(true); } }
      finally { finish(); }
    }
  }
}
