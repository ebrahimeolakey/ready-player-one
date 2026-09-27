import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectArtifactSync } from "../desktop/services/project-artifact-sync.mjs";
test("stable file saves publish only registered local outputs, retry failures, and preserve reversions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rpo-output-sync-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "shared.md"), "A");
  await writeFile(join(dir, "private.md"), "DO NOT SHARE");
  const calls = [];
  let reject = false;
  const state = {
    identity: { audience: "server" },
    me: { id: "me" },
    sessions: [{ id: "session", status: "active" }],
    collaboration: {
      tasks: [],
      outputs: [
        {
          id: "out",
          workerId: "me",
          sessionId: "session",
          laneId: "lane",
          teamId: "team",
          path: "shared.md",
        },
        {
          id: "foreign",
          workerId: "someone",
          sessionId: "session",
          path: "private.md",
        },
      ],
    },
  };
  const client = {
    state,
    ws: { readyState: 1 },
    call: async (method, args) => {
      if (reject) {
        reject = false;
        throw Error("暂时离线");
      }
      calls.push({ method, ...args });
    },
  };
  const sync = new ProjectArtifactSync({
    client: () => client,
    root: () => dir,
    interval: 100000,
  });
  t.after(() => sync.dispose());
  await sync.tick();
  assert.equal(calls.length, 0);
  await sync.tick();
  assert.equal(calls[0].content, "A");
  await sync.tick();
  assert.equal(calls.length, 1);
  await writeFile(join(dir, "shared.md"), "B");
  await sync.tick();
  reject = true;
  await sync.tick();
  assert.equal(calls.length, 1);
  assert.equal(sync.status.out.status, "error");
  await sync.tick();
  assert.equal(calls[1].content, "B");
  await writeFile(join(dir, "shared.md"), "A");
  await sync.tick();
  await sync.tick();
  assert.equal(calls[2].content, "A");
  assert.equal(
    calls.some((c) => c.content.includes("DO NOT SHARE")),
    false,
  );
  await symlink(join(dir, "private.md"), join(dir, "alias.md"));
  // An outside-root symlink must never be read or published.
  const outside = await mkdtemp(join(tmpdir(), "rpo-output-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.md"), "OUTSIDE");
  await symlink(join(outside, "secret.md"), join(dir, "escape.md"));
  state.collaboration.outputs[0].path = "escape.md";
  await sync.tick();
  await sync.tick();
  assert.equal(calls.length, 3);
  assert.equal(sync.status.out.status, "error");
});
