import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import {
  accountStatus,
  loginCommand,
  sanitizeLog,
  safeAuthUrl,
  validateRepo,
  AccountManager,
} from "../core/accounts.mjs";
import { assetSpec, verifyDigest } from "../core/installers.mjs";
import {
  makeInvitation,
  parseInvitation,
  tunnelAddress,
  Tunnel,
} from "../core/tunnel.mjs";
const fakeChild = () => {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  c.kill = () => c.emit("close", null);
  return c;
};
test("official login commands are allowlisted, with browser and device flows", () => {
  assert.deepEqual(loginCommand("codex"), ["codex", ["login"]]);
  assert.deepEqual(loginCommand("codex", true), [
    "codex",
    ["login", "--device-auth"],
  ]);
  assert.deepEqual(loginCommand("claude"), ["claude", ["auth", "login"]]);
  assert.ok(loginCommand("github")[1].includes("--web"));
  assert.throws(() => loginCommand("shell"));
  assert.equal(
    safeAuthUrl("https://github.com/login/device"),
    "https://github.com/login/device",
  );
  for (const u of [
    "http://github.com",
    "https://github.com.evil.test",
    "file:///etc/passwd",
    "https://me@github.com",
  ])
    assert.equal(safeAuthUrl(u), null);
});
test("status projects only approved account fields, never provider tokens", async () => {
  const status = await accountStatus("claude", async (_cmd, args) => ({
    stdout:
      args[0] === "--version"
        ? "2.0"
        : JSON.stringify({
            loggedIn: true,
            email: "test@example.test",
            accessToken: "SECRET",
            refreshToken: "PRIVATE",
          }),
  }));
  assert.equal(status.authenticated, true);
  assert.equal(JSON.stringify(status).includes("SECRET"), false);
  const codex = await accountStatus("codex", async (_cmd, args) => ({
    stdout: args[0] === "--version" ? "0.1" : "",
    stderr: "Logged in using ChatGPT",
  }));
  assert.equal(codex.authenticated, true);
  const missing = await accountStatus("github", async () => {
    throw Error("not found");
  });
  assert.equal(missing.available, false);
  const unauth = await accountStatus("codex", async (_cmd, args) => {
    if (args[0] === "--version") return { stdout: "0.1" };
    throw Error("not logged in");
  });
  assert.equal(unauth.available, true);
  assert.equal(unauth.authenticated, false);
});
test("login logs redact secrets; auth processes can be cancelled and codes are local", async () => {
  assert.ok(
    !sanitizeLog(
      "token ghp_12345678 access_token=secret sk-abcdefghijklmnopqr",
    ).includes("secret"),
  );
  const child = fakeChild();
  const manager = new AccountManager({
    spawnProcess: () => child,
    status: async (id) => ({ id, available: true, authenticated: true }),
  });
  manager.start("claude");
  child.stdout.write("Open https://claude.ai/oauth/authorize?state=example\n");
  assert.match(manager.jobs.get("claude").url, /claude.ai/);
  let written = "";
  child.stdin.on("data", (d) => (written += d));
  manager.submit("claude", "one-use-code");
  assert.equal(written, "one-use-code\n");
  assert.ok(!manager.jobs.get("claude").log.includes("one-use-code"));
  manager.cancel("claude");
  assert.equal(manager.jobs.get("claude").status, "cancelled");
  await new Promise((r) => setImmediate(r));
  assert.equal(manager.processes.size, 0);
});
test("repository arguments exclude options and path traversal", () => {
  assert.equal(validateRepo("owner/repo.name"), "owner/repo.name");
  for (const r of [
    "--help/x",
    "a/..",
    "a/b/c",
    "https://github.com/a/b",
    "a/b; rm",
    "a/.",
  ]) {
    assert.throws(() => validateRepo(r));
  }
});
test("official installer architecture selection and SHA-256 fail closed", () => {
  for (const arch of ["arm64", "x64"]) {
    assert.ok(
      assetSpec("codex", arch, "darwin").match(
        `codex-${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.tar.gz`,
      ),
    );
    assert.ok(
      assetSpec("github", arch, "darwin").match(
        `gh_2.101.0_macOS_${arch === "arm64" ? "arm64" : "amd64"}.zip`,
      ),
    );
  }
  assert.throws(() => assetSpec("unknown"));
  const data = Buffer.from("official bytes");
  const digest = "sha256:" + createHash("sha256").update(data).digest("hex");
  verifyDigest(data, digest);
  assert.throws(() => verifyDigest(Buffer.from("modified"), digest));
  assert.throws(() => verifyDigest(data, null));
});
test("encrypted invitations roundtrip; insecure endpoints are rejected", () => {
  const token = "a".repeat(64);
  const url = makeInvitation({
    server: "wss://example.trycloudflare.com",
    token,
    sessionId: "session",
  });
  assert.deepEqual(parseInvitation(url), {
    url: "wss://example.trycloudflare.com/",
    token,
    sessionId: "session",
  });
  for (const server of [
    "ws://remote.test",
    "https://remote.test",
    "wss://user:pass@remote.test",
    "wss://remote.test/path",
    "wss://remote.test?token=bad",
  ])
    assert.throws(() => parseInvitation(makeInvitation({ server, token })));
  assert.throws(() =>
    parseInvitation("rpo://join?host=localhost&port=80&token=bad"),
  );
  assert.equal(
    tunnelAddress("URL: https://green-test.trycloudflare.com done"),
    "https://green-test.trycloudflare.com",
  );
});
test("tunnel is ready only after registration, stops cleanly", async () => {
  const child = fakeChild();
  const tunnel = new Tunnel({ spawnProcess: () => child });
  const pending = tunnel.start(12345);
  child.stderr.write("https://green-test.trycloudflare.com\n");
  assert.equal(tunnel.state.status, "starting");
  child.stderr.write("Registered tunnel connection\n");
  assert.equal(await pending, "https://green-test.trycloudflare.com");
  assert.equal(tunnel.state.status, "ready");
  tunnel.stop();
  assert.equal(tunnel.state.status, "off");
});
test("cancelling a starting tunnel rejects its pending invitation", async () => {
  const child = fakeChild();
  const tunnel = new Tunnel({ spawnProcess: () => child });
  const pending = tunnel.start(12345);
  tunnel.stop();
  await assert.rejects(pending, /取消/);
  assert.equal(tunnel.state.status, "off");
});
