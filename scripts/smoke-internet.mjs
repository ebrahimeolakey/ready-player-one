// Explicit internet route test. Only synthetic temporary workspace data is shared.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { Hub } from "../core/hub.mjs";
import { HubClient } from "../core/client.mjs";
import { Tunnel, makeInvitation, parseInvitation } from "../core/tunnel.mjs";
if (!process.argv.includes("--live"))
  throw Error(
    "Use --live to start a temporary public tunnel with synthetic test data",
  );
process.env.RPO_BIN_DIR = join(homedir(), ".ready-player-one/bin");
const dir = await mkdtemp(join(tmpdir(), "rpo-internet-")),
  hub = new Hub(dir),
  tunnel = new Tunnel(),
  host = new HubClient(),
  guest = new HubClient(),
  bad = new HubClient();
const secret = () => randomBytes(32).toString("hex");
try {
  await hub.listen();
  await host.connect(`ws://127.0.0.1:${hub.port}`, {
    token: hub.db.hostToken,
    name: "Test host",
    secret: secret(),
  });
  const workspace = await host.call("workspace.create", {
    name: "Synthetic internet test",
  });
  await host.call("workspace.create", { name: "Private synthetic workspace" });
  const session = await host.call("session.create", {
    workspaceId: workspace.id,
    title: "Public WSS route verification",
  });
  const invite = await host.call("invite.create", {
    workspaceId: workspace.id,
  });
  console.log("Starting temporary public tunnel...");
  const endpoint = await tunnel.start(hub.port);
  console.log("Tunnel registered; verifying public WSS...");
  const parsed = parseInvitation(
    makeInvitation({
      server: endpoint.replace("https:", "wss:"),
      token: invite.token,
      sessionId: session.id,
    }),
  );
  // New Quick Tunnel DNS can take a few seconds to propagate.
  let connected = false;
  for (let i = 0; i < 5; i++) {
    try {
      await guest.connect(parsed.url, {
        token: parsed.token,
        name: "Remote route guest",
        secret: secret(),
      });
      connected = true;
      break;
    } catch (e) {
      guest.close();
      if (i === 4) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  assert.ok(connected);
  assert.equal(guest.state.workspaces.length, 1);
  await guest.call("comment.add", {
    sessionId: session.id,
    text: "Public encrypted route connected",
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    host.state.sessions[0].comments.at(-1).text,
    "Public encrypted route connected",
  );
  await assert.rejects(
    bad.connect(parsed.url, {
      token: secret(),
      name: "Invalid guest",
      secret: secret(),
    }),
    /失效/,
  );
  bad.close();
  await host.call("invite.revoke", { workspaceId: workspace.id });
  await new Promise((r) => setTimeout(r, 500));
  assert.notEqual(guest.ws.readyState, 1);
  console.log(
    "PASS: public WSS → scoped invitation → guest comment → host sync → invalid auth rejected → revocation disconnect",
  );
} finally {
  guest.close();
  bad.close();
  host.close();
  tunnel.stop();
  await hub.close();
  await rm(dir, { recursive: true, force: true });
}
