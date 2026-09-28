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
  }, 110000);
  dialog.showErrorBox = (title, message) => {
    console.error(title, message);
    app.exit(1);
  };
  try {
    const { Hub } = await import("../core/hub.mjs");
    let testHub; const listen = Hub.prototype.listen;
    Hub.prototype.listen = async function(...args) { const result=await listen.apply(this,args); testHub=this; return result; };
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
    Hub.prototype.listen = listen;
    const js = (code) => win.webContents.executeJavaScript(code).catch(error => {
      console.error("Failed renderer step:", code);
      throw error;
    }),
      invoke = (method, args = {}) =>
        js(
          `window.rpo.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`,
        );
    const team = await invoke("workspace.create", { name: "星河团队" });
    const project = await invoke("collab.project.create", {
      teamId: team.id,
      name: "秋季发布",
      repository: "example/project", branch: "main", subPath: "docs",
      requestKey: "fixture-project",
    });
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [checkout],
    });
    await assert.rejects(invoke("collab.checkout.map", {projectId:project.id,mode:"repository"}), /本地工作文件夹/);
    assert.equal((await invoke("bootstrap")).local.projectCheckouts[project.id], false);
    dialog.showOpenDialog = async () => ({canceled:true,filePaths:[]});
    assert.equal(await invoke("collab.checkout.map",{projectId:project.id,mode:"folder"}),null);
    assert.equal((await invoke("bootstrap")).local.projectCheckouts[project.id], false);
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[checkout]});
    await invoke("collab.checkout.map", { projectId: project.id, mode:"folder" });
    assert.equal((await invoke("bootstrap")).local.projectCheckoutModes[project.id],"folder");
    let state = await invoke("bootstrap"),
      channel = state.collaboration.channels.find(
        (c) => c.projectId === project.id,
      );
    await js(
      '[...document.querySelectorAll(".nav-item")].find(b=>b.textContent==="项目").click()',
    );
    await until(
      () => js('!!document.querySelector(".project-composer")'),
      "project room without session",
    );
    // Read-only GitHub responses are synthetic; configuration is persisted by the real Hub.
    const {GithubRepositoryService}=await import("../desktop/services/github-repository.mjs");
    const originalApi=GithubRepositoryService.prototype.api;
    GithubRepositoryService.prototype.api=async function(path,options){
      if(path==='repos/example/output')return {id:123,full_name:'example/output',default_branch:'main',private:true,permissions:{push:true}};
      if(path==='repos/example/output/branches/main')return {name:'main'};
      return originalApi.call(this,path,options);
    };
    await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="PR 目标").click()');
    await until(()=>js('!!document.querySelector(".github-target-form")'),"PR target form");
    for(const [label,value] of [['PR 目标仓库','example/output'],['PR 目标分支','main'],['PR 目标目录','drafts']]){
      await js(`(()=>{const el=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    }
    await js('[...document.querySelectorAll(".github-target-form button")].find(b=>b.textContent==="保存 PR 目标").click()');
    await until(async()=>((await invoke('bootstrap')).collaboration.projects.find(p=>p.id===project.id).githubTarget?.repository==='example/output'),"shared PR target saved");
    assert.equal((await invoke('bootstrap')).collaboration.projects.find(p=>p.id===project.id).repository,'example/project');
    await writeFile(join(dir,'github-target.png'),(await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('[aria-label="项目 PR 目标"] [aria-label="关闭"]').click()`);
    GithubRepositoryService.prototype.api=originalApi;
    await invoke("accounts.refresh");
    await js(
      `document.querySelector('[aria-label="添加团队 Agent"]').click()`,
    );
    await until(
      () => js('!!document.querySelector(".local-setup")'),
      "local onboarding",
    );
    await sleep(150);
    await writeFile(join(dir, "onboarding-computer.png"), (await win.webContents.capturePage()).toPNG());
    await js(
      '[...document.querySelectorAll(".local-setup button")].find(b=>b.textContent.includes("下一步：选择 AI")).click()',
    );
    await until(
      () => js('!!document.querySelector(".setup-provider-options")'),
      "provider step",
    );
    await js(
      'document.querySelector(".local-setup [aria-label=选择模型]").click()',
    );
    await until(
      () =>
        js(
          '[...document.querySelectorAll(".provider-model-list button")].some(b=>b.textContent.includes("Fixture Model"))',
        ),
      "actual provider model catalog",
    );
    await js(
      '[...document.querySelectorAll(".provider-model-list button")].find(b=>b.textContent.includes("Fixture Model")).click()',
    );
    await sleep(150);
    await writeFile(join(dir, "onboarding-model.png"), (await win.webContents.capturePage()).toPNG());
    await js(
      '[...document.querySelectorAll(".local-setup button")].find(b=>b.textContent.trim()==="下一步").click()',
    );
    await js(
      '[...document.querySelectorAll(".local-setup button")].find(b=>b.textContent==="连接并加入项目").click()',
    );
    await until(
      () =>
        js(
          '[...document.querySelectorAll(".local-setup button")].some(b=>b.textContent==="进入项目群")',
        ),
      "agent ready",
    );
    await js(
      '[...document.querySelectorAll(".local-setup button")].find(b=>b.textContent==="进入项目群").click()',
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
    await js('document.querySelector("#project-tasks-tab").click()');
    await until(
      () => js('!!document.querySelector(".project-task-card")'),
      "project board",
    );
    assert.equal(
      await js('document.querySelectorAll(".project-task-card").length'),
      1,
    );
    assert.equal(
      await js(
        'document.querySelector(".project-task-card").closest(".project-board-column").getAttribute("aria-label")',
      ),
      "待办",
    );
    assert.equal(
      await js('!!document.querySelector(".project-artifact")'),
      false,
    );
    await js('document.querySelector(".project-task-card").click()');
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
    await until(
      () =>
        js(
          'document.querySelector(".task-session-execution > header")?.textContent.includes("待验收")',
        ),
      "review column updates",
    );
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
    assert.equal(
      state.sessions.find((s) => s.id === task.sessionId).lanes[0].configuration
        .model,
      "fixture-model",
    );
    await js(
      '[...document.querySelectorAll(".task-session-tabs button")].find(b=>b.textContent==="IDE").click()',
    );
    await until(
      () => js('!!document.querySelector(".task-session-ide .studio")'),
      "full IDE inside shared task",
    );
    for (const label of ["文件", "查找文件", "源代码管理", "浏览器", "调试"])
      assert.equal(
        await js(
          `!!document.querySelector('.task-session-ide [aria-label="${label}"]')`,
        ),
        true,
      );
    await writeFile(
      join(dir, "task-ide.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js(
      '[...document.querySelectorAll(".task-session-tabs button")].find(b=>b.textContent==="会话").click()',
    );
    // Group chat and preview have positive visible size at both supported widths.
    for (const [theme, width] of [
      ["dark", 1440],
      ["light", 1080],
    ]) {
      await invoke("settings.general.save", { settings: { theme } });
      win.setSize(width, 900);
      await sleep(250);
      const layout = await js(
        `(()=>{const q=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right}};return {chat:q('.task-session-execution'),artifact:q('.artifact-frame'),width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};})()`,
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
    await js(
      '[...document.querySelectorAll(".session-topbar button")].find(b=>b.textContent==="返回项目").click()',
    );
    await until(
      () => js('!!document.querySelector("#project-tasks-tab")'),
      "return to project",
    );
    await js('document.querySelector("#project-tasks-tab").click()');
    await until(
      () =>
        js(
          '!!document.querySelector(".project-board-column.done .project-task-card")',
        ),
      "acceptance updates board",
    );
    for (const [theme, width] of [
      ["dark", 1440],
      ["light", 1080],
    ]) {
      await invoke("settings.general.save", { settings: { theme } });
      win.setSize(width, 900);
      await sleep(200);
      assert.equal(
        await js("document.documentElement.scrollWidth > innerWidth"),
        false,
      );
      await writeFile(
        join(dir, `board-${theme}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    const second = await invoke("collab.project.create", {
      teamId: team.id,
      name: "独立项目",
      requestKey: "second-project",
    });
    await until(
      () =>
        js(
          '[...document.querySelectorAll(".project-tree > button")].some(b=>b.textContent==="独立项目")',
        ),
      "second project visible",
    );
    await js(
      '[...document.querySelectorAll(".project-tree > button")].find(b=>b.textContent==="独立项目").click()',
    );
    await until(
      () => js('!!document.querySelector(".project-board-empty")'),
      "empty project board",
    );
    assert.equal(
      await js('document.querySelectorAll(".project-task-card").length'),
      0,
    );
    assert.equal(
      await js('!!document.querySelector(".project-artifact")'),
      false,
    );
    state = await invoke("bootstrap");
    const secondChannel = state.collaboration.channels.find(
      (c) => c.projectId === second.id,
    );
    await invoke("collab.task.propose", {
      channelId: secondChannel.id,
      goal: "独立项目的任务",
      acceptance: "仅在本项目显示",
      artifactPath: "note.md",
      mode: "workspace-write",
      requestKey: "second-task",
    });
    await until(
      () =>
        js(
          'document.querySelector(".project-task-card")?.textContent.includes("独立项目的任务")',
        ),
      "second project task",
    );
    await js(
      '[...document.querySelectorAll(".project-tree > button")].find(b=>b.textContent==="秋季发布").click()',
    );
    await until(
      () =>
        js(
          '!!document.querySelector(".project-board-column.done .project-task-card")',
        ),
      "return to first project",
    );
    assert.equal(
      await js('document.querySelectorAll(".project-task-card").length'),
      1,
    );
    assert.equal(
      await js(
        'document.querySelector(".project-task-board").textContent.includes("独立项目的任务")',
      ),
      false,
    );
    await js('document.querySelector("#project-discussion-tab").click()');
    await until(
      () => js('!!document.querySelector(".project-composer")'),
      "return to discussion",
    );
    const research = await invoke("session.create", {
      workspaceId: team.id,
      projectId: project.id,
      title: "研究与说明",
    });
    const researchLane = await invoke("lane.create", {
      sessionId: research.id,
      provider: "claude",
    });
    const briefPath = join(checkout, "brief.md");
    await writeFile(briefPath, "# 项目说明\n\n第一版内容");
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [briefPath],
    });
    const shared = await invoke("collab.output.track", {
      sessionId: research.id,
      laneId: researchLane.id,
    });
    await js('document.querySelector("#project-artifacts-tab").click()');
    await until(
      () => js('document.querySelectorAll(".project-output-card").length===2'),
      "multiple session outputs in project",
    );
    await js(
      '[...document.querySelectorAll(".project-output-card")].find(b=>b.textContent.includes("brief.md")).click()',
    );
    await until(
      () =>
        js(
          'document.querySelector(".project-output-preview .artifact-frame")?.getAttribute("srcdoc").includes("第一版内容")',
        ),
      "live output initial publish",
    );
    await writeFile(briefPath, "# 项目说明\n\n第二版实时更新");
    await until(
      () =>
        js(
          'document.querySelector(".project-output-preview .artifact-frame")?.getAttribute("srcdoc").includes("第二版实时更新")',
        ),
      "live output updates without finishing a run",
    );
    assert.equal(
      (await invoke("bootstrap")).collaboration.artifactVersions.filter(
        (v) => v.outputId === shared.id,
      ).length,
      2,
    );
    await js(
      '(()=>{const el=document.querySelector("[aria-label=共享产物版本]");el.value=[...el.options].find(o=>o.textContent==="v1").value;el.dispatchEvent(new Event("change",{bubbles:true}));})()',
    );
    await until(
      () =>
        js(
          'document.querySelector(".project-output-preview .artifact-frame")?.getAttribute("srcdoc").includes("第一版内容")',
        ),
      "old output versions remain readable",
    );
    await writeFile(
      join(dir, "project-artifacts.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    // Sessions overview spans teams; a team filter narrows the same session records.
    const otherTeam = await invoke("workspace.create", { name: "另一个团队" });
    await invoke("session.create", {
      workspaceId: otherTeam.id,
      title: "跨团队会话",
    });
    await js(
      '[...document.querySelectorAll(".nav-item")].find(b=>b.textContent==="会话").click()',
    );
    await until(
      () =>
        js(
          '[...document.querySelectorAll(".card-name")].some(b=>b.textContent==="跨团队会话")',
        ),
      "cross-team sessions",
    );
    assert.equal(
      await js(
        '[...document.querySelectorAll(".card-name")].some(b=>b.textContent==="制作活动发布页")',
      ),
      true,
    );
    await js(
      `(()=>{const el=document.querySelector('[aria-label="筛选团队"]');el.value=${JSON.stringify(team.id)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await until(
      () =>
        js(
          '![...document.querySelectorAll(".card-name")].some(b=>b.textContent==="跨团队会话")',
        ),
      "team filter",
    );
    await js(
      '[...document.querySelectorAll(".card-name")].find(b=>b.textContent==="制作活动发布页").click()',
    );
    await until(
      () => js('!!document.querySelector(".task-session")'),
      "overview opens same task session",
    );
    assert.equal(
      await js('!!document.querySelector("[aria-label=工作视图]")'),
      false,
    );
    const protocol = await readFile(join(dir, "fixture-protocol.log"), "utf8");
    assert.match(protocol, /thread\/resume/);
    assert.match(protocol, /fixture-model/);
    assert.match(protocol, /标题再短一点/);
    assert.equal(
      (await invoke("bootstrap")).collaboration.tasks[0].sessionId,
      current.sessionId,
    );
    const { exerciseTeamwork } = await import("./teamwork-desktop-check.mjs");
    const teamwork = await exerciseTeamwork({invoke,js,win,dir,team,project,hub:testHub});
    const {exerciseArtifactFiles} = await import("./artifact-files-desktop-check.mjs");
    const sharedFiles = await exerciseArtifactFiles({invoke,js,win,dir,team,project,dialog});
    const {exerciseCindy}=await import("./cindy-desktop-check.mjs");
    const cindy=await exerciseCindy({invoke,js,win,dir,team,project});
    const {exerciseBeginnerGuide}=await import('./beginner-guide-desktop-check.mjs');
    const guide=await exerciseBeginnerGuide({invoke,js,win,dir,project});
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
          teamwork,
          sharedFiles,
          cindy,
          guide,
        },
        null,
        2,
      ),
    );
    await invoke('computer.service.configure',{enabled:true});
    win.close();assert.equal(win.isVisible(),false);app.emit('activate');assert.equal(win.isVisible(),true);
    await invoke('computer.service.configure',{enabled:false});
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
  const fixture = `#!${process.execPath}\nimport {createInterface} from 'node:readline';import {writeFileSync,appendFileSync,readFileSync,mkdirSync} from 'node:fs';import {join,dirname} from 'node:path';
if(!process.argv.includes('app-server')){console.log('Logged in using ChatGPT');process.exit(0)}
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let turn=0;
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(join(dir, "fixture-protocol.log"))},line+'\\n');if(m.id===undefined)return;let result={};if(m.method==='model/list')result={data:[{model:'fixture-model',displayName:'Fixture Model',isDefault:true,supportedReasoningEfforts:[]}]};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'fixture-thread'}};if(m.method==='turn/start')result={turn:{id:'fixture-turn'}};send({id:m.id,result});if(m.method==='turn/start'){const input=m.params.input.map(i=>i.text||'').join('\\n');if(input.includes('你是头号玩家的上手助手 Cindy')){setTimeout(()=>{send({method:'item/completed',params:{item:{id:'cindy-message',type:'agentMessage',text:JSON.stringify({text:'可以。先添加一位负责查证资料的调研搭档，再让复核搭档检查产物。',actions:[{type:'agent',label:'添加调研搭档',name:'调研搭档',role:'查证资料并保留来源'}]})}}});send({method:'turn/completed',params:{turn:{id:'fixture-turn',status:'completed'}}});},100);return;}const output=(input.split('当前用户要求（完整原文').at(-1).match(/产物写入：([^\\n]+)/)||[])[1]||'index.html';const path=join(process.cwd(),output.trim());mkdirSync(dirname(path),{recursive:true});let version=1;try{version=readFileSync(path,'utf8').includes('第一版')?2:3}catch{};writeFileSync(path,path.endsWith('.md')?'# 独立协作成果\\n\\n已完成本 Agent 的分工。':'<!doctype html><html><body style="background:#f5f1e9;padding:32px"><p>星河 · 2026</p><h1>'+(version===1?'秋季发布会 · 第一版':'秋季发布')+'</h1><p>十月十二日 · 下午两点</p><hr><p>一起展示新作品，交流下一步计划。</p><script>parent.artifactEscaped=true</script></body></html>');setTimeout(()=>{send({method:'item/completed',params:{item:{id:'message',type:'agentMessage',text:'页面已生成，请预览验收。'}}});send({method:'turn/completed',params:{turn:{id:'fixture-turn',status:'completed'}}});},100);}});\n`;
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
  const child = spawn(electron, [launcher, "--use-mock-keychain"], {
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
