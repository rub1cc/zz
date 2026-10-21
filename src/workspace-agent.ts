import { Type } from "@earendil-works/pi-ai";
import type { JsonRepresentation } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, GenerationTask, InboxDoc, LiveDoc, defineDoc, defineExtension, defineTool, hook, section,
  type ConversationId, type EntryId, type Harness, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import type { Project, Session, Workspace } from "./model.js";
import { Store } from "./store.js";
import { UndoDoc } from "./undo.js";
import { Workspaces } from "./workspaces.js";

type StoredWorkspace = JsonRepresentation<Workspace>;
export type WorkspaceHandoff = {
  id: string;
  run: number;
  source: StoredWorkspace;
  target: StoredWorkspace;
  phase: "approval" | "preparing" | "ready" | "bound";
  continuation: string;
  resume?: "continuation" | "queued";
};
export type WorkspaceAgentState = {
  current?: StoredWorkspace;
  pending?: WorkspaceHandoff;
  receipts: Record<string, string>;
  switches?: number;
  deniedRun?: number;
};
export const WorkspaceDoc = defineDoc<WorkspaceAgentState>({
  kind: "zz.workspace", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ receipts: {} }),
});
const encode = (workspace: Workspace): StoredWorkspace => JSON.parse(JSON.stringify(workspace)) as StoredWorkspace;
const output = (text: string, terminate = false) => ({ output: [{ type: "text" as const, text }], ...(terminate ? { control: { terminate: true as const } } : {}) });
const empty = Type.Object({}, { additionalProperties: false });
export const workspaceEnterParameters = Type.Object({
  create: Type.Optional(Type.Object({ baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    branch: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false })),
  path: Type.Optional(Type.String({ minLength: 1 })),
  workspaceId: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

function enterArguments(value: unknown): { create?: { baseRef?: string; branch?: string }; workspaceId?: string; path?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workspace entry requires an object.");
  const args = value as { create?: { baseRef?: string; branch?: string }; workspaceId?: string; path?: string };
  if ([args.create, args.path, args.workspaceId].filter((value) => value !== undefined).length !== 1) throw new Error("Specify exactly one of create, path, or workspaceId.");
  return args;
}

async function withdrawFailedHandoffInputs(tx: Tx, id: ConversationId): Promise<void> {
  const inbox = await tx.doc(InboxDoc, id);
  for (const item of inbox.items) if (item.mode !== "write") tx.settleSubmission(item.id, { status: "unanswered", reason: "workspace_handoff_failed" });
  inbox.items = inbox.items.filter((item) => item.mode === "write");
}

interface WorkspaceAgentHost {
  session(id: ConversationId): Session | undefined;
  assertAvailable(session: Session, paths: readonly string[]): void;
  changed(session: Session): void;
  nameWorkspace(session: Session, signal?: AbortSignal): Promise<string | undefined>;
}

/** Tools prepare a handoff; only the generation's all-tools-settled boundary changes cwd. */
export class WorkspaceAgent {
  harness!: Harness;
  private readonly workspaces: Workspaces;
  constructor(private readonly store: Store, private readonly host: WorkspaceAgentHost) { this.workspaces = new Workspaces(store, (session, signal) => host.nameWorkspace(session, signal)); }

  readonly extension = defineExtension({
    name: "zz-workspaces",
    sections: [section("zz_workspace_policy", () => "Use workspace_list to inspect this session's current checkout and Git worktrees. workspace_enter creates and enters a worktree from main, or enters an existing workspace; workspace_exit returns to main and keeps all checkouts. These are real session handoffs, unlike shell cd. Call workspace_enter or workspace_exit ALONE in a tool round, as its final action: zz ends the turn and automatically continues after switching. Existing edits stay in their original directory. Already-isolated sessions cannot create another new worktree; use an existing one or return to main. External entry requires the user's explicit zz approval; never work around a denial with shell commands. Do not retry a denied handoff until the user requests it. No implicit copies, stashes, merges, or deletions.", { tag: false })],
    tools: [
      defineTool({ name: "workspace_list", description: "List this project's Git worktrees, current binding, branches, local changes, availability, and session sharing. Does not switch or create anything.",
        parameters: Type.Object({ cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
        replay: "safe", callers: ["model"], execute: async (args, api, context) => {
          const session = this.requireSession(api.conversationId);
          const state = await api.snapshot(WorkspaceDoc, api.conversationId, context);
          this.sync(session, state);
          const discovered = await this.workspaces.discover(this.project(session), context.abortSignal);
          // Keep missing session bindings visible, but never treat old registrations as destinations.
          const bindings = this.store.boundWorkspaces.filter((w) => w.projectId === session.projectId
            && !discovered.some((d) => d.path === w.path));
          const listed = [...discovered, ...bindings]
            .sort((a, b) => Number(b.path === session.workspace?.path) - Number(a.path === session.workspace?.path));
          const start = args.cursor ?? 0;
          const page = listed.slice(start, start + (args.limit ?? 25));
          const describe = async (workspace: Workspace) => ({
            workspaceId: workspace.id, current: workspace.path === session.workspace?.path, path: workspace.path, kind: workspace.kind,
            managed: workspace.managed, status: workspace.status,
            sessions: this.store.state.sessions.filter((s) => this.store.sessionPath(s) === workspace.path).length,
            ...await this.workspaces.describe(workspace, context.abortSignal),
          });
          const workspaces = [];
          for (let i = 0; i < page.length; i += 4) workspaces.push(...await Promise.all(page.slice(i, i + 4).map(describe)));
          const next = start + page.length;
          return output(JSON.stringify({ currentWorkspaceId: session.workspace?.id, workspaces, total: listed.length, nextCursor: next < listed.length ? next : null }));
        } }),
      defineTool({ name: "workspace_enter", description: "Create and enter a new Git worktree from the main workspace, or enter a Git worktree by path (or workspaceId from workspace_list). create.baseRef defaults to HEAD; create.branch is optional. Existing edits are not transferred. Call ALONE in a tool round. External checkouts wait for explicit user approval in zz. Ends this turn and automatically continues in the same conversation after a durable handoff. Does not merge or delete anything.",
        parameters: workspaceEnterParameters, prepareArguments: (args) => enterArguments(args), replay: "safe", callers: ["model"],
        execute: async (args, api, context) => this.request(enterArguments(args), false, api, context) }),
      defineTool({ name: "workspace_exit", description: "Return this session to its project's main workspace, keeping its current worktree, branch, edits, and conversation. Call ALONE in a tool round. Ends this turn and automatically continues after switching. If already in main, reports a no-op.",
        parameters: empty, replay: "safe", callers: ["model"],
        execute: async (_args, api, context) => this.request({}, true, api, context) }),
    ],
    hooks: [hook(GenerationTask, { afterTools: async (_assistant, entries, api, context) => {
      await this.finish(api.conversationId, entries, context);
    } })],
  });

  private requireSession(id: ConversationId): Session {
    const session = this.host.session(id);
    if (!session) throw new Error("Workspace tools require an active zz session.");
    return session;
  }

  private project(session: Session): Project {
    const project = this.store.state.projects.find((p) => p.id === session.projectId);
    const path = this.store.workspace(session)?.projectPath;
    if (project) return project;
    if (path) return { id: session.projectId, path };
    throw new Error("This session's project is unavailable.");
  }

  sync(session: Session, state: Readonly<WorkspaceAgentState> | null | undefined): void {
    if (state?.current) {
      const binding = this.store.boundWorkspaces.find((w) => w.id === state.current!.id && w.projectId === session.projectId);
      if (binding) { Object.assign(binding, state.current); session.workspace = binding; }
      else session.workspace = structuredClone(state.current);
    }
    const pending = state?.pending;
    session.workspaceSwitch = pending ? { id: pending.id, phase: pending.phase, workspaceId: pending.target.id, path: pending.target.path } : undefined;
    session.workspaceUndoBoundary = !!state?.switches;
    this.decorate(session);
  }

  decorate(session: Session): void {
    if (!session.workspaceSwitch || session.stopped) return;
    session.status = session.workspaceSwitch.phase === "approval" ? "needs-input" : "working";
    session.preview = session.workspaceSwitch.phase === "approval" ? "Approve external workspace with /workspace."
      : session.workspaceSwitch.phase === "preparing" ? "Preparing workspace..." : "Switching workspace...";
  }

  private async publish(session: Session, id: ConversationId, context: Context): Promise<void> {
    this.sync(session, await this.harness.snapshot(WorkspaceDoc, id, context));
    await this.store.saveAsync(); this.host.changed(session);
  }

  private async request(args: { create?: { baseRef?: string; branch?: string }; workspaceId?: string; path?: string }, exit: boolean,
    api: ToolExecutionApi, context: Context) {
    const session = this.requireSession(api.conversationId);
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    if (live?.tools?.length !== 1 || live.tools[0]?.taskId !== api.taskId) throw new Error("Call workspace_enter or workspace_exit alone in a tool round; no nested or parallel handoffs.");
    const run = live.run?.inputs[0];
    if (run === undefined) throw new Error("Workspace handoff has no active input.");
    const id = String(api.taskId);
    let state = await api.snapshot(WorkspaceDoc, api.conversationId, context);
    if (state?.receipts[id]) {
      const receipt = state.receipts[id];
      return { ...output(receipt, true), ...(JSON.parse(receipt).status === "failed" ? { isError: true } : {}) };
    }
    if (state?.deniedRun === run) throw new Error("The user denied workspace entry in this turn. Wait for a new user request.");
    this.sync(session, state);
    const project = this.project(session);
    const source = this.store.workspace(session) ?? this.store.assignWorkspace(session, project, { kind: "main" });
    let request = state?.pending;
    if (request && request.id !== id) throw new Error("Another workspace handoff is already pending.");
    if (!request) {
      this.host.assertAvailable(session, [source.path]);
      let target: Workspace;
      if (exit) target = this.store.mainWorkspace(project);
      else if (args.create) {
        if (source.kind !== "main") throw new Error("This session already has a worktree. Enter an existing workspace, return to main, or start another session.");
        await this.workspaces.validateNew(project, args.create.baseRef ?? "HEAD", args.create.branch, context.abortSignal);
        const candidate = { ...session };
        target = this.store.assignWorkspace(candidate, project, { kind: "new", baseRef: args.create.baseRef ?? "HEAD" }, args.create.branch);
      } else {
        target = await this.workspaces.resolve(project, args.path ?? args.workspaceId!, context.abortSignal);
      }
      if (source.path === target.path) return output(JSON.stringify({ status: "unchanged", workspaceId: source.id, path: source.path }));
      this.host.assertAvailable(session, [source.path, target.path]);
      request = { id, run, source: encode(source), target: encode(target),
        phase: !exit && target.kind === "worktree" && !target.managed ? "approval" : "preparing",
        continuation: "Continue the user's task in the newly selected workspace. The previous checkout and its edits were kept; do not copy, merge, or delete them implicitly." };
      await api.commit(async (tx) => {
        const doc = await tx.doc(WorkspaceDoc, api.conversationId);
        if (doc.pending && doc.pending.id !== id) throw new Error("Another workspace handoff is already pending.");
        doc.current ??= encode(source); doc.pending ??= request;
      }, context);
      await this.publish(session, api.conversationId, context);
    }
    try {
      if (request.phase === "approval") {
        api.output(`Approval required to enter external workspace ${request.target.path}. Use /workspace to approve or deny.\n`);
        await this.waitForApproval(api, id, context);
      }
      state = await api.snapshot(WorkspaceDoc, api.conversationId, context);
      request = state?.pending;
      if (!request || request.id !== id) throw new Error("Workspace entry was denied or cancelled.");
      if (request.phase === "bound") return output(JSON.stringify({ status: "handoff-recorded", workspaceId: request.target.id }), true);
      const target: Workspace = structuredClone(request.target);
      this.host.assertAvailable(session, [request.source.path, target.path]);
      const candidate = { ...session, workspace: target };
      await this.workspaces.ensure(candidate, project, () => this.host.changed(session), context.abortSignal, false, async (workspace) => {
        // Provisioning must remain replayable without a global workspace inventory.
        await api.commit(async (tx) => {
          const doc = await tx.doc(WorkspaceDoc, api.conversationId);
          if (doc.pending?.id !== id) throw new Error("Workspace handoff was cancelled.");
          doc.pending.target = encode(workspace);
        }, context);
      });
      await this.workspaces.validateExisting(project, target, context.abortSignal);
      this.host.assertAvailable(session, [request.source.path, target.path]);
      await api.commit(async (tx) => {
        const doc = await tx.doc(WorkspaceDoc, api.conversationId);
        if (!doc.pending || doc.pending.id !== id) throw new Error("Workspace handoff was cancelled.");
        doc.pending.target = encode(target); doc.pending.phase = "ready";
      }, context);
      await this.publish(session, api.conversationId, context);
      return output(JSON.stringify({ status: "prepared", workspaceId: target.id, path: target.path,
        note: "The current turn ends here. zz switches at the tool boundary and automatically continues; all edits and checkouts are kept." }), true);
    } catch (error) {
      if (context.abortSignal?.aborted) throw error;
      const message = `Workspace handoff did not complete. The current checkout was kept and queued replies were not executed: ${error instanceof Error ? error.message : String(error)}`;
      await api.commit(async (tx) => {
        const doc = await tx.doc(WorkspaceDoc, api.conversationId);
        if (doc.pending?.id === id) delete doc.pending;
        doc.receipts[id] = JSON.stringify({ status: "failed", message });
        await withdrawFailedHandoffInputs(tx, api.conversationId);
        await tx.appendEntry(api.conversationId, { kind: "zz.workspace_failed", data: { message } });
      }, context);
      await this.publish(session, api.conversationId, context);
      return { ...output(message, true), isError: true };
    }
  }

  private async waitForApproval(api: ToolExecutionApi, id: string, context: Context): Promise<void> {
    const watch = await api.watchDoc(WorkspaceDoc, api.conversationId, context);
    if (!watch) throw new Error("Workspace approval request is missing.");
    try {
      if (watch.value?.pending?.id !== id || watch.value.pending.phase !== "approval") return;
      await new Promise<void>((resolve, reject) => {
        watch.start(async (state) => {
          if (state?.pending?.id !== id || state.pending.phase !== "approval") resolve();
        });
        void watch.closed.then(() => reject(new Error("Workspace approval wait interrupted.")));
      });
    } finally { await watch.stop(); }
  }

  async approve(session: Session, requestId: string, approved: boolean, context: Context): Promise<void> {
    if (session.conversationId === undefined) throw new Error("No workspace approval is pending.");
    const id = session.conversationId as ConversationId;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(WorkspaceDoc, id);
      if (doc.pending?.id !== requestId || doc.pending.phase !== "approval") throw new Error("This workspace approval is no longer pending.");
      if (approved) doc.pending.phase = "preparing";
      else { doc.deniedRun = doc.pending.run; delete doc.pending; }
    }, context);
    await this.publish(session, id, context);
  }

  async cancel(session: Session, context: Context): Promise<void> {
    if (session.conversationId === undefined) return;
    await this.harness.commit(async (tx) => { delete (await tx.doc(WorkspaceDoc, session.conversationId as ConversationId)).pending; }, context);
    await this.publish(session, session.conversationId as ConversationId, context);
  }

  private async finish(id: ConversationId, entries: readonly EntryId[], context: Context): Promise<void> {
    let state = await this.harness.snapshot(WorkspaceDoc, id, context);
    const request = state?.pending;
    if (!request || request.phase === "approval" || request.phase === "preparing") return;
    const session = this.requireSession(id);
    const successful = await this.harness.commit(async (tx) => {
      const results = await Promise.all(entries.map((entry) => tx.entry(entry)));
      return results.some((entry) => entry?.model?.some((m) => m.role === "toolResult" && !m.isError
        && (m.toolName === "workspace_enter" || m.toolName === "workspace_exit")));
    }, context);
    if (!successful || session.stopped) { await this.cancel(session, context); return; }
    if (request.phase === "ready") {
      try {
        this.host.assertAvailable(session, [request.source.path, request.target.path]);
        await this.workspaces.validateExisting(this.project(session), request.target, context.abortSignal);
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        const message = `Workspace handoff failed; the session stayed in its previous checkout: ${error instanceof Error ? error.message : String(error)}`;
        await this.harness.commit(async (tx) => {
          const doc = await tx.doc(WorkspaceDoc, id);
          if (doc.pending?.id !== request.id) return;
          doc.receipts[request.id] = JSON.stringify({ status: "failed", message });
          delete doc.pending;
          await withdrawFailedHandoffInputs(tx, id);
          await tx.appendEntry(id, { kind: "zz.workspace_failed", data: { message } });
        }, context);
        await this.publish(session, id, context); return;
      }
      await this.harness.commit(async (tx) => {
        const doc = await tx.doc(WorkspaceDoc, id);
        const agent = await tx.doc(AgentDoc, id);
        const undo = await tx.doc(UndoDoc, id);
        const inbox = await tx.doc(InboxDoc, id);
        if (doc.pending?.id !== request.id || doc.pending.phase !== "ready" || session.stopped) return;
        agent.cwd = request.target.path;
        doc.current = request.target; doc.pending.phase = "bound";
        doc.pending.resume = inbox.items.some((item) => item.mode !== "write") ? "queued" : "continuation";
        doc.switches = (doc.switches ?? 0) + 1;
        undo.boundary = undo.points.length;
        await tx.appendEntry(id, { kind: "zz.workspace_switched", data: { from: request.source.path, to: request.target.path, requestId: request.id } });
      }, context);
      await this.publish(session, id, context);
    }
    state = await this.harness.snapshot(WorkspaceDoc, id, context);
    if (state?.pending?.id !== request.id || state.pending.phase !== "bound" || session.stopped) return;
    const conversation = (await this.harness.conversation(id, context))!;
    // A stable request ID closes the crash gap between admitting and acknowledging this continuation.
    if (state.pending.resume !== "queued") await conversation.submit({ type: "input", content: request.continuation, whenBusy: "followUp", requestId: `zz-workspace:${request.id}`,
      entry: { kind: "zz.workspace_continue", data: { requestId: request.id, prompt: `Continue in ${request.target.kind === "main" ? "main checkout" : request.target.branch ?? "workspace"}` } } }, context);
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(WorkspaceDoc, id);
      if (doc.pending?.id !== request.id) return;
      doc.receipts[request.id] = JSON.stringify({ status: "entered", workspaceId: request.target.id, path: request.target.path });
      delete doc.pending;
    }, context);
    await this.publish(session, id, context);
  }
}
