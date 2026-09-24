import { useEffect, useSyncExternalStore } from "react";
import type { ProviderImage } from "./ProviderControls";
type Snapshot = {
  text: string;
  images: ProviderImage[];
  revision: number;
  ready: boolean;
  error: string;
  blocked: boolean;
  busy: boolean;
  conflicts: any[];
};
type Model = {
  snapshot: Snapshot;
  listeners: Set<() => void>;
  loaded: boolean;
  version: number;
  savedVersion: number;
  voiceBase: string;
  queue: Promise<void>;
};
const models = new Map<string, Model>();
function modelFor(id: string) {
  let model = models.get(id);
  if (!model) {
    model = {
      snapshot: {
        text: "",
        images: [],
        revision: 0,
        ready: false,
        error: "",
        blocked: false,
        busy: false,
        conflicts: [],
      },
      listeners: new Set(),
      loaded: false,
      voiceBase: "",
      version: 0,
      savedVersion: 0,
      queue: Promise.resolve(),
    };
    models.set(id, model);
  }
  return model;
}
function publish(model: Model, patch: Partial<Snapshot>) {
  model.snapshot = { ...model.snapshot, ...patch };
  model.listeners.forEach((fn) => fn());
}
export function useComposer(laneId: string) {
  const model = modelFor(laneId);
  const state = useSyncExternalStore(
    (callback) => {
      model.listeners.add(callback);
      return () => {
        model.listeners.delete(callback);
      };
    },
    () => model.snapshot,
  );
  function applySaved(value: any) {
    model.version++;
    model.savedVersion = model.version;
    publish(model, {
      text: value.text,
      images: value.images,
      revision: value.revision,
      ready: true,
      error: value.warning || "",
      blocked: false,
      conflicts: (value.conflicts || []).filter((draft: any) => !draft.resolvedAt),
    });
  }
  async function load() {
    try {
      const saved = await window.rpo.invoke("composer.read", { laneId });
      applySaved(saved);
    } catch (e) {
      publish(model, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  function persist() {
    const task = model.queue.then(async () => {
      if (
        !model.snapshot.ready ||
        model.snapshot.blocked ||
        model.version === model.savedVersion
      )
        return;
      const version = model.version,
        snapshot = model.snapshot;
      const saved = await window.rpo.invoke("composer.save", {
        laneId,
        text: snapshot.text,
        images: snapshot.images,
        revision: snapshot.revision,
      });
      if (saved.conflictId) {
        publish(model, {
          revision: saved.revision,
          blocked: true,
          conflicts: (saved.conflicts || []).filter((draft: any) => !draft.resolvedAt),
          error: "另一处已更新输入。当前内容已另存，请选择如何继续。",
        });
        return;
      }
      model.savedVersion = version;
      publish(model, {
        revision: saved.revision,
        error: "",
        conflicts: (saved.conflicts || []).filter((draft: any) => !draft.resolvedAt),
      });
    });
    model.queue = task.catch((e) => {
      publish(model, { error: "草稿未保存：" + (e instanceof Error ? e.message : String(e)) });
    });
    return task;
  }
  useEffect(() => {
    if (!model.loaded) {
      model.loaded = true;
      void load();
    }
    return () => {
      void persist().catch(() => {});
    };
  }, [laneId]);
  useEffect(() => {
    if (!state.ready || state.blocked) return;
    const timer = setTimeout(() => void persist().catch(() => {}), 300);
    return () => clearTimeout(timer);
  }, [state.text, state.images, state.ready, state.blocked]);
  function setText(value: React.SetStateAction<string>) {
    const text =
      typeof value === "function" ? value(model.snapshot.text) : value;
    if (text === model.snapshot.text) return;
    model.version++;
    publish(model, { text });
  }
  function setImages(images: ProviderImage[]) {
    model.version++;
    publish(model, { images });
  }
  return {
    ...state,
    setText,
    setImages,
    persist,
    applySaved,
    reload: load,
    current: () => model.snapshot,
    setBusy: (busy: boolean) => publish(model, { busy }),
    captureVoiceBase: () => {
      model.voiceBase = model.snapshot.text;
    },
    voiceBase: () => model.voiceBase,
  };
}
