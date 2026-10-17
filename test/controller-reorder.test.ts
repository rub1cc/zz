import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Controller } from "../src/controller.js";
import type { Session } from "../src/model.js";
import { Store } from "../src/store.js";
import { FakeEngine, temporary } from "./helpers.js";

test("reordering ignores project headings and other projects, and saves the selected project's order", async () => {
  const temp = temporary();
  const store = new Store(join(temp.root, "data"));
  const paths = [join(temp.root, "alpha"), join(temp.root, "beta")];
  for (const path of paths) mkdirSync(path);
  const alpha = store.addProject(paths[0]!); const beta = store.addProject(paths[1]!);
  const session = (id: string, projectId: string, createdAt: number): Session => ({
    id, projectId, title: id, createdAt, updatedAt: createdAt, messages: [], status: "completed", preview: "",
  });
  store.state.sessions.push(session("first", alpha.id, 2), session("second", alpha.id, 1), session("other", beta.id, 3));
  const controller = new Controller(store, new FakeEngine());
  try {
    controller.select(`session:first`);
    controller.reorderSession(1);
    assert.deepEqual(alpha.sessionOrder, ["second", "first"]);
    assert.equal(beta.sessionOrder, undefined);
    assert.deepEqual(controller.currentRows.flatMap((row) => row.kind === "session" ? [row.session.id] : []), ["second", "first", "other"]);
    assert.deepEqual(new Store(store.root).state.projects.find((project) => project.id === alpha.id)?.sessionOrder, ["second", "first"]);
    controller.select(`project:${alpha.id}`);
    controller.reorderSession(-1);
    assert.deepEqual(alpha.sessionOrder, ["second", "first"]);
  } finally { await controller.close(); temp.cleanup(); }
});
