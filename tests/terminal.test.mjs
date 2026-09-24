import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { TerminalService } from "../desktop/services/terminal.mjs";
const waitFor = async (predicate, timeout = 7000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("PTY timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
};
test(
  "real PTY supports input, TTY detection, resize, Ctrl-C, exit and owner cleanup",
  { skip: process.platform === "win32" },
  async () => {
    const service = new TerminalService();
    let output = "",
      exited;
    service.on("event", (_owner, event) => {
      if (event.type === "data") output += event.data;
      else exited = event;
    });
    try {
      const { id } = await service.open(17, {
        cwd: tmpdir(),
        cols: 80,
        rows: 24,
      });
      assert.throws(
        () => service.input(18, { id, data: "echo NOT_ALLOWED\r" }),
        /无权/,
      );
      service.input(17, {
        id,
        data: "test -t 0 && printf '%s%s\\n' 'RPO_' 'TTY_OK'\r",
      });
      await waitFor(() => output.includes("RPO_TTY_OK"));
      service.resize(17, { id, cols: 109, rows: 37 });
      service.input(17, { id, data: "stty size\r" });
      await waitFor(() => output.includes("37 109"));
      service.input(17, { id, data: "sleep 30\r" });
      await new Promise((r) => setTimeout(r, 150));
      service.input(17, { id, data: "\x03" });
      service.input(17, {
        id,
        data: "printf '%s%s\\n' 'RPO_' 'INTERRUPTED'\r",
      });
      await waitFor(() => output.includes("RPO_INTERRUPTED"));
      assert.throws(() => service.resize(17, { id, cols: -1, rows: 20 }));
      service.input(17, { id, data: "exit 7\r" });
      await waitFor(() => exited);
      assert.equal(exited.exitCode, 7);
      assert.equal(service.read(17, { id }).exited, true);
      assert.throws(
        () => service.input(17, { id, data: "after exit" }),
        /退出/,
      );
      service.close(17, { id });
      const second = await service.open(17, { cwd: tmpdir() });
      const pid = service.get(17, second.id).process.pid;
      service.closeOwner(17);
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (e) {
          return e.code === "ESRCH";
        }
      });
      assert.equal(service.terminals.size, 0);
    } finally {
      service.closeAll();
    }
  },
);
