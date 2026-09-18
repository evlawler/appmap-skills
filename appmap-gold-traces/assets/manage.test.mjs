// Tests for the gold-traces maintenance engine. Zero-install: run with the
// built-in test runner, no dependencies:
//
//   node --test appmap-gold-traces/assets/manage.test.mjs
//
// Pure logic (digest, YAML reader, snapshot diff) is tested directly. The
// `discover` command is tested end-to-end: the engine runs as a subprocess
// against a throwaway fixture project whose record command is a stub recorder
// script — no AppMap CLI or real recorder needed. `update`'s bless path needs
// the real CLI (sanitize/sequence-diagram), so it is exercised against a real
// project, not here — but its record+missing-path error path is covered below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseYaml, diagramDigest, changedAppmaps, assessAppMap, coverageOf, coverageDelta, normalizeAppMapPath,
} from './manage.mjs';

const MANAGE = fileURLToPath(new URL('./manage.mjs', import.meta.url));

// A fixture project: appmap.yml (appmap_dir: tmp/appmap), a stub recorder script
// standing in for "{test_file}", and a gold_traces/manifest.yaml whose record
// command runs it. The recorder's behavior is switched by {test_name}, mirroring
// how a real recorder decides output paths on its own:
//   one_recording   -> pytest/one_recording.appmap.json (+ a non-appmap noise file)
//   two_recordings  -> pytest/a.appmap.json + requests/b.appmap.json
//   no_recording    -> writes nothing
// With `commands`, the manifest's commands block is replaced. The batch stub
// (`batch-recorder.mjs`) stands in for a pytest launcher: it reads every
// `file::name` selector on its command line and writes one recording per name,
// the way a real runner records each test of a batch separately. It also
// records how many times it was launched (launches.log), so a test can prove
// the engine batched.
function makeFixture(t, { entries = '', commands = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-traces-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'appmap.yml'), 'name: fixture\nappmap_dir: tmp/appmap\n');
  fs.writeFileSync(
    path.join(dir, 'recorder.mjs'),
    `import fs from 'node:fs';
const name = process.argv[2];
const write = (rel) => {
  fs.mkdirSync('tmp/appmap/' + rel.split('/').slice(0, -1).join('/'), { recursive: true });
  fs.writeFileSync('tmp/appmap/' + rel, JSON.stringify({ name, stamp: Date.now(), pad: Math.random() }));
};
if (name === 'two_recordings') { write('pytest/a.appmap.json'); write('requests/b.appmap.json'); }
else if (name === 'no_recording') { /* records nothing */ }
else { write('pytest/' + name + '.appmap.json'); fs.writeFileSync('tmp/appmap/noise.log', 'not an appmap'); }
`,
  );
  fs.writeFileSync(
    path.join(dir, 'batch-recorder.mjs'),
    `import fs from 'node:fs';
fs.appendFileSync('launches.log', process.argv.slice(2).join(' ') + '\\n');
fs.mkdirSync('tmp/appmap/pytest', { recursive: true });
for (const arg of process.argv.slice(2)) {
  const match = /^(.+)::(.+)$/.exec(arg);
  if (!match || match[2] === 'no_recording') continue;
  // A test named dup_<x> executes the same code object as <x>: a near-duplicate.
  const method = match[2].replace(/^dup_/, '');
  fs.writeFileSync('tmp/appmap/pytest/' + match[2] + '.appmap.json',
    JSON.stringify({ events: [{ event: 'call', defined_class: 'App', method_id: method }], stamp: Date.now(), pad: Math.random() }));
}
`,
  );
  // A stand-in for the AppMap CLI so the seed path (which sanitizes) runs without
  // the real binary: `sanitize` is a no-op that exits 0.
  fs.writeFileSync(path.join(dir, 'fake-cli.mjs'), `process.exit(process.argv[2] === 'sanitize' ? 0 : 1);\n`);
  fs.mkdirSync(path.join(dir, 'gold_traces/baseline/appmaps'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'gold_traces/manifest.yaml'),
    `schema_version: 1
commands:
${commands ?? `  record: 'node "{test_file}" {test_name}'`}
entries:
${entries}`,
  );
  return dir;
}

const BATCH_COMMANDS = `  framework: pytest
  runner: node batch-recorder.mjs
  args: --quiet
  appmap_cli: node fake-cli.mjs`;

