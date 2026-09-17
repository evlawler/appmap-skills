// Unit tests for the pure parts of views.mjs. Run with: node --test appmap-review/assets/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderShape, diagramStats, treeDiffStats, decideView } from './views.mjs';

test('renderShape: one line per event, timings and return values left out, SQL whole', () => {
  const text = renderShape([
    { kind: 'http_server', depth: 0, method: 'POST', route: '/orders', status_code: 500, elapsed_ms: 520 },
    { kind: 'function', depth: 1, fqid: 'app/OrdersController#create', elapsed_ms: 519, return_value: '<v9>' },
    { kind: 'sql', depth: 2, sql_text: 'INSERT INTO orders\n  (id, name)\n  VALUES (42, \'x\')', elapsed_ms: 14 },
    { kind: 'exception', depth: 2, exception_class: 'IntegrityError', message: 'duplicate key', path: 'app/order.rb', lineno: 42 },
    { kind: 'http_client', depth: 1, method: 'GET', url: 'https://api.example/v1', status_code: 200 },
    { kind: 'log', depth: 1, logger: 'Rails', method_id: 'info', message: 'done' },
  ]);
  assert.equal(text, [
    'HTTP→  POST /orders → HTTP 500',
    '  CALL   app/OrdersController#create',
    "    SQL    INSERT INTO orders (id, name) VALUES (42, 'x')",
    '    EXC    IntegrityError: duplicate key @ app/order.rb:42',
    '  HTTP←  GET https://api.example/v1 → 200',
    '  LOG    Rails.info: done',
    '',
  ].join('\n'));
});

const node = (id, diffMode, extra = {}) => ({ stableProperties: { id }, children: [], ...(diffMode ? { diffMode } : {}), ...extra });
const same = (n) => Array.from({ length: n }, (_, i) => node('same' + i));

test('diagramStats: counts by mode, names the root of a moved block, collects labels', () => {
  const stats = diagramStats({ rootActions: [
    ...same(5),
    node('app/Orders#create', 2, { children: [node('app/Orders#validate', 2)] }),
    node('app/Orders#create', 1, { children: [node('app/Orders#validate', 1)], labels: ['security.authorization'] }),
    node('app/Other#run', 3),
  ] });
  assert.equal(stats.total, 10);
  assert.deepEqual([stats.diff, stats.added, stats.removed, stats.changed], [5, 2, 2, 1]);
  assert.deepEqual(stats.moved, ['app/Orders#create']);
  assert.deepEqual([...stats.labels], ['security.authorization']);
});

test('treeDiffStats: counts changed lines and repeats of the same line', () => {
  const diff = ['--- a', '+++ b', '@@', ' same', '-CALL x', '+CALL y', '+  SQL SELECT 1', '+  SQL SELECT 1', '+  SQL SELECT 1'].join('\n');
  assert.deepEqual(treeDiffStats(diff), { lines: 5, repeated: 3 });
});

test('decideView: the rules in order', () => {
  const diagram = (diff, total, extra = {}) => ({ diff, total, moved: [], labels: new Set(), ...extra });
  assert.equal(decideView(diagram(4, 100), { lines: 0, repeated: 0 }).reason, 'the call trees read the same, so the change is in something the tree does not print');
  assert.match(decideView(diagram(40, 100), { lines: 5, repeated: 5 }).reason, /^the tree diff is mostly repeated lines \(5 of 5\): a loop ran a different number of times/);
  assert.deepEqual(decideView(diagram(2, 7), { lines: 2, repeated: 0 }), { read: 'diagram', reason: '2 nodes changed; small enough to read as is' });
  const moved = decideView(diagram(4, 10, { moved: ['app/Orders#create'] }), { lines: 6, repeated: 0 });
  assert.equal(moved.read, 'tree');
  assert.match(moved.reason, /^Orders#create removed and added again: a moved block/);
  const labeled = decideView(diagram(4, 10, { moved: ['app/Auth#check'], labels: new Set(['security.authorization']) }), { lines: 6, repeated: 0 });
  assert.equal(labeled.read, 'both');
  assert.match(labeled.reason, /carry labels \(security\.authorization\)/);
  assert.deepEqual(decideView(diagram(40, 100), { lines: 40, repeated: 0 }), { read: 'tree', reason: '40 of 100 nodes changed; plain text scans better at this size' });
  assert.deepEqual(decideView(diagram(5, 100), { lines: 5, repeated: 0 }), { read: 'diagram', reason: '5 of 100 nodes changed; the tree diff is there if the diagram is unclear' });
  // No tree diff at all (older CLI): the diagram rules still apply.
  assert.equal(decideView(diagram(2, 7), null).read, 'diagram');
  assert.equal(decideView(null, { lines: 3, repeated: 0 }).read, 'tree');
});
