import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HubClient } from "../core/client.mjs";
import { ProviderRuntime } from "../core/providers/runtime.mjs";
import { RunCoordinator } from "../core/run-coordinator.mjs";
import { ProjectArtifactSync } from "../desktop/services/project-artifact-sync.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => {
  const end = Date.now() + 25000;
  while (!(await fn())) {
    if (Date.now() > end) throw Error("Team desktop timeout: " + label);
    await sleep(70);
  }
};
export async function exerciseTeamwork({
  invoke,
  js,
  win,
  dir,
  team,
  project,
  hub,
}) {
  const guest = new HubClient();
  let timer, sync, coordinator;
  try {
    const invite = hub.act(
      [...hub.peers.values()].find((p) => p.host),
      "invite.create",
      { workspaceId: team.id, role: "editor" },
    );
    await guest.connect(`ws://127.0.0.1:${hub.port}`, {
      token: invite.token,
      secret: randomBytes(32).toString("hex"),
      name: "同事小林（测试）",
    });
    const remote = await guest.call("collab.agent.register", {
      teamId: team.id,
      projectId: project.id,
      provider: "codex",
      name: "小林的调研 Agent",
      role: "调研",
      requestKey: randomUUID(),
    });
    let state = await invoke("bootstrap");
    const own = state.collaboration.agents.find(
      (a) =>
        a.projectId === project.id &&
        a.workerId === state.me.id &&
        !a.taskId &&
        a.provider === "codex",
    );
    const channel = state.collaboration.channels.find(
      (c) => c.projectId === project.id,
    );
    const root = await invoke("collab.task.propose", {
      channelId: channel.id,
      goal: "两位成员的 Agent 共同交付",
      acceptance: "各自交付独立文件",
      mode: "workspace-write",
      artifactPath: "team-summary.md",
      requestKey: randomUUID(),
    });
    await js(
      '[...document.querySelectorAll(".session-topbar button")].find(b=>b.textContent==="返回项目").click()',
    );
    await until(
      () => js('!!document.querySelector("#project-team-tab")'),
      "project navigation",
    );
    await js('document.querySelector("#project-team-tab").click()');
    await until(
      () => js('document.querySelectorAll(".team-member").length===2'),
      "two member roster",
    );
    assert.equal(
      await js(
        'document.querySelector(".team-space").textContent.includes("小林的调研 Agent")',
      ),
      true,
    );
    assert.equal(
      await js('document.querySelectorAll(".team-onboarding > *").length'),
      4,
    );
    // Member identity must not navigate into its underlying execution workspace.
    await js('[...document.querySelectorAll(".team-agent")].find(b=>b.textContent.includes("小林的调研 Agent")).click()');
    await until(()=>js('!!document.querySelector(".agent-member")'), "member profile from roster");
    assert.equal(await js('!!document.querySelector(".session-topbar")'), false);
    assert.equal(await js('document.querySelector(".agent-member-identity").textContent.includes("同事小林（测试）的 Agent")'), true);
    assert.equal(await js('[...document.querySelectorAll(".agent-member section")].find(e=>e.getAttribute("aria-label")==="Agent 共享会话").textContent.includes("还没有参与任务")'), true);
    await js('document.querySelector("[role=dialog] [aria-label=关闭]").click()');
    await sleep(180);
    await writeFile(
      join(dir, "team-onboarding.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js('document.querySelector("#project-tasks-tab").click()');
    await until(
      () =>
        js(
          '[...document.querySelectorAll(".project-task-card")].some(b=>b.textContent.includes("两位成员的 Agent 共同交付"))',
        ),
      "shared task on board",
    );
    await js(
      '[...document.querySelectorAll(".project-task-card")].find(b=>b.textContent.includes("两位成员的 Agent 共同交付")).click()',
    );
    await until(
      () => js('!!document.querySelector(".task-team-header")'),
      "shared task",
    );
    async function add(agentId, goal) {
      await js(
        '[...document.querySelectorAll(".task-team-header button")].find(b=>b.textContent.includes("添加 Agent 分工")).click()',
      );
      await until(
        () => js('!!document.querySelector(".team-work-form")'),
        "contribution dialog",
      );
      await js(
        `(()=>{const el=document.querySelector('[aria-label="协作 Agent"]');el.value=${JSON.stringify(agentId)};el.dispatchEvent(new Event('change',{bubbles:true}));const text=document.querySelector('[aria-label="协作分工"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(text,${JSON.stringify(goal)});text.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await js('document.querySelector(".team-work-form").requestSubmit()');
      await until(
        () => js('!document.querySelector(".team-work-form")'),
        "contribution created",
      );
      return (await invoke("bootstrap")).collaboration.tasks.find(
        (t) => t.parentTaskId === root.id && t.goal === goal,
      );
    }
    let remoteWork = await add(remote.id, "调研同事的需求");
    assert.equal(remoteWork.status, "proposed");
    assert.equal(remoteWork.workerId, undefined);
    await assert.rejects(
      invoke("collab.task.start", {
        taskId: remoteWork.id,
        revision: remoteWork.revision,
        requestKey: randomUUID(),
      }),
      /控制权/,
    );
    let ownWork = await add(own.id, "制作项目方案");
    assert.equal(ownWork.status, "ready");
    remoteWork = await guest.call("collab.task.claim", {
      taskId: remoteWork.id,
      agentId: remote.id,
      revision: remoteWork.revision,
      seenSeq: guest.state.collaboration.channels.find(
        (c) => c.id === channel.id,
      ).seq,
    });
    const guestRoot = join(dir, "colleague-checkout");
    await mkdir(guestRoot);
    const runtime = new ProviderRuntime();
    coordinator = new RunCoordinator({
      runtime,
      client: () => guest,
      dir: join(dir, "colleague-runs"),
      root: () => guestRoot,
      options: () => ({ command: join(dir, "bin", "codex") }),
    });
    timer = setInterval(() => void coordinator.process(), 80);
    sync = new ProjectArtifactSync({
      client: () => guest,
      root: () => guestRoot,
      interval: 100,
    });
    // Each owner starts only their own lane. These launch independent CLI child processes.
    await js(
      '[...document.querySelectorAll(".task-controls button")].find(b=>b.textContent==="开始").click()',
    );
    remoteWork = await guest.call("collab.task.start", {
      taskId: remoteWork.id,
      revision: remoteWork.revision,
      requestKey: randomUUID(),
    });
    await until(async () => {
      state = await invoke("bootstrap");
      return [ownWork.id, remoteWork.id].every(
        (id) =>
          state.collaboration.tasks.find((t) => t.id === id)?.status ===
          "review",
      );
    }, "both independent provider processes finish");
    const s = state.sessions.find((s) => s.id === root.sessionId);
    assert.equal(s.lanes.length, 2);
    assert.equal(new Set(s.lanes.map((l) => l.ownerId)).size, 2);
    assert.ok(
      s.lanes.every((l) => l.entries.some((e) => e.role === "assistant")),
    );
    assert.ok(
      (await readFile(join(guestRoot, remoteWork.artifactPath), "utf8")).length,
    );
    assert.ok(
      (await readFile(join(dir, "checkout", ownWork.artifactPath), "utf8"))
        .length,
    );
    await guest.call("coordination.message", {
      sessionId: s.id,
      senderLaneId: remoteWork.laneId,
      text: "调研已交付，请主 Agent 参考最新产物。",
    });
    await until(
      () =>
        js(
          'document.querySelector(".task-coordination").textContent.includes("调研已交付")',
        ),
      "shared coordination message",
    );
    await js(
      '[...document.querySelectorAll(".task-agent-tabs button")].find(b=>b.textContent.includes("小林的调研 Agent")).click()',
    );
    await until(
      () =>
        js(
          'document.querySelector(".task-work-goal")?.textContent.includes("调研同事的需求")',
        ),
      "colleague lane view",
    );
    assert.equal(
      await js(
        '[...document.querySelectorAll(".task-controls button")].some(b=>["开始","继续","停止"].includes(b.textContent))',
      ),
      false,
    );
    await until(async () => {
      state = await invoke("bootstrap");
      return [ownWork.id, remoteWork.id].every(
        (id) =>
          state.collaboration.tasks.find((t) => t.id === id)?.previewVersionId,
      );
    }, "both live artifacts previewed");
    await js(
      '[...document.querySelectorAll(".task-team-header button")].find(b=>b.textContent.includes("谁能看到")).click()',
    );
    await sleep(180);
    await writeFile(
      join(dir, "multi-agent-session.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js(
      '[...document.querySelectorAll(".session-topbar button")].find(b=>b.textContent==="返回项目").click()',
    );
    await until(
      () => js('!!document.querySelector("#project-artifacts-tab")'),
      "project artifacts navigation",
    );
    await js('document.querySelector("#project-artifacts-tab").click()');
    await until(
      () => js('document.querySelectorAll(".project-output-card").length>=4'),
      "multi-member project artifact gallery",
    );
    await sleep(180);
    await writeFile(
      join(dir, "team-artifacts.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js('[...document.querySelectorAll(".project-agent")].find(b=>b.textContent.includes("小林的调研 Agent")).click()');
    await until(()=>js('!!document.querySelector(".agent-member")'), "member profile from group sidebar");
    assert.equal(await js('!!document.querySelector(".session-topbar")'), false);
    assert.equal(await js('document.querySelector(".agent-member").textContent.includes("调研同事的需求")'), true);
    await writeFile(join(dir, "agent-member.png"), (await win.webContents.capturePage()).toPNG());
    await js('[...document.querySelectorAll(".agent-member-link")].find(b=>b.textContent.includes("调研同事的需求")).click()');
    await until(()=>js('document.querySelector(".task-work-goal")?.textContent.includes("调研同事的需求")'), "member links to exact shared work");
    return {
      independentIdentities: 2,
      providerProcesses: 2,
      sharedSession: s.id,
      localDirectories: 2,
      remoteOptIn: true,
      memberIdentityNavigation: true,
      modelCalls: 0,
    };
  } finally {
    clearInterval(timer);
    sync?.dispose();
    await coordinator?.close();
    guest.close();
  }
}
