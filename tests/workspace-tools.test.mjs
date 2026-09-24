import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTools } from "../core/providers/workspace-tools.mjs";
const tools = Object.fromEntries(
  createWorkspaceTools().map((t) => [t.name, t]),
);
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rpo-tools-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  return {
    root,
    cwd,
    context: { cwd, approved: true, mode: "workspace-write" },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("tools expose compatible schemas and guarded file edits operate on real workspace files", async () => {
  const f = await fixture();
  try {
    assert.equal(tools.read_file.readOnly, true);
    assert.equal(tools.list_directory.readOnly, true);
    assert.equal(tools.write_file.readOnly, false);
    assert.equal(tools.run_command.readOnly, false);
    const path = "nested/hello.txt";
    const created = await tools.write_file.execute(
      { path, content: "hello\nworld\n" },
      f.context,
    );
    assert.equal(created.created, true);
    assert.equal(await readFile(join(f.cwd, path), "utf8"), "hello\nworld\n");
    const read = await tools.read_file.execute(
      { path, startLine: 2, maxLines: 1 },
      f.context,
    );
    assert.equal(read.content, "world");
    assert.equal(read.sha256, created.sha256);
    await assert.rejects(
      tools.write_file.execute({ path, content: "blind overwrite" }, f.context),
      /expectedHash/,
    );
    await tools.write_file.execute(
      { path, content: "updated", expectedHash: read.sha256 },
      f.context,
    );
    await assert.rejects(
      tools.write_file.execute(
        { path, content: "stale", expectedHash: read.sha256 },
        f.context,
      ),
      /expectedHash/,
    );
    const listing = await tools.list_directory.execute(
      { path: "." },
      f.context,
    );
    assert.deepEqual(listing.entries, [{ name: "nested", type: "directory" }]);
    await assert.rejects(
      tools.write_file.execute(
        { path: "no.txt", content: "no" },
        { cwd: f.cwd },
      ),
      /审批/,
    );
    await assert.rejects(
      tools.write_file.execute(
        { path: "no.txt", content: "no" },
        { ...f.context, mode: "read-only" },
      ),
      /只读/,
    );
    await assert.rejects(
      tools.read_file.execute({ path: "../outside" }, f.context),
      /目录/,
    );
    await assert.rejects(
      tools.read_file.execute({ path: ".git/config" }, f.context),
      /Git/,
    );
    await assert.rejects(
      tools.read_file.execute({ path: "C:\\outside.txt" }, f.context),
      /目录/,
    );
  } finally {
    await f.cleanup();
  }
});
test(
  "workspace file tools reject symlink escapes and binary/oversized reads",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture();
    try {
      const outside = join(f.root, "private.txt");
      await writeFile(outside, "private stays unchanged");
      await symlink(outside, join(f.cwd, "escape.txt"));
      await symlink(f.root, join(f.cwd, "escape-dir"));
      await assert.rejects(
        tools.read_file.execute({ path: "escape.txt" }, f.context),
        /符号链接/,
      );
      await assert.rejects(
        tools.write_file.execute(
          { path: "escape-dir/private.txt", content: "attack" },
          f.context,
        ),
        /符号链接/,
      );
      assert.equal(await readFile(outside, "utf8"), "private stays unchanged");
      await writeFile(join(f.cwd, "binary"), Buffer.from([0, 1, 2]));
      await assert.rejects(
        tools.read_file.execute({ path: "binary" }, f.context),
        /二进制/,
      );
      await writeFile(join(f.cwd, "large"), Buffer.alloc(1024 * 1024 + 1, 65));
      await assert.rejects(
        tools.read_file.execute({ path: "large" }, f.context),
        /MiB/,
      );
    } finally {
      await f.cleanup();
    }
  },
);
test(
  "shell execution requires host approval, uses workspace cwd and returns bounded stdout/stderr",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        tools.run_command.execute(
          { command: "echo forbidden" },
          { cwd: f.cwd },
        ),
        /审批/,
      );
      await assert.rejects(
        tools.run_command.execute(
          { command: "echo forbidden", approved: true },
          { cwd: f.cwd },
        ),
        /参数/,
      );
      await assert.rejects(
        tools.run_command.execute(
          { command: "echo forbidden" },
          { ...f.context, mode: "read-only" },
        ),
        /只读/,
      );
      const normal = await tools.run_command.execute(
        { command: "pwd; printf 'STDOUT'; printf 'STDERR' >&2" },
        f.context,
      );
      assert.equal(normal.exitCode, 0);
      assert.ok(
        normal.stdout.includes(
          await (await import("node:fs/promises")).realpath(f.cwd),
        ),
      );
      assert.equal(normal.stderr, "STDERR");
      const bounded = await tools.run_command.execute(
        { command: "yes RPO_OUTPUT", maxOutputBytes: 1024 },
        f.context,
      );
      assert.equal(bounded.truncated, true);
      assert.ok(Buffer.byteLength(bounded.stdout + bounded.stderr) <= 1024);
      const timeout = await tools.run_command.execute(
        { command: "sleep 5", timeoutMs: 100 },
        f.context,
      );
      assert.equal(timeout.timedOut, true);
    } finally {
      await f.cleanup();
    }
  },
);
test(
  "AbortSignal kills the real shell process group including a background descendant",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture();
    try {
      const controller = new AbortController(),
        marker = join(f.cwd, "should-not-appear"),
        started = join(f.cwd, "child-started");
      const descendant = `require('fs').writeFileSync(${JSON.stringify(started)},String(process.pid));setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'escaped'),800);setInterval(()=>{},1000)`;
      const script = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`;
      const running = tools.run_command.execute(
        { command: `${quote(process.execPath)} -e ${quote(script)}` },
        { ...f.context, signal: controller.signal },
      );
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          assert.ok(Number(await readFile(started, "utf8")) > 0);
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await new Promise((r) => setTimeout(r, 15));
        }
      }
      controller.abort();
      const result = await running;
      assert.equal(result.aborted, true);
      await new Promise((r) => setTimeout(r, 900));
      await assert.rejects(stat(marker), { code: "ENOENT" });
      const already = new AbortController();
      already.abort();
      await assert.rejects(
        tools.run_command.execute(
          { command: "echo no" },
          { ...f.context, signal: already.signal },
        ),
        { name: "AbortError" },
      );
    } finally {
      await f.cleanup();
    }
  },
);

test("exact-text edits require unique literal matches, detect stale hashes and preserve executable mode/BOM", async () => {
  const f = await fixture();
  try {
    const path = "script.sh";
    const { chmod } = await import("node:fs/promises");
    await writeFile(
      join(f.cwd, path),
      "\ufeff#!/bin/sh\r\necho ONE\r\necho TWO\r\n",
    );
    await chmod(join(f.cwd, path), 0o755);
    const before = await tools.read_file.execute({ path }, f.context);
    const changed = await tools.edit_file.execute(
      {
        path,
        expectedHash: before.sha256,
        oldText: "echo ONE",
        newText: "echo THREE",
      },
      f.context,
    );
    assert.equal(
      await readFile(join(f.cwd, path), "utf8"),
      "\ufeff#!/bin/sh\r\necho THREE\r\necho TWO\r\n",
    );
    if (process.platform !== "win32")
      assert.equal((await stat(join(f.cwd, path))).mode & 0o777, 0o755);
    await assert.rejects(
      tools.edit_file.execute(
        {
          path,
          expectedHash: before.sha256,
          oldText: "echo TWO",
          newText: "other",
        },
        f.context,
      ),
      /已变化/,
    );
    await assert.rejects(
      tools.edit_file.execute(
        {
          path,
          expectedHash: changed.sha256,
          oldText: "echo",
          newText: "printf",
        },
        f.context,
      ),
      /不唯一/,
    );
    await assert.rejects(
      tools.edit_file.execute(
        {
          path,
          expectedHash: changed.sha256,
          oldText: "missing",
          newText: "x",
        },
        f.context,
      ),
      /不存在/,
    );
    await assert.rejects(
      tools.edit_file.execute(
        {
          path,
          expectedHash: changed.sha256,
          oldText: "echo TWO",
          newText: "x",
        },
        { cwd: f.cwd },
      ),
      /审批/,
    );
  } finally {
    await f.cleanup();
  }
});

test("regex search returns real line/column matches, bounds results and skips symlinks", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "note.txt"), "zero\nAlpha 123\nalpha 456\n");
    const found = await tools.search_files.execute(
      { pattern: "alpha \\d+", flags: "i" },
      f.context,
    );
    assert.deepEqual(
      found.matches.map((m) => [m.path, m.line, m.column, m.match]),
      [
        ["note.txt", 2, 1, "Alpha 123"],
        ["note.txt", 3, 1, "alpha 456"],
      ],
    );
    const limited = await tools.search_files.execute(
      { pattern: "alpha", flags: "i", maxResults: 1 },
      f.context,
    );
    assert.equal(limited.matches.length, 1);
    assert.equal(limited.truncated, true);
    const zero = await tools.search_files.execute(
      { pattern: "^", flags: "m" },
      f.context,
    );
    assert.ok(zero.matches.length >= 3 && zero.matches.length <= 4);
    await assert.rejects(
      tools.search_files.execute({ pattern: "[" }, f.context),
      /正则/,
    );
    if (process.platform !== "win32") {
      await writeFile(join(f.root, "secret"), "PRIVATE_REGEX_MARKER");
      await symlink(join(f.root, "secret"), join(f.cwd, "escape"));
      assert.equal(
        (
          await tools.search_files.execute(
            { pattern: "PRIVATE_REGEX_MARKER" },
            f.context,
          )
        ).matches.length,
        0,
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("catastrophic regex is terminated without blocking main-thread timers and can be aborted", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "bad.txt"), "a".repeat(30000) + "!");
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 10);
    try {
      await assert.rejects(
        tools.search_files.execute(
          { pattern: "^(a+)+$", timeoutMs: 150 },
          f.context,
        ),
        /超时/,
      );
    } finally {
      clearInterval(ticker);
    }
    assert.ok(ticks >= 3, `main loop only ticked ${ticks} times`);
    const controller = new AbortController();
    const job = tools.search_files.execute(
      { pattern: "^(a+)+$", timeoutMs: 5000 },
      { ...f.context, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(job, { name: "AbortError" });
  } finally {
    await f.cleanup();
  }
});
