// Actual Electron main/preload/React + real Hub/ProviderRuntime/child process.
// Synthetic Codex protocol fixture; no model calls and no installed app data.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
const file = fileURLToPath(import.meta.url),
  root = dirname(dirname(file));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  const deadline = Date.now() + 30000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw Error("Timed out: " + label);
    await sleep(60);
  }
}
async function probe() {
  const { app, BrowserWindow, dialog } = await import("electron"),
    dir = process.env.RPO_DATA_DIR;
  const timer = setTimeout(() => {
    console.error("SMOKE_TIMEOUT");
    app.exit(1);
  }, 70000);
  dialog.showErrorBox = (title, message) => {
    console.error(title, message);
    app.exit(1);
  };
  try {
    await import("../desktop/main.mjs");
    await app.whenReady();
    let win;
    await until(async () => {
      win = BrowserWindow.getAllWindows().find((w) =>
        w.getTitle().startsWith("头号玩家"),
      );
      return (
        win &&
        !win.webContents.isLoading() &&
        (await win.webContents.executeJavaScript(
          '!!document.querySelector(".app-shell")',
        ))
      );
    }, "desktop");
    const js = (code) => win.webContents.executeJavaScript(code),
      invoke = (method, args = {}) =>
        js(
          `window.rpo.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`,
        );
    const team = await invoke("workspace.create", { name: "星河团队" });
    const project = await invoke("collab.project.create", {
      teamId: team.id,
      name: "秋季发布",
      requestKey: "fixture-project",
    });
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [checkout],
    });
    await invoke("collab.checkout.map", { projectId: project.id });
    const agent = await invoke("collab.agent.register", {
      teamId: team.id,
      provider: "codex",
      name: "内容 Agent",
      role: "负责人",
    });
    let state = await invoke("bootstrap"),
      channel = state.collaboration.channels.find(
        (c) => c.projectId === project.id,
      );
    await js(
      '[...document.querySelectorAll(".nav-item")].find(b=>b.textContent==="项目群").click()',
    );
    await until(
      () => js('!!document.querySelector(".project-composer")'),
      "project room without session",
    );
    await js(
      `(()=>{const el=document.querySelector('[aria-label="群聊消息"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'发布页需要主题、时间与报名说明。');el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await js('document.querySelector(".project-composer").requestSubmit()');
    await until(
      async () =>
        (await invoke("bootstrap")).collaboration.channelMessages.length === 1,
      "chat persisted",
    );
    state = await invoke("bootstrap");
    const task = await invoke("collab.task.propose", {
      channelId: channel.id,
      goal: "制作活动发布页",
      acceptance: "标题简洁，时间明确",
      artifactPath: "index.html",
      mode: "workspace-write",
      sourceMessageIds: [state.collaboration.channelMessages[0].id],
      requestKey: "fixture-task",
    });
    await until(
      () =>
        js(
          '[...document.querySelectorAll(".task-controls button")].some(b=>b.textContent==="认领")',
        ),
      "claim control",
    );
    await js(
      '[...document.querySelectorAll(".task-controls button")].find(b=>b.textContent==="认领").click()',
    );
    await until(
      () =>
        js(
          '[...document.querySelectorAll(".task-controls button")].some(b=>b.textContent==="开始")',
        ),
      "start control",
    );
    await js(
      '[...document.querySelectorAll(".task-controls button")].find(b=>b.textContent==="开始").click()',
    );
    await until(async () => {
      const t = (await invoke("bootstrap")).collaboration.tasks.find(
        (t) => t.id === task.id,
      );
      if (t.status === "failed")
        throw Error(JSON.stringify(await invoke("bootstrap")));
      return t.status === "review" && t.previewVersionId;
    }, "child process -> artifact -> rendered preview");
    state = await invoke("bootstrap");
    const current = state.collaboration.tasks.find((t) => t.id === task.id);
    assert.equal(state.collaboration.artifactVersions.length, 1);
    assert.equal(
      state.collaboration.artifactVersions[0].previewStatus,
      "ready",
    );
    const frames = win.webContents.mainFrame.frames;
    assert.ok(frames.length >= 1);
    assert.equal(
      await js(
        'document.querySelector(".artifact-frame").getAttribute("sandbox")',
      ),
      "",
    );
    assert.equal(await js("window.artifactEscaped"), undefined);
    // Group chat and preview have positive visible size at both supported widths.
    for (const [theme, width] of [
      ["dark", 1440],
      ["light", 1080],
    ]) {
      await invoke("settings.general.save", { settings: { theme } });
      win.setSize(width, 900);
      await sleep(250);
      const layout = await js(
        `(()=>{const q=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right}};return {chat:q('.project-chat'),artifact:q('.artifact-frame'),width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};})()`,
      );
      assert.ok(layout.chat.width > 240 && layout.artifact.width > 270);
      assert.equal(layout.overflow, false);
      assert.ok(layout.artifact.right <= layout.width + 1);
      await writeFile(
        join(dir, `project-${theme}-${width}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    await js(
      `(()=>{const el=document.querySelector('[aria-label="产物评论"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'标题再短一点');el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await js(
      'document.querySelector(".artifact-comments form").requestSubmit()',
    );
    await until(
      async () =>
        (await invoke("bootstrap")).collaboration.artifactComments.length === 1,
      "version comment",
    );
    await js(
      '[...document.querySelectorAll(".task-controls button")].find(b=>b.textContent==="继续").click()',
    );
    await until(async () => {
      const s = await invoke("bootstrap");
      return (
        s.collaboration.tasks[0].generation === 2 &&
        s.collaboration.tasks[0].status === "review" &&
        s.collaboration.artifactVersions.length === 2 &&
        s.collaboration.artifactVersions[1].previewStatus === "ready"
      );
    }, "continued provider session");
    await js(
      '[...document.querySelectorAll(".artifact-toolbar button")].find(b=>b.textContent==="验收").click()',
    );
    await until(
      async () =>
        (await invoke("bootstrap")).collaboration.tasks[0].status ===
        "accepted",
      "human acceptance",
    );
    const protocol = await readFile(join(dir, "fixture-protocol.log"), "utf8");
    assert.match(protocol, /thread\/resume/);
    assert.match(protocol, /标题再短一点/);
    assert.equal(
      (await invoke("bootstrap")).collaboration.tasks[0].sessionId,
      current.sessionId,
    );
    await writeFile(
      join(dir, "result.json"),
      JSON.stringify(
        {
          passed: true,
          modelCalls: 0,
          syntheticProvider: true,
          realDesktop: true,
          physicalMachines: 1,
          teamId: team.id,
          taskId: task.id,
          versions: 2,
        },
        null,
        2,
      ),
    );
    console.log("PROJECT_DESKTOP_PASS " + dir);
    clearTimeout(timer);
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(timer);
    app.exit(1);
  }
}
async function driver() {
  const { default: electron } = await import("electron");
  const dir = await mkdtemp(join(tmpdir(), "rpo-project-desktop-"));
  await mkdir(join(dir, "bin"));
  const fixture = `#!${process.execPath}\nimport {createInterface} from 'node:readline';import {writeFileSync,appendFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
if(!process.argv.includes('app-server')){console.log('codex fixture');process.exit(0)}
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let turn=0;
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(join(dir, "fixture-protocol.log"))},line+'\\n');if(m.id===undefined)return;let result={};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'fixture-thread'}};if(m.method==='turn/start')result={turn:{id:'fixture-turn'}};send({id:m.id,result});if(m.method==='turn/start'){const input=m.params.input.map(i=>i.text||'').join('\\n');const path=join(process.cwd(),'index.html');let version=1;try{version=readFileSync(path,'utf8').includes('第一版')?2:3}catch{};writeFileSync(path,'<!doctype html><html><body style="background:#f5f1e9;padding:32px"><p>星河 · 2026</p><h1>'+(version===1?'秋季发布会 · 第一版':'秋季发布')+'</h1><p>十月十二日 · 下午两点</p><hr><p>一起展示新作品，交流下一步计划。</p><script>parent.artifactEscaped=true</script></body></html>');setTimeout(()=>{send({method:'item/completed',params:{item:{id:'message',type:'agentMessage',text:'页面已生成，请预览验收。'}}});send({method:'turn/completed',params:{turn:{id:'fixture-turn',status:'completed'}}});},100);}});\n`;
  await writeFile(join(dir, "bin", "codex"), fixture, { mode: 0o700 });
  for (const name of ["claude", "gh", "cloudflared"])
    await writeFile(join(dir, "bin", name), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
  const launcher = join(dir, "launcher");
  await mkdir(launcher);
  await writeFile(
    join(launcher, "package.json"),
    JSON.stringify({
      name: "rpo-project-smoke",
      version: "0.0.0",
      type: "module",
      main: "entry.mjs",
    }),
  );
  await writeFile(
    join(launcher, "entry.mjs"),
    `import ${JSON.stringify(pathToFileURL(file).href)};`,
  );
  const env = { ...process.env, RPO_DATA_DIR: dir };
  for (const k of [
    "ELECTRON_RUN_AS_NODE",
    "RPO_UPDATE_HEALTH_TICKET",
    "RPO_IDENTITY_ISSUER",
    "RPO_IDENTITY_PUBLIC_KEY_FILE",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ])
    delete env[k];
  const child = spawn(electron, [launcher], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (v) => (output += v));
  child.stderr.on("data", (v) => (output += v));
  const timer = setTimeout(() => child.kill("SIGKILL"), 85000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  clearTimeout(timer);
  await writeFile(join(dir, "desktop.log"), output);
  console.log(dir);
  assert.equal(code, 0, output);
  assert.match(output, /PROJECT_DESKTOP_PASS/);
  console.log(output);
}
if (process.versions.electron) void probe();
else await driver();
