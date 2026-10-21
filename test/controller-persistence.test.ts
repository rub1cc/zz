import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Controller } from "../src/controller.js";
import { Store } from "../src/store.js";
import { FakeEngine, temporary } from "./helpers.js";

test("live notifications repaint without starting background saves; persistent changes coalesce and close flushes", async () => {
  const f = temporary(), store = new Store(join(f.root, "data")); store.addProject(f.root);
  const engine = new FakeEngine();
  let emit!: (persist?: boolean) => void;
  let finish!: () => void;
  engine.run = async (_session, _project, _prompt, changed) => {
    emit = changed!;
    await new Promise<void>((resolve) => { finish = resolve; });
  };
  const controller = new Controller(store, engine);
  const save = store.saveAsync.bind(store);
  let saves = 0, repaints = 0;
  store.saveAsync = () => { saves++; return save(); };
  controller.onChange = () => { repaints++; };
  try {
    assert.equal(controller.send("Work"), true);
    await delay(250); await store.flush();
    const before = saves;
    for (let i = 0; i < 20; i++) emit(false);
    await delay(250);
    assert.equal(saves, before);
    assert.ok(repaints >= 20);
    for (let i = 0; i < 20; i++) emit(true);
    await delay(250); await store.flush();
    assert.equal(saves, before + 1);
    finish();
    controller.store.state.sessions[0]!.title = "Final title before close";
    await controller.close();
    assert.equal(new Store(store.root).state.sessions[0]?.title, "Final title before close");
  } finally { finish?.(); await controller.close(); f.cleanup(); }
});
