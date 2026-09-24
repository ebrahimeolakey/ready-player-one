import { searchFiles } from '../../core/local.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(owner, args) {
  if (!Number.isSafeInteger(owner) || owner < 1 || typeof args.viewId !== 'string' || !uuid.test(args.viewId) || typeof args.queryId !== 'string' || !uuid.test(args.queryId))
    throw Error('文件搜索标识无效');
  for (const field of ['workspaceId', 'sessionId'])
    if (typeof args[field] !== 'string' || !args[field] || args[field].length > 512)
      throw Error('文件搜索上下文无效');
  if (args.laneId !== undefined && (typeof args.laneId !== 'string' || args.laneId.length > 512))
    throw Error('文件搜索上下文无效');
  return { key: `${owner}:${args.viewId}`, context: JSON.stringify([args.workspaceId, args.sessionId, args.laneId || '']) };
}
export class FileSearchService {
  constructor({ resolveRoot, search = searchFiles }) {
    this.resolveRoot = resolveRoot;
    this.search = search;
    this.active = new Map();
  }
  start(owner, args) {
    const { key, context } = identity(owner, args);
    if (typeof args.query !== 'string' || args.query.length > 200) throw Error('文件搜索内容无效');
    // Authorize before touching any existing request. Root resolution must be synchronous.
    const root = this.resolveRoot(args);
    if (typeof root !== 'string' || !root) throw Error('文件搜索目录无效');
    const previous = this.active.get(key);
    if (previous?.queryId === args.queryId) {
      if (previous.context !== context || previous.root !== root || previous.query !== args.query)
        throw Error('文件搜索标识已用于其他请求');
      return previous.promise;
    }
    if (!previous && this.active.size >= 32) throw Error('同时搜索过多，请稍后重试');
    previous?.controller.abort();
    const record = { owner, queryId: args.queryId, query: args.query, context, root, controller: new AbortController() };
    this.active.set(key, record);
    record.promise = Promise.resolve().then(async () => {
      try {
        record.controller.signal.throwIfAborted();
        const results = await this.search(root, args.query, { signal: record.controller.signal });
        record.controller.signal.throwIfAborted();
        return { queryId: args.queryId, results, cancelled: false };
      } catch (error) {
        if (record.controller.signal.aborted) return { queryId: args.queryId, results: [], cancelled: true };
        throw error;
      } finally {
        if (this.active.get(key) === record) this.active.delete(key);
      }
    });
    return record.promise;
  }
  cancel(owner, args) {
    const { key, context } = identity(owner, args), record = this.active.get(key);
    if (!record || record.queryId !== args.queryId || record.context !== context) return false;
    record.controller.abort();
    return true;
  }
  closeOwner(owner) {
    for (const record of this.active.values()) if (record.owner === owner) record.controller.abort();
  }
  closeAll() {
    for (const record of this.active.values()) record.controller.abort();
  }
}
