// Tests keep a directory-scoped key in this worker, never generate production disk keys.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Hub as EncryptedHub } from "../../core/hub.mjs";
import { SecureStore } from "../../core/secure-store.mjs";
const keys = new Map();
export class Hub extends EncryptedHub {
  constructor(dir, options = {}) {
    const name = resolve(dir);
    if (!keys.has(name)) keys.set(name, randomBytes(32));
    super(dir, { ...options, store: options.store || new SecureStore({ dir, key: keys.get(name) }) });
  }
}
