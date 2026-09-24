import { normalizeImages } from "../../core/providers/input.mjs";
import { randomUUID } from "node:crypto";

// Text, attachments and recovery receipts share one encrypted atomic write.
export class ComposerStore {
  constructor(store, legacyDrafts) {
    this.store = store;
    this.legacy = legacyDrafts;
    store.recoverFile("composer.json");
    this.values = store.exists("composer.json")
      ? store.readJSON("composer.json")
      : {};
  }
  key(laneId) {
    if (
      typeof laneId !== "string" ||
      !laneId ||
      laneId.length > 200 ||
      !/^[-\w]+$/.test(laneId)
    )
      throw Error("输入框标识无效");
    return laneId;
  }
  read(laneId) {
    this.key(laneId);
    const value = this.values[laneId] || {
        text: this.legacy?.read("rpo-prompt-" + laneId) || "",
        images: [],
        recovered: [],
        revision: 0,
      };
    return { ...value, conflicts: value.conflicts || [] };
  }
  commit(laneId, value) {
    const next = { ...this.values, [laneId]: value };
    if (JSON.stringify(next).length > 96 * 1024 * 1024)
      throw Error("输入草稿超过本机存储上限");
    this.store.writeJSON("composer.json", next);
    this.values = next;
    return value;
  }
  save({ laneId, text, images = [], revision }) {
    const old = this.read(laneId);
    if (!Number.isInteger(revision) || revision < 0)
      throw Error("输入框版本无效");
    if (typeof text !== "string" || text.length > 20000)
      throw Error("输入不能超过 20000 字符");
    images = normalizeImages(images);
    const same = value => value.text === text && JSON.stringify(value.images) === JSON.stringify(images);
    if (same(old)) return old;
    if (revision !== old.revision) {
      const existing = old.conflicts.find(value => !value.resolvedAt && same(value));
      if (existing) return { ...old, conflictId: existing.id };
      const conflict = { id: randomUUID(), text, images, at: new Date().toISOString(), baseRevision: revision };
      const current = this.commit(laneId, { ...old, conflicts: [...old.conflicts, conflict] });
      return { ...current, conflictId: conflict.id };
    }
    return this.commit(laneId, {
      ...old,
      text,
      images,
      revision: old.revision + 1,
    });
  }
  listConflicts(laneId) {
    return this.read(laneId).conflicts.filter(value => !value.resolvedAt);
  }
  merge(old, text, images) {
    const merged = text && text !== old.text ? (old.text ? old.text + "\n\n" + text : text) : old.text;
    if (merged.length > 20000)
      throw Error("恢复后输入超过 20000 字符，请先处理当前草稿");
    const combined = [...old.images];
    for (const image of normalizeImages(images))
      if (!combined.some(value => value.data === image.data && value.mimeType === image.mimeType))
        combined.push(image);
    return { text: merged, images: normalizeImages(combined) };
  }
  restoreConflict({ laneId, id }) {
    const old = this.read(laneId);
    const conflict = old.conflicts.find(value => value.id === id);
    if (!conflict) throw Error("冲突草稿不存在");
    if (conflict.resolvedAt) return old;
    const merged = this.merge(old, conflict.text, conflict.images);
    return this.commit(laneId, {
      ...old,
      ...merged,
      revision: old.revision + 1,
      conflicts: old.conflicts.map(value => value.id === id ? { ...value, resolvedAt: new Date().toISOString() } : value),
    });
  }
  restore({ laneId, id, text, images = [] }) {
    const old = this.read(laneId);
    if (old.recovered.includes(id)) return old;
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 200 ||
      typeof text !== "string"
    )
      throw Error("指导记录无效");
    const merged = this.merge(old, text, images);
    return this.commit(laneId, {
      ...old,
      ...merged,
      recovered: [...old.recovered, id],
      revision: old.revision + 1,
    });
  }
}
