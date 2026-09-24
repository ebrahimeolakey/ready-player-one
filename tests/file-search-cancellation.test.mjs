import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { searchFiles } from '../core/local.mjs';
import { FileSearchService } from '../desktop/services/file-search.mjs';
let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'rpo-search-20k-'));
  for (let i = 0; i < 20001; i++) writeFileSync(join(root, `file-${String(i).padStart(5, '0')}.txt`), '');
});
after(() => rmSync(root, { recursive: true, force: true }));
const args = (overrides = {}) => ({ workspaceId: 'workspace', sessionId: 'session', laneId: 'mine', viewId: randomUUID(), queryId: randomUUID(), query: 'no-match', ...overrides });
const authorize = a => {
  if (a.workspaceId !== 'workspace' || a.sessionId !== 'session' || a.laneId !== 'mine') throw Error('not authorized');
  return root;
};

test('20,001 real files stop at the 20,000 visit bound and 100 result cap without starving timers', async () => {
  let visited = 0, ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    assert.deepEqual(await searchFiles(root, 'no-match', { onVisit: count => { visited = count; } }), []);
    assert.equal(visited, 20000);
    assert.ok(ticks > 0, 'timers must run during traversal');
    let matchedVisits = 0;
    assert.equal((await searchFiles(root, 'file-', { onVisit: count => { matchedVisits = count; } })).length, 100);
    assert.equal(matchedVisits, 100);
  } finally { clearInterval(timer); }
});
test('AbortSignal stops real directory reads, rejects, and leaves the visit count stopped', async () => {
  const controller = new AbortController();
  let visited = 0;
  const pending = searchFiles(root, 'no-match', { signal: controller.signal, onVisit: count => {
    visited = count;
    if (count === 64) setTimeout(() => controller.abort(), 0);
  }});
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(visited >= 64 && visited < 20000);
  const stopped = visited;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(visited, stopped, 'cancel must end traversal, not merely hide its result');
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(searchFiles(root, 'no-match', { signal: preAborted.signal, onVisit: () => assert.fail('visited after pre-abort') }), { name: 'AbortError' });
});
test('superseding a query stops its real traversal; stale cancellation cannot abort the new query', async () => {
  let service, replacement, oldVisits = 0;
  const first = args(), second = { ...first, queryId: randomUUID(), query: 'file-00007.txt' };
  service = new FileSearchService({ resolveRoot: authorize, search: (dir, query, options) => searchFiles(dir, query, {
    ...options, onVisit: count => {
      if (query !== first.query) return;
      oldVisits = count;
      if (count === 64) {
        replacement = service.start(7, second);
        assert.equal(service.cancel(7, first), false);
      }
    },
  }) });
  assert.equal((await service.start(7, first)).cancelled, true);
  const next = await replacement;
  assert.equal(next.cancelled, false);
  assert.equal(next.results[0].path, second.query);
  assert.equal(oldVisits, 64);
  assert.equal(service.active.size, 0);
});
test('owner, pane and context isolation prevent another request from cancelling a real search', async () => {
  const one = args({ query: 'first-no-match' }), two = args({ query: 'file-00008.txt' });
  let firstCount = 0;
  const service = new FileSearchService({ resolveRoot: authorize, search: (dir, query, options) => searchFiles(dir, query, {
    ...options, onVisit: count => {
      if (query !== one.query) return;
      firstCount = count;
      if (count === 64) {
        assert.equal(service.cancel(8, one), false);
        assert.equal(service.cancel(7, { ...one, sessionId: 'foreign' }), false);
        assert.equal(service.cancel(7, { ...one, viewId: two.viewId }), false);
        assert.equal(service.cancel(7, one), true);
      }
    },
  }) });
  const [first, second] = await Promise.all([service.start(7, one), service.start(7, two)]);
  assert.equal(first.cancelled, true); assert.equal(firstCount, 64);
  assert.equal(second.cancelled, false); assert.equal(second.results[0].path, two.query);
});
test('invalid or unauthorized requests and duplicate IDs cannot disturb another active query', async () => {
  let release;
  const service = new FileSearchService({ resolveRoot: authorize, search: () => new Promise(resolve => { release = resolve; }) });
  const first = args(), pending = service.start(7, first);
  await Promise.resolve();
  assert.throws(() => service.start(7, { ...first, queryId: randomUUID(), laneId: 'someone-else' }), /not authorized/);
  assert.throws(() => service.start(7, { ...first, viewId: '../bad' }), /标识无效/);
  assert.throws(() => service.start(7, { ...first, query: 'different' }), /其他请求/);
  assert.equal(service.start(7, first), pending);
  assert.equal(service.active.values().next().value.controller.signal.aborted, false);
  release([]); assert.equal((await pending).cancelled, false);
});
test('a filesystem failure is reported only to its query; closing an owner cancels its pending reads', async () => {
  const first = args({ query: 'broken' }), second = args({ query: 'file-00009.txt' });
  const service = new FileSearchService({ resolveRoot: authorize, search: (dir, query, options) => {
    if (query === 'broken') return searchFiles(join(dir, 'does-not-exist'), query, options);
    return searchFiles(dir, query, options);
  }});
  const failed = assert.rejects(service.start(7, first), /ENOENT/);
  const other = service.start(8, second);
  await failed;
  assert.equal((await other).results[0].path, second.query);
  const pending = service.start(7, args()); service.closeOwner(7);
  assert.equal((await pending).cancelled, true);
  assert.equal(service.active.size, 0);
});
