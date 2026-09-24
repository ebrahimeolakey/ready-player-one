import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { read } from "../core/local.mjs";
import {
  captureReference,
  fileReferences,
  checkReferences,
} from "../desktop/services/references.mjs";
test("non-Git anchors bind selected disk lines to content hash and reject outdated editor state", async () => {
  const root = await mkdtemp(join(tmpdir(), "rpo-reference-"));
  try {
    await writeFile(join(root, "note.txt"), "first\nsecond\nthird");
    const disk = await read(root, "note.txt");
    const anchor = await captureReference(root, {
      path: "note.txt",
      startLine: 2,
      endLine: 3,
      expectedHash: disk.hash,
    });
    assert.equal(anchor.startLine, 2);
    assert.equal(anchor.endLine, 3);
    assert.equal(anchor.hash, disk.hash);
    assert.equal(anchor.commit, disk.hash);
    await assert.rejects(
      captureReference(root, {
        path: "note.txt",
        startLine: 2,
        endLine: 4,
        expectedHash: disk.hash,
      }),
      /范围/,
    );
    await writeFile(join(root, "note.txt"), "changed");
    await assert.rejects(
      captureReference(root, {
        path: "note.txt",
        startLine: 1,
        endLine: 1,
        expectedHash: disk.hash,
      }),
      /已变化/,
    );
    const checked = await checkReferences(root, { references: [anchor] });
    assert.notEqual(checked[0].hash, anchor.hash);
    await rm(join(root, "note.txt"));
    const removed = await checkReferences(root, { references: [anchor] });
    assert.equal(removed[0].unavailable, true);
    assert.equal(removed[0].hash, "0".repeat(64));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Git references record HEAD but hash changes independently for uncommitted edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "rpo-reference-git-"));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git(["init"]);
    git(["config", "user.name", "Reference Test"]);
    git(["config", "user.email", "test@example.test"]);
    await writeFile(join(root, "code.txt"), "original");
    git(["add", "code.txt"]);
    git(["commit", "-m", "initial"]);
    const first = (await fileReferences(root, { paths: ["code.txt"] }))[0];
    assert.equal(first.commit, git(["rev-parse", "HEAD"]));
    await writeFile(join(root, "code.txt"), "uncommitted");
    const second = (await fileReferences(root, { paths: ["code.txt"] }))[0];
    assert.equal(second.commit, first.commit);
    assert.notEqual(second.hash, first.hash);
    git(["commit", "--allow-empty", "-m", "unrelated"]);
    const third = (await fileReferences(root, { paths: ["code.txt"] }))[0];
    assert.notEqual(third.commit, second.commit);
    assert.equal(third.hash, second.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test(
  "references reject traversal and never read escaped symlink targets",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rpo-reference-safe-"));
    try {
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      await writeFile(join(root, "secret"), "PRIVATE");
      await symlink(join(root, "secret"), join(workspace, "link"));
      await assert.rejects(fileReferences(workspace, { paths: ["../secret"] }));
      await assert.rejects(
        fileReferences(workspace, { paths: ["link"] }),
        /符号链接/,
      );
      assert.deepEqual(
        await checkReferences(workspace, { references: [{ path: "link" }] }),
        [
          {
            path: "link",
            hash: "0".repeat(64),
            commit: "0".repeat(64),
            unavailable: true,
          },
        ],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
