# Projects And Agent Interaction

How work is grouped, where it happens, and how a session gathers decisions from its user.

## Language

**Project**:
A group of related work rooted at a base directory, with one or more workspaces.

**Workspace**:
The directory where sessions do their work. It is either a project's main checkout or a separate Git worktree, and multiple sessions can share it.

**Session**:
A durable agent conversation and its work history, attached to one workspace.
_Avoid_: Thread

**Workspace Handoff**:
A change of a session's working workspace that preserves its conversation. Files and edits stay in their original workspace.

**Workspace Undo Boundary**:
The point where a session changes workspace, beyond which earlier work cannot be undone from the new workspace.

**Managed Worktree**:
A separate Git checkout created by zz, rather than an existing checkout registered by the user.

**Direct Question**:
A request from the agent for an ordinary conversational reply.

**Question Set**:
A group of structured questions whose answers are reviewed and submitted together.
