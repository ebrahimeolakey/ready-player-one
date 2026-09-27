import { MAX_ARTIFACT_BYTES, filePayload } from "../../core/artifact-files.mjs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { withinProject } from "./project-artifacts.mjs";

// Only explicitly registered outputs and each task's declared deliverable are read.
// Two matching samples avoid publishing a file while it is still being written.
export class ProjectArtifactSync {
  constructor({ client, root, onChange = () => {}, interval = 1200 }) {
    Object.assign(this, { client, root, onChange });
    this.samples = new Map();
    this.status = {};
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }
  setStatus(id, value) {
    if (JSON.stringify(this.status[id]) !== JSON.stringify(value)) {
      this.status[id] = value;
      this.onChange();
    }
  }
  async tick() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const c = this.client(),
        state = c?.state;
      if (!state?.me || c.ws?.readyState !== 1) return;
      const scope = `${state.identity?.audience}:${state.me.id}`;
      if (this.scope !== scope) {
        this.scope = scope;
        this.samples.clear();
        this.status = {};
      }
      const tasks = (state.collaboration?.tasks || []).filter(
        (t) =>
          t.workerId === state.me.id &&
          t.kind !== "planning" &&
          t.runId &&
          ["running", "review"].includes(t.status),
      );
      const outputs = (state.collaboration?.outputs || []).filter(
        (o) =>
          o.workerId === state.me.id &&
          state.sessions.some(
            (s) => s.id === o.sessionId && s.status === "active",
          ),
      );
      const items = [
        ...tasks.map((t) => ({
          id: t.id,
          key: `${t.id}:${t.runId}:${t.generation}`,
          path: t.artifactPath,
          sessionId: t.sessionId,
          laneId: t.laneId,
          workspaceId: t.teamId,
          method: "collab.artifact.publish",
          params: { taskId: t.id, runId: t.runId, generation: t.generation },
        })),
        ...outputs.map((o) => ({
          id: o.id,
          key: o.id,
          path: o.path,
          sessionId: o.sessionId,
          laneId: o.laneId,
          workspaceId: o.teamId,
          method: "collab.output.publish",
          params: { outputId: o.id },
        })),
      ];
      const live = new Set(items.map((i) => i.key));
      for (const key of this.samples.keys())
        if (!live.has(key)) this.samples.delete(key);
      for (const item of items) {
        if (
          this.closed ||
          c !== this.client() ||
          scope !== `${c.state?.identity?.audience}:${c.state?.me?.id}`
        )
          break;
        try {
          const root = this.root(item),
            path = withinProject(root, item.path),
            info = await stat(path);
          if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES)
            throw Error("产物超过 8 MB 或不是文件");
          const content = await readFile(path);
          if (!content.length) continue;
          const digest = createHash("sha256").update(content).digest("hex"),
            prior = this.samples.get(item.key);
          if (!prior || prior.hash !== digest) {
            this.samples.set(item.key, { hash: digest, published: false });
            continue;
          }
          if (prior.published) { this.setStatus(item.id, {status:"synced"}); continue; }
          if (this.closed || c !== this.client() || scope !== `${c.state?.identity?.audience}:${c.state?.me?.id}` || this.root(item) !== root)
            continue;
          await c.call(item.method, { ...item.params, ...filePayload(content, item.path) });
          prior.published = true;
          this.setStatus(item.id, { status: "synced" });
        } catch (e) {
          if (e.code === "ENOENT") continue;
          this.setStatus(item.id, {
            status: "error",
            message: e.code ? "产物暂时无法读取" : e.message,
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  dispose() {
    this.closed = true;
    clearInterval(this.timer);
  }
}