function batchEntry(name) {
  return `  - feature: demo
    test_file: tests/test_demo.py
    test_name: ${name}
    appmap_path: pytest/${name}.appmap.json
    summary: ${name}
`;
}

// A committed baseline whose only call is App#<method>.
function writeBaseline(dir, name, method = name) {
  const file = path.join(dir, `gold_traces/baseline/appmaps/pytest/${name}.appmap.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    events: [
      { event: 'call', defined_class: 'App', method_id: method },
      ...Array.from({ length: 9 }, () => ({ event: 'return' })),
    ],
  }));
}

function runEngine(cwd, ...args) {
  const result = spawnSync(process.execPath, [MANAGE, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return result;
}

function runDiscover(cwd, testName) {
  return runEngine(cwd, 'discover', '--dir', 'gold_traces', '--test-file', 'recorder.mjs', '--test-name', testName);
}

// --- discover (end-to-end, subprocess against a fixture project) ----------

test('discover: reports the produced recording path and a manifest entry stub', (t) => {
  const dir = makeFixture(t);
  const result = runDiscover(dir, 'one_recording');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pytest\/one_recording\.appmap\.json/);
  assert.match(result.stdout, /appmap_path: pytest\/one_recording\.appmap\.json/);
  assert.match(result.stdout, /test_file: recorder\.mjs/);
  assert.match(result.stdout, /test_name: one_recording/);
  // Non-appmap files the recorder wrote alongside are not candidates.
  assert.doesNotMatch(result.stdout, /noise\.log/);
});

test('discover: an overwritten recording on a re-run is still reported', (t) => {
  const dir = makeFixture(t);
  assert.equal(runDiscover(dir, 'one_recording').status, 0);
  const rerun = runDiscover(dir, 'one_recording');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /appmap_path: pytest\/one_recording\.appmap\.json/);
});

test('discover: multiple recordings are all listed, with a pick-one note', (t) => {
  const dir = makeFixture(t);
  const result = runDiscover(dir, 'two_recordings');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pytest\/a\.appmap\.json/);
  assert.match(result.stdout, /requests\/b\.appmap\.json/);
  assert.match(result.stdout, /Multiple recordings/);
});

test('discover: pre-existing recordings from other tests are not reported', (t) => {
  const dir = makeFixture(t);
  assert.equal(runDiscover(dir, 'earlier_test').status, 0);
  const result = runDiscover(dir, 'one_recording');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /earlier_test/);
});

test('discover: a test that records nothing fails with a clear verdict', (t) => {
  const dir = makeFixture(t);
  const result = runDiscover(dir, 'no_recording');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /wrote no AppMap/);
  assert.match(result.stderr, /not a gold-trace candidate/);
});

test('discover: --test-file and --test-name are required', (t) => {
  const dir = makeFixture(t);
  const result = runEngine(dir, 'discover', '--dir', 'gold_traces', '--test-file', 'recorder.mjs');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --test-file and --test-name/);
});

test('update --record: a wrong appmap_path fails, reporting what the run produced', (t) => {
  const dir = makeFixture(t, {
    entries: `  - feature: demo
    test_file: recorder.mjs
    test_name: one_recording
    appmap_path: pytest/wrong_guess.appmap.json
    summary: wrong path on purpose
`,
  });
  const result = runEngine(dir, 'update', '--dir', 'gold_traces', '--record', '--dry-run');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /one_recording: missing/);
  assert.match(result.stderr, /The record step produced: pytest\/one_recording\.appmap\.json/);
  assert.match(result.stderr, /discover/);
});

test('update --record: refuses to seed an empty recording', (t) => {
  const dir = makeFixture(t, {
    entries: `  - feature: demo
    test_file: recorder.mjs
    test_name: empty
    appmap_path: pytest/empty.appmap.json
    summary: empty on purpose
`,
  });
  const result = runEngine(dir, 'update', '--dir', 'gold_traces', '--record', '--dry-run');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains zero events/);
  assert.match(result.stderr, /contains no function, HTTP, or SQL calls/);
});

// --- framework-driven recording (end-to-end against the batch stub) ----------

test('framework: plan prints one batched command for all entries', (t) => {
  const dir = makeFixture(t, { commands: BATCH_COMMANDS, entries: batchEntry('alpha') + batchEntry('beta') });
  const result = runEngine(dir, 'plan', '--dir', 'gold_traces');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 record run\(s\) for 2 entries via framework pytest/);
  assert.match(result.stdout, /node batch-recorder\.mjs tests\/test_demo\.py::alpha tests\/test_demo\.py::beta --quiet/);
  assert.match(result.stdout, /- alpha\n\s+- beta/);
});

test('framework: update --record launches the runner once for the whole gold set', (t) => {
  const dir = makeFixture(t, { commands: BATCH_COMMANDS, entries: batchEntry('alpha') + batchEntry('beta') });
  const result = runEngine(dir, 'update', '--dir', 'gold_traces', '--record', '--dry-run');
  // Seeding stops before sanitize (needs the real CLI): both entries reach the seed step.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /seed\s+alpha/);
  assert.match(result.stdout, /seed\s+beta/);
  const launches = fs.readFileSync(path.join(dir, 'launches.log'), 'utf8').trim().split('\n');
  assert.equal(launches.length, 1, launches.join('\n'));
  assert.equal(launches[0], 'tests/test_demo.py::alpha tests/test_demo.py::beta --quiet');
});

test('framework: --only records just the named entries', (t) => {
  const dir = makeFixture(t, { commands: BATCH_COMMANDS, entries: batchEntry('alpha') + batchEntry('beta') });
  const result = runEngine(dir, 'update', '--dir', 'gold_traces', '--record', '--dry-run', '--only', 'beta');
  assert.equal(result.status, 0, result.stderr);
  const launches = fs.readFileSync(path.join(dir, 'launches.log'), 'utf8').trim();
  assert.equal(launches, 'tests/test_demo.py::beta --quiet');
});

test('framework: a wrong appmap_path in a batch reports every file the batch produced', (t) => {
  const dir = makeFixture(t, {
    commands: BATCH_COMMANDS,
    entries: batchEntry('alpha') + `  - feature: demo
    test_file: tests/test_demo.py
    test_name: beta
    appmap_path: pytest/wrong.appmap.json
    summary: wrong on purpose
`,
  });
  const result = runEngine(dir, 'update', '--dir', 'gold_traces', '--record', '--dry-run');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /beta: missing/);
  assert.match(result.stderr, /The record step produced: pytest\/alpha\.appmap\.json, pytest\/beta\.appmap\.json/);
});

test('framework: discover records the one test through the framework runner', (t) => {
  const dir = makeFixture(t, { commands: BATCH_COMMANDS });
  const result = runEngine(dir, 'discover', '--dir', 'gold_traces', '--test-file', 'tests/test_demo.py', '--test-name', 'gamma');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /appmap_path: pytest\/gamma\.appmap\.json/);
});

test('framework: an unknown name, or framework together with record, is rejected', (t) => {
  const unknown = makeFixture(t, { commands: '  framework: nose' });
  const result = runEngine(unknown, 'plan', '--dir', 'gold_traces');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown commands.framework 'nose'/);
  assert.match(result.stderr, /Supported: pytest, unittest, rspec/);

  const both = makeFixture(t, { commands: `  framework: pytest\n  record: 'pytest {test_file}::{test_name}'` });
  const conflict = runEngine(both, 'plan', '--dir', 'gold_traces');
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Set one of 'commands.framework' or 'commands.record'/);
});

test('framework: batch_size splits the gold set into several runs', (t) => {
  const dir = makeFixture(t, {
    commands: `${BATCH_COMMANDS}\n  batch_size: 2`,
    entries: batchEntry('alpha') + batchEntry('beta') + batchEntry('gamma'),
  });
  const plan = runEngine(dir, 'plan', '--dir', 'gold_traces');
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /2 record run\(s\) for 3 entries/);
  const result = runEngine(dir, 'update', '--dir', 'gold_traces', '--record', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  const launches = fs.readFileSync(path.join(dir, 'launches.log'), 'utf8').trim().split('\n');
  assert.deepEqual(launches, [
    'tests/test_demo.py::alpha tests/test_demo.py::beta --quiet',
    'tests/test_demo.py::gamma --quiet',
  ]);

  const bad = makeFixture(t, { commands: `${BATCH_COMMANDS}\n  batch_size: 0` });
  const rejected = runEngine(bad, 'plan', '--dir', 'gold_traces');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /batch_size' must be a positive integer/);
});

test('every command prints an upgrade note when the manifest is schema 1 or unversioned', (t) => {
  const dir = makeFixture(t, { commands: BATCH_COMMANDS, entries: batchEntry('alpha') });
  const versioned = runEngine(dir, 'plan', '--dir', 'gold_traces');
  assert.equal(versioned.status, 0, versioned.stderr);
  assert.match(versioned.stderr, /schema_version 1\. Upgrade it to 2/);

  const manifest = path.join(dir, 'gold_traces/manifest.yaml');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace('schema_version: 1\n', ''));
  const unversioned = runEngine(dir, 'plan', '--dir', 'gold_traces');
  assert.equal(unversioned.status, 0, unversioned.stderr);
  assert.match(unversioned.stderr, /no schema_version line/);

  fs.writeFileSync(manifest, `schema_version: 2\n${fs.readFileSync(manifest, 'utf8')}`);
  const current = runEngine(dir, 'plan', '--dir', 'gold_traces');
  assert.equal(current.status, 0, current.stderr);
  assert.doesNotMatch(current.stderr, /schema_version/);
});

test('plan: a record template lists one run per entry', (t) => {
  const dir = makeFixture(t, { entries: batchEntry('alpha') + batchEntry('beta') });
  const result = runEngine(dir, 'plan', '--dir', 'gold_traces');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 record run\(s\) for 2 entries via commands.record template/);
  assert.match(result.stdout, /node "tests\/test_demo\.py" alpha/);
});

// --- coverage: the set must grow, not repeat ----------------------------------

test('assessAppMap: reports SQL tables and HTTP routes for the coverage delta', () => {
  const assessment = assessAppMap({
    events: [
      { event: 'call', sql_query: { sql: 'SELECT * FROM coupons c JOIN carts ON c.cart_id = carts.id' } },
      { event: 'call', sql_query: { sql: 'insert into "orders" (id) values (1)' } },
      { event: 'call', http_server_request: { request_method: 'POST', path_info: '/carts/1/coupons', normalized_path_info: '/carts/:id/coupons' } },
    ],
  }, 100);
  assert.deepEqual(assessment.sql_tables, ['carts', 'coupons', 'orders']);
  assert.deepEqual(assessment.http_routes, ['POST /carts/:id/coupons']);
});

test('coverageDelta: reports what a candidate adds and its closest existing entry', () => {
  const make = (codeObjects, labels = [], tables = [], routes = []) => coverageOf({
    project_code_objects: codeObjects, all_code_objects: codeObjects, labels, sql_tables: tables, http_routes: routes,
  }, ['src']);
  const existing = [
    { name: 'checkout', coverage: make(['Cart#total', 'Order#place'], ['payment.charge'], ['orders']) },
    { name: 'login', coverage: make(['Auth#login'], ['security.authentication'], ['users']) },
  ];
  const coupon = coverageDelta(make(['Cart#total', 'Coupon#apply'], ['payment.charge', 'pricing.discount'], ['orders', 'coupons']), existing);
  assert.equal(coupon.isNew, true);
  assert.deepEqual(coupon.added, { code_objects: ['Coupon#apply'], labels: ['pricing.discount'], tables: ['coupons'], routes: [] });
  assert.deepEqual(coupon.mostSimilar, { name: 'checkout', overlap: 0.5 });

  const repeat = coverageDelta(make(['Cart#total'], ['payment.charge'], ['orders']), existing);
  assert.equal(repeat.isNew, false);
  assert.deepEqual(repeat.mostSimilar, { name: 'checkout', overlap: 1 });
});

test('check: warns when a trace covers nothing the earlier traces do not', (t) => {
  const dir = makeFixture(t, {
    commands: BATCH_COMMANDS,
    entries: batchEntry('alpha') + batchEntry('beta'),
  });
  writeBaseline(dir, 'alpha');
  writeBaseline(dir, 'beta', 'alpha');   // beta's recording only calls App#alpha
  const result = runEngine(dir, 'check', '--dir', 'gold_traces');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARN beta: runs no code object, label, SQL table, or HTTP route that the earlier entries do not \(closest: alpha, 100% overlap\)/);
  assert.match(result.stdout, /Keep it only if it drives a branch inside those functions that alpha does not/);
  assert.doesNotMatch(result.stdout, /WARN alpha: runs no code object/);
});

test('check: a manifest that still carries expect fields gets a note to delete them', (t) => {
  const dir = makeFixture(t, {
    commands: BATCH_COMMANDS,
    entries: `${batchEntry('alpha')}    expect:\n      - "App#alpha"\n    expect_labels:\n      - security.authentication\n`,
  });
  writeBaseline(dir, 'alpha');
  const result = runEngine(dir, 'check', '--dir', 'gold_traces');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /'expect' and 'expect_labels' are no longer used; delete them from alpha/);
});

test('covers: lists the baselines that run a matching code object, spelled as recorded', (t) => {
  const dir = makeFixture(t, {
    commands: BATCH_COMMANDS,
    entries: batchEntry('alpha') + batchEntry('beta'),
  });
  writeBaseline(dir, 'alpha');
  writeBaseline(dir, 'beta');
  const hit = runEngine(dir, 'covers', '--dir', 'gold_traces', '--name', 'alph');
  assert.equal(hit.status, 0, hit.stderr);
  assert.match(hit.stdout, /alpha  \(tests\/test_demo.py\)\n\s+App#alpha/);
  assert.doesNotMatch(hit.stdout, /beta  \(/);
  assert.match(hit.stdout, /1 of 2 baseline\(s\) run a code object matching 'alph'/);

  const miss = runEngine(dir, 'covers', '--dir', 'gold_traces', '--name', 'Gamma#run');
  assert.equal(miss.status, 0, miss.stderr);
  assert.match(miss.stdout, /No baseline runs a code object matching 'Gamma#run' \(2 searched\)/);
  assert.match(miss.stdout, /try a shorter name/);

  const noName = runEngine(dir, 'covers', '--dir', 'gold_traces');
  assert.equal(noName.status, 1);
  assert.match(noName.stderr, /covers requires --name/);
});

test('covers: an entry without a committed baseline is skipped, and an empty set says so', (t) => {
  const dir = makeFixture(t, { commands: BATCH_COMMANDS, entries: batchEntry('alpha') });
  const result = runEngine(dir, 'covers', '--dir', 'gold_traces', '--name', 'alpha');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No baselines to search/);
});

test('covers --fresh: searches the recordings under appmap_dir and names each by its metadata', (t) => {
  const dir = makeFixture(t, { commands: BATCH_COMMANDS });
  const empty = runEngine(dir, 'covers', '--dir', 'gold_traces', '--name', 'Flow', '--fresh');
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No recordings to search/);

  const write = (rel, appmap) => {
    const file = path.join(dir, 'tmp/appmap', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(appmap));
  };
  write('requests/flows.appmap.json', {
    metadata: { name: 'creates a flow', source_location: 'spec/requests/flows_spec.rb:12' },
    events: [{ event: 'call', defined_class: 'FlowService', method_id: 'create' }, { event: 'call', defined_class: 'FlowDao', method_id: 'insert' }],
  });
  write('unit/dao.appmap.json', {
    metadata: { name: 'inserts' },
    events: [{ event: 'call', defined_class: 'FlowDao', method_id: 'insert' }],
  });
  write('unit/other.appmap.json', { events: [{ event: 'call', defined_class: 'Cart', method_id: 'total' }] });

  const result = runEngine(dir, 'covers', '--dir', 'gold_traces', '--name', 'FlowDao', '--fresh');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /requests\/flows.appmap.json  \(creates a flow  spec\/requests\/flows_spec.rb:12\)\n\s+FlowDao#insert/);
  assert.match(result.stdout, /unit\/dao.appmap.json  \(inserts\)\n\s+FlowDao#insert/);
  assert.doesNotMatch(result.stdout, /other.appmap.json/);
  assert.match(result.stdout, /2 of 3 recording\(s\) run a code object matching 'FlowDao'/);
});

test('discover: reports the coverage a candidate adds beyond the committed set, facts only', (t) => {
  const dir = makeFixture(t, { commands: BATCH_COMMANDS, entries: batchEntry('alpha') });
  writeBaseline(dir, 'alpha');
  const fresh = runEngine(dir, 'discover', '--dir', 'gold_traces', '--test-file', 'tests/test_demo.py', '--test-name', 'gamma');
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /adds coverage no existing entry has: code objects App#gamma \(closest: alpha, 0%/);
  assert.doesNotMatch(fresh.stdout, /verdict/);

  const dup = runEngine(dir, 'discover', '--dir', 'gold_traces', '--test-file', 'tests/test_demo.py', '--test-name', 'dup_alpha');
  assert.equal(dup.status, 0, dup.stderr);
  assert.match(dup.stdout, /adds no coverage beyond the existing entries \(closest: alpha, 100%/);
  assert.doesNotMatch(dup.stdout, /verdict|expect/);
});

test('discover: the first entry has nothing to compare against', (t) => {
  const dir = makeFixture(t, { commands: BATCH_COMMANDS });
  const result = runEngine(dir, 'discover', '--dir', 'gold_traces', '--test-file', 'tests/test_demo.py', '--test-name', 'gamma');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /coverage: first entry/);
});

// --- suitability assessment ------------------------------------------------

test('assessAppMap: reports useful shape metrics', () => {
  const assessment = assessAppMap({
    classMap: [{ type: 'class', children: [
      { type: 'function', labels: ['security.authentication'] },
    ] }],
    events: [
      { event: 'call', defined_class: 'Auth', method_id: 'login', static: false, path: 'src/auth.js' },
      { event: 'call', http_server_request: { request_method: 'POST' } },
      { event: 'call', sql_query: { sql: 'select 1' } },
      ...Array.from({ length: 17 }, () => ({ event: 'return' })),
    ],
  }, 4096, ['src']);

  assert.equal(assessment.events, 20);
  assert.equal(assessment.calls, 3);
  assert.equal(assessment.http_requests, 1);
  assert.equal(assessment.sql_queries, 1);
  assert.deepEqual(assessment.labels, ['security.authentication']);
  assert.deepEqual(assessment.project_code_objects, ['Auth#login']);
  assert.deepEqual(assessment.project_classes, ['Auth']);
  assert.deepEqual(assessment.errors, []);
  // One class, but it reaches SQL and HTTP: not unit-test shaped.
  assert.doesNotMatch(assessment.warnings.join(' '), /unit test/);
});

test('assessAppMap: rejects empty traces', () => {
  const empty = assessAppMap({ events: [] }, 100);
  assert.match(empty.errors.join(' '), /zero events/);
  assert.match(empty.errors.join(' '), /no function/);
});

test('assessAppMap: warns when a recording stays inside one class and never reaches SQL or HTTP', () => {
  const call = (cls, method, file) => ({ event: 'call', defined_class: cls, method_id: method, static: false, path: file });
  const returns = Array.from({ length: 12 }, () => ({ event: 'return' }));

  const unit = assessAppMap({ events: [call('Cart', 'total', 'src/cart.js'), call('Cart', 'add', 'src/cart.js'), ...returns] }, 100, ['src']);
  assert.match(unit.warnings.join(' '), /runs only one project class \(Cart\) and makes no SQL or HTTP calls: reads like a unit test/);

  const libraryOnly = assessAppMap({ events: [call('Logger', 'write', 'node_modules/logger/index.js'), ...returns] }, 100, ['src']);
  assert.match(libraryOnly.warnings.join(' '), /runs no project class and makes no SQL or HTTP calls/);

  const layered = assessAppMap({ events: [call('Cart', 'total', 'src/cart.js'), call('Pricing', 'apply', 'src/pricing.js'), ...returns] }, 100, ['src']);
  assert.doesNotMatch(layered.warnings.join(' '), /unit test/);

  const withSql = assessAppMap({ events: [call('Cart', 'total', 'src/cart.js'), { event: 'call', sql_query: { sql: 'select 1' } }, ...returns] }, 100, ['src']);
  assert.doesNotMatch(withSql.warnings.join(' '), /unit test/);

  // No packages configured: every class counts as project code.
  const unconfigured = assessAppMap({ events: [call('Cart', 'total', 'src/cart.js'), call('Pricing', 'apply', 'src/pricing.js'), ...returns] }, 100, []);
  assert.doesNotMatch(unconfigured.warnings.join(' '), /unit test/);
});

test('assessAppMap: warns on large, repetitive traces', () => {
  const assessment = assessAppMap({
    events: Array.from({ length: 400 }, () => (
      { event: 'call', defined_class: 'Kernel', method_id: 'eval', static: false }
    )),
  }, 600 * 1024);
  assert.match(assessment.warnings.join(' '), /is large/);
  assert.match(assessment.warnings.join(' '), /400x Kernel#eval/);
});

test('assessAppMap: a dotted package name matches the source path of a Java or Python file', () => {
  const assessment = assessAppMap({
    events: [
      { event: 'call', defined_class: 'org.finos.waltz.data.FlowDao', method_id: 'insert', path: 'waltz-data/src/main/java/org/finos/waltz/data/FlowDao.java' },
      { event: 'call', defined_class: 'org.finos.waltz.service.FlowService', method_id: 'add', path: 'waltz-service/src/main/java/org/finos/waltz/service/FlowService.java' },
      { event: 'call', defined_class: 'org.jooq.DSL', method_id: 'select', path: 'org/jooq/DSL.java' },
      { event: 'call', defined_class: 'myapp.core.Cart', method_id: 'total', path: 'myapp/core/cart.py' },
      { event: 'call', defined_class: 'requests.Session', method_id: 'get', path: '/opt/venv/lib/requests/sessions.py' },
    ],
  }, 100, ['org.finos.waltz', 'myapp.core']);
  assert.deepEqual(assessment.project_code_objects, [
    'myapp.core.Cart#total', 'org.finos.waltz.data.FlowDao#insert', 'org.finos.waltz.service.FlowService#add',
  ]);
  assert.deepEqual(assessment.project_classes, ['myapp.core.Cart', 'org.finos.waltz.data.FlowDao', 'org.finos.waltz.service.FlowService']);
});

test('coverageOf: falls back to every code object when the package filter matched nothing', () => {
  const unmatched = coverageOf({ project_code_objects: [], all_code_objects: ['A#run', 'B#run'], labels: [], sql_tables: [], http_routes: [] }, ['com.example']);
  assert.deepEqual([...unmatched.code_objects], ['A#run', 'B#run']);
  const matched = coverageOf({ project_code_objects: ['A#run'], all_code_objects: ['A#run', 'B#run'], labels: [], sql_tables: [], http_routes: [] }, ['com.example']);
  assert.deepEqual([...matched.code_objects], ['A#run']);
});

test('assessAppMap: path dot does not classify absolute dependencies as project code', () => {
  const assessment = assessAppMap({
    events: [
      { event: 'call', defined_class: 'App', method_id: 'run', path: 'src/app.js' },
      { event: 'call', defined_class: 'Gem', method_id: 'run', path: '/opt/gems/gem.rb' },
    ],
  }, 100, ['.', '/repo']);
  assert.deepEqual(assessment.project_code_objects, ['App#run']);
});

// --- diagram digest (the bless gate) -------------------------------------

test('diagramDigest: identical root subtree digests hash equal', () => {
  const a = { rootActions: [{ subtreeDigest: 'x' }, { subtreeDigest: 'y' }] };
  const b = { rootActions: [{ subtreeDigest: 'x' }, { subtreeDigest: 'y' }] };
  assert.equal(diagramDigest(a), diagramDigest(b));
});

test('diagramDigest: a differing subtree digest hashes differently', () => {
  const a = { rootActions: [{ subtreeDigest: 'x' }] };
  const b = { rootActions: [{ subtreeDigest: 'z' }] };
  assert.notEqual(diagramDigest(a), diagramDigest(b));
});

// --- snapshot diff (what discover reports) --------------------------------

test('changedAppmaps: reports files new since the before-snapshot', () => {
  const before = new Map([['pytest/old.appmap.json', '1:10']]);
  const after = new Map([['pytest/old.appmap.json', '1:10'], ['pytest/new.appmap.json', '2:20']]);
  assert.deepEqual(changedAppmaps(before, after), ['pytest/new.appmap.json']);
});

test('changedAppmaps: an overwritten recording (changed signature) counts as produced', () => {
  const before = new Map([['pytest/t.appmap.json', '1:10']]);
  const after = new Map([['pytest/t.appmap.json', '5:12']]);
  assert.deepEqual(changedAppmaps(before, after), ['pytest/t.appmap.json']);
});

test('changedAppmaps: untouched files are not reported', () => {
  const same = new Map([['pytest/t.appmap.json', '1:10']]);
  assert.deepEqual(changedAppmaps(same, new Map(same)), []);
});

test('normalizeAppMapPath: converts Windows separators to manifest-style slashes', () => {
  const relative = path.win32.relative('tmp\\appmap', 'tmp\\appmap\\pytest\\test.appmap.json');
  assert.equal(normalizeAppMapPath(relative), 'pytest/test.appmap.json');
});

// --- YAML reader (config supports the `expand` list) ---------------------

test('parseYaml: reads a top-level block list (the expand option)', () => {
  const cfg = parseYaml('appmap_dir: tmp/appmap\nexpand:\n  - "package:a/b"\n  - "package:c/d"\n');
  assert.deepEqual(cfg.expand, ['package:a/b', 'package:c/d']);
});

test('parseYaml: reads a block list nested inside an entry', () => {
  const cfg = parseYaml(`entries:
  - test_name: login
    tags:
      - "auth#core"
      - session.create
`);
  assert.deepEqual(cfg.entries[0].tags, ['auth#core', 'session.create']);
});

test('parseYaml: standard YAML — same-line comments, flow collections, anchors', () => {
  const cfg = parseYaml(`schema_version: 2  # current
commands: {framework: pytest, args: -q}
entries: []
expand: &e ["package:a/b"]
allow_values: *e
`);
  assert.equal(cfg.schema_version, 2);
  assert.deepEqual(cfg.commands, { framework: 'pytest', args: '-q' });
  assert.deepEqual(cfg.entries, []);
  assert.deepEqual(cfg.allow_values, ['package:a/b']);
});

test('parseYaml: a syntax error names the file', () => {
  assert.throws(() => parseYaml('entries:\n  - a: [\n', 'gold_traces/manifest.yaml'), /Invalid YAML in gold_traces\/manifest.yaml/);
});

test('manifest: an appmap.yml with same-line comments and gem entries is read as YAML', (t) => {
  const dir = makeFixture(t, { commands: BATCH_COMMANDS, entries: batchEntry('alpha') });
  fs.writeFileSync(path.join(dir, 'appmap.yml'), `name: fixture  # the app
appmap_dir: tmp/appmap
packages:
  - path: src   # project code
    exclude:
      - "Foo#bar"  # noisy
  - gem: rails
`);
  writeBaseline(dir, 'alpha');
  const result = runEngine(dir, 'check', '--dir', 'gold_traces');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Checked 1 baseline trace/);
});

test('parseYaml: preserves a quoted list scalar containing colon-space', () => {
  const cfg = parseYaml(`allow_values:
  - "status: active"
`);
  assert.deepEqual(cfg.allow_values, ['status: active']);
});

test('manifest: rejects unsupported schema versions', (t) => {
  const dir = makeFixture(t);
  fs.writeFileSync(path.join(dir, 'gold_traces/manifest.yaml'), 'schema_version: two\nentries:\n');
  const invalid = runEngine(dir, 'check', '--dir', 'gold_traces');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unsupported gold-traces schema_version/);

  fs.writeFileSync(path.join(dir, 'gold_traces/manifest.yaml'), 'schema_version: 3\nentries:\n');
  const future = runEngine(dir, 'check', '--dir', 'gold_traces');
  assert.equal(future.status, 1);
  assert.match(future.stderr, /Unsupported gold-traces schema_version/);
});

test('manifest: a schema version 1 manifest still checks', (t) => {
  const dir = makeFixture(t, {
    entries: `  - feature: legacy
    test_file: recorder.mjs
    test_name: legacy
    appmap_path: pytest/legacy.appmap.json
    summary: existing schema version 1 entry
`,
  });
  const baseline = path.join(dir, 'gold_traces/baseline/appmaps/pytest/legacy.appmap.json');
  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  fs.writeFileSync(baseline, JSON.stringify({
    events: [
      { event: 'call', defined_class: 'Legacy', method_id: 'run' },
      ...Array.from({ length: 9 }, () => ({ event: 'return' })),
    ],
  }));
  const result = runEngine(dir, 'check', '--dir', 'gold_traces');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Checked 1 baseline trace/);
});
