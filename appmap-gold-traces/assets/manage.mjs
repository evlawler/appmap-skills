#!/usr/bin/env node

// Gold-traces maintenance for the appmap-gold-traces skill.
//
// Config-driven and zero-install (the YAML reader is vendored): one file,
// <dir>/manifest.yaml, describes the whole
// gold set — the record commands and the curated recording list. Run from the target
// project root:
//
//   node <skill>/assets/manage.mjs update --dir gold_traces --record
//   node <skill>/assets/manage.mjs update --dir gold_traces --only test_foo --dry-run
//   node <skill>/assets/manage.mjs discover --dir gold_traces --test-file tests/test_foo.py --test-name test_bar
//   node <skill>/assets/manage.mjs check --dir gold_traces --record
//   node <skill>/assets/manage.mjs covers --dir gold_traces --name LogicalFlowDao
//
// It records the gold tests, checks trace suitability, blesses baselines,
// discovers a test's appmap_path, and answers which committed baseline runs a
// piece of code. Diffing and interpreting a change
// (regression? unintended side effect?) is the appmap-review skill's job, not this
// engine's.
//
// The recorder alone decides where a recording file lands under appmap_dir — the
// record command cannot direct it. So `discover` derives an entry's appmap_path
// empirically: snapshot appmap_dir, run the one test, and report which appmap files
// the run produced.
//
// The bless is DIGEST-GATED. Raw appmaps differ on every recording (timestamps,
// event/object ids), so a blind copy would churn every baseline in git. First we
// `sanitize` the fresh recording (tokenizing captured values): the committed baseline
// is itself sanitized, and sanitize can rewrite digest-relevant text (e.g. SQL
// literals), so both sides of the compare must be sanitized for the gate to be honest.
// Then for each entry we export both the (sanitized) fresh recording and the committed
// baseline to AppMap's JSON sequence diagram and compare a single digest over the root
// subtree digests — which excludes volatile data (elapsed time, ids). A baseline is
// re-blessed only when that digest changed, so untouched baselines stay byte-identical.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync, accessSync, writeFileSync, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { describeFrameworks, frameworkNames, planRecordCommands, resolveRunner } from './frameworks.mjs';
import { load as loadYaml } from './vendor/js-yaml.mjs';

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || options.help) {
    printHelp();
    return;
  }

  const projectRoot = process.cwd();
  const goldDir = path.resolve(projectRoot, options.dir);
  const paths = {
    projectRoot,
    goldDir,
    manifestPath: path.join(goldDir, 'manifest.yaml'),
    baselineRoot: path.join(goldDir, 'baseline'),
  };

  const config = await loadManifest(paths.manifestPath);
  // Neither the working dir nor the recordings dir is configured — both are derived
  // from the layout. The record/appmap commands run from the gold_traces parent dir;
  // the recordings live where the nearest-ancestor appmap.yml says (its dir + its
  // appmap_dir field — which is also the AppMap project root for the CLI).
  const workingDir = path.dirname(goldDir);
  const { appmapYmlDir, appmapDir, packagePaths } = await locateAppmap(goldDir);
  const appmapsDir = path.join(appmapYmlDir, appmapDir);
  // Derived sequence exports go under that project's `.appmap/` (regenerable,
  // gitignored — the same place the CLI writes archives/work), namespaced here.
  const tempRoot = path.join(appmapYmlDir, '.appmap', 'gold-traces');
  const env = { ...paths, config, workingDir, appmapYmlDir, appmapsDir, packagePaths, tempRoot };

  // An old manifest still works; say so once per run and point at the upgrade
  // recipe (a short hand edit, described in the appmap-gold-traces skill).
  if (config.schema_version < 2) {
    console.error(
      `note: ${paths.manifestPath} is schema_version ${config.schema_version}` +
        `${config.versioned ? '' : ' (no schema_version line)'}. Upgrade it to 2: ` +
        `set schema_version and replace commands.record with commands.framework ` +
        `(see the appmap-gold-traces skill, "Maintain").`,
    );
  }
  // `expect` and `expect_labels` were dropped: the recordings say what a trace
  // runs, and the compare says what changed. Say so once so the fields get deleted.
  const legacy = config.entries.filter((entry) => entry.expect != null || entry.expect_labels != null);
  if (legacy.length > 0) {
    const named = legacy.slice(0, 3).map((entry) => entry.test_name).join(', ');
    const more = legacy.length > 3 ? ` and ${legacy.length - 3} more` : '';
    console.error(
      `note: 'expect' and 'expect_labels' are no longer used; delete them from ` +
        `${named}${more} in ${paths.manifestPath}.`,
    );
  }

  if (command === 'discover') {
    await discoverAppmapPath(env, options);
    return;
  }
  if (command === 'covers') {
    await coversCommand(env, options);
    return;
  }

  let entries = config.entries;
  if (options.only.length > 0) {
    const wanted = new Set(options.only);
    entries = entries.filter((entry) => wanted.has(entry.test_name));
    const found = new Set(entries.map((entry) => entry.test_name));
    const missing = options.only.filter((name) => !found.has(name));
    if (missing.length > 0) {
      throw new Error(`--only names not found in manifest: ${missing.join(', ')}`);
    }
  }

  if (command === 'update') {
    await updateBaseline(env, entries, options);
    return;
  }
  if (command === 'check') {
    await checkBaselines(env, entries, options);
    return;
  }
  if (command === 'plan') {
    printRecordPlan(env, entries);
    return;
  }
  throw new Error(
    `Unknown command: ${command}. This engine maintains baselines ('update'), checks ` +
      `trace suitability ('check'), finds a test's appmap_path ('discover'), ` +
      `answers which baseline runs a piece of code ('covers'), ` +
      `and shows the record commands it would run ('plan'). ` +
      `To diff/review a change, use the ` +
      `appmap-review skill.`,
  );
}

function parseArgs(args) {
  const options = {
    help: false,
    dir: 'gold_traces',
    record: false,
    dryRun: false,
    only: [],
    testFile: null,
    testName: null,
    name: null,
    fresh: false,
  };

  let command = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!command && !arg.startsWith('--')) {
      command = arg;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dir') {
      index += 1;
      options.dir = args[index] ?? 'gold_traces';
      continue;
    }
    if (arg === '--record') {
      options.record = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--only') {
      index += 1;
      if (args[index]) {
        options.only.push(args[index]);
      }
      continue;
    }
    if (arg === '--test-file') {
      index += 1;
      options.testFile = args[index] ?? null;
      continue;
    }
    if (arg === '--test-name') {
      index += 1;
      options.testName = args[index] ?? null;
      continue;
    }
    if (arg === '--name') {
      index += 1;
      options.name = args[index] ?? null;
      continue;
    }
    if (arg === '--fresh') {
      options.fresh = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command, options };
}

function printHelp() {
  console.log(`Usage:
  node <skill>/assets/manage.mjs update   [--dir DIR] [--only TEST] [--record] [--dry-run]
  node <skill>/assets/manage.mjs check    [--dir DIR] [--only TEST] [--record]
  node <skill>/assets/manage.mjs discover [--dir DIR] --test-file FILE --test-name NAME
  node <skill>/assets/manage.mjs covers   [--dir DIR] --name NAME [--fresh]
  node <skill>/assets/manage.mjs plan     [--dir DIR] [--only TEST]

Maintains the committed gold-trace baselines. Diffing/reviewing a change is the
appmap-review skill's job, not this engine's.

  update    Re-bless baselines, but only the traces whose behavior changed
            (digest-gated, so untouched baselines stay byte-identical). Seeds a
            baseline for any entry that doesn't have one yet.
  check     Report size, shape, and repetition, and warn when a trace covers
            nothing the earlier entries do not. With --record, record twice and
            fail if the behavioral digest drifts.
  discover  Find a test's appmap_path for a new manifest entry: records the one
            test, checks each recording's shape, reports which appmap files the
            run produced and what they run that no committed baseline runs, plus
            a paste-ready entry stub.
  covers    List the committed baselines that run a code object whose id
            contains NAME (a class or method name), with the ids as the
            recordings spell them. With --fresh, search the recordings under
            appmap_dir instead (after recording a test directory) and print
            each match's test name and source location. No recording, no
            shell tools.
  plan      Print the record command(s) the engine would run for the entries,
            without running them.

Options:
  --dir DIR           Managed gold-traces directory, relative to the project root (default: gold_traces).
  --only TEST         update/check/plan: limit to the named test (repeatable).
  --record            update: record before updating. check: record twice and verify stability.
  --dry-run           update: report what would be blessed/seeded without writing anything.
  --test-file FILE    discover: the test file, as the record command needs it.
  --test-name NAME    discover: the test function/case name.
  --name NAME         covers: part of a class or method name to look for.
  --fresh             covers: search the recordings under appmap_dir, not the baselines.
  --help              Show this help.

Recording is configured in manifest.yaml under 'commands', one of two ways:

  framework: NAME     The engine knows how NAME names tests on its command line and
                      records the whole gold set in as few runs as NAME allows.
                      Optional 'runner' replaces the default launcher and 'args'
                      appends flags. Supported frameworks:
${describeFrameworks()}
  record: TEMPLATE    A full shell template with {test_file} and {test_name}, run
                      once per test. Use it for a runner the registry does not know.
`);
}

// ---------------------------------------------------------------------------
// Spec (one file: recording commands + the curated entry list)
// ---------------------------------------------------------------------------

async function loadManifest(manifestPath) {
  const raw = await readFileOrNull(manifestPath);
  if (raw === null) {
    throw new Error(`Missing gold-traces manifest: ${manifestPath}\nBootstrap the gold-traces directory first (see the appmap-gold-traces skill).`);
  }
  const manifest = parseYaml(raw, manifestPath);
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Invalid gold-traces manifest: ${manifestPath}`);
  }
  const commands = manifest.commands ?? {};
  const versioned = manifest.schema_version != null;
  const schemaVersion = Number(manifest.schema_version ?? 1);
  if (!Number.isInteger(schemaVersion) || ![1, 2].includes(schemaVersion)) {
    throw new Error(`Unsupported gold-traces schema_version '${manifest.schema_version}' in ${manifestPath}; expected 1 or 2.`);
  }
  const entries = manifest.entries ?? [];
  if (!Array.isArray(entries)) {
    throw new Error(`'entries' must be a list: ${manifestPath}`);
  }
  const framework = commands.framework == null ? null : String(commands.framework);
  const record = commands.record == null ? null : String(commands.record);
  if (framework && record) {
    throw new Error(`Set one of 'commands.framework' or 'commands.record' in ${manifestPath}, not both.`);
  }
  if (framework && !frameworkNames().includes(framework)) {
    throw new Error(`Unknown commands.framework '${framework}' in ${manifestPath}. Supported: ${frameworkNames().join(', ')}.`);
  }
  const batchSize = commands.batch_size == null ? null : Number(commands.batch_size);
  if (batchSize !== null && (!Number.isInteger(batchSize) || batchSize < 1)) {
    throw new Error(`'commands.batch_size' must be a positive integer in ${manifestPath}.`);
  }
  return {
    schema_version: schemaVersion,
    versioned,
    // Two ways to record. `framework` names a runner the engine knows (see
    // frameworks.mjs), so the manifest carries only the launcher and flags and the
    // engine batches tests per run. `record` is a full per-test shell template for
    // a runner the registry does not know.
    framework,
    runner: commands.runner == null ? null : String(commands.runner),
    args: commands.args == null ? null : String(commands.args),
    // Optional cap on how many tests share one run. Command length is capped
    // separately, by platform (see frameworks.mjs), so this is for smaller runs on
    // purpose: isolating a flaky test, or a runner that is slow with a long list.
    batch_size: batchSize,
    record,
    record_env: stringifyEnv(commands.record_env ?? {}),
    appmap_cli: commands.appmap_cli ?? defaultAppmapCli(),
    // Optional per-run expand list: package code-object ids rendered at function
    // granularity in the diagram. Default empty — package granularity is enough
    // for the digest (every recorded function is still a node).
    expand: Array.isArray(manifest.expand) ? manifest.expand.map(String) : [],
    // Optional values `appmap sanitize` keeps verbatim (passed as --allow). For
    // small public vocabularies only (enum state/role names); never anything that
    // identifies a person or authenticates a request.
    allow_values: Array.isArray(manifest.allow_values) ? manifest.allow_values.map(String) : [],
    entries,
  };
}

function stringifyEnv(envObject) {
  const out = {};
  for (const [key, value] of Object.entries(envObject)) {
    out[key] = String(value);
  }
  return out;
}

// Find the nearest-ancestor appmap.yml of the gold-traces dir. Its directory is the
// AppMap project root (passed to the CLI as --directory) and its `appmap_dir` says
// where recordings land — so neither needs to be configured. Its `packages` say
// which source is the project's own (see isProjectCode); a Ruby config's `gem:`
// entries have no `path` and are skipped.
async function locateAppmap(startDir) {
  let dir = startDir;
  for (;;) {
    const raw = await readFileOrNull(path.join(dir, 'appmap.yml'));
    if (raw !== null) {
      const appmapConfig = parseYaml(raw, path.join(dir, 'appmap.yml'));
      const settings = appmapConfig && typeof appmapConfig === 'object' ? appmapConfig : {};
      const appmapDir = settings.appmap_dir == null ? 'tmp/appmap' : String(settings.appmap_dir);
      const configuredPackagePaths = (Array.isArray(settings.packages) ? settings.packages : [])
        .filter((entry) => entry && typeof entry === 'object' && entry.path != null)
        .map((entry) => String(entry.path));
      const packagePaths = [...new Set(configuredPackagePaths.flatMap((packagePath) => [
        packagePath,
        path.resolve(dir, packagePath),
      ]))];
      return { appmapYmlDir: dir, appmapDir, packagePaths };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`No appmap.yml found in any ancestor of ${startDir}. The gold-traces dir must live inside an AppMap project.`);
    }
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// update — record + digest-gated bless
// ---------------------------------------------------------------------------

async function updateBaseline(env, entries, options) {
  const produced = options.record ? await rerecordEntries(env, entries) : null;
  await validateFreshEntries(env, entries, produced);

  const freshSeqDir = tempSequenceDir(env, 'update-current');
  const baseSeqDir = tempSequenceDir(env, 'update-baseline');
  await ensureDir(freshSeqDir);
  await ensureDir(baseSeqDir);

  let blessed = 0;
  let seeded = 0;
  let unchanged = 0;

  for (const entry of entries) {
    const freshAppMap = currentAppMapPath(env, entry);
    try {
      await fs.access(freshAppMap);
    } catch {
      // A wrong appmap_path guess fails here. When we just recorded, we know what
      // the run actually produced — surface it so the entry can be corrected.
      const candidates = produced?.get(entryKey(entry)) ?? [];
      const hint = candidates.length > 0
        ? `\nThe record step produced: ${candidates.join(', ')}\nFix the entry's appmap_path (see the 'discover' command).`
        : '';
      throw new Error(`Missing AppMap for ${entry.test_name} (record it first): ${freshAppMap}${hint}`);
    }
    const baselineAppMap = baselineAppMapPath(env, entry);

    // No committed baseline yet: seed it (new manifest entry).
    if ((await readFileOrNull(baselineAppMap)) === null) {
      if (!options.dryRun) {
        await ensureDir(path.dirname(baselineAppMap));
        await fs.copyFile(freshAppMap, baselineAppMap);
      }
      seeded += 1;
      console.log(`  seed   ${entry.test_name}`);
      continue;
    }

    // Digest-gate: only re-bless when behavior actually changed.
    const freshDigest = diagramDigest(await readJson(await exportSequenceDiagram(env, freshAppMap, freshSeqDir, entry)));
    const baseDigest = diagramDigest(await readJson(await exportSequenceDiagram(env, baselineAppMap, baseSeqDir, entry)));
    if (freshDigest === baseDigest) {
      unchanged += 1;
      continue;
    }

    if (!options.dryRun) {
      await fs.copyFile(freshAppMap, baselineAppMap);
    }
    blessed += 1;
    console.log(`  bless  ${entry.test_name}`);
  }

  const verb = options.dryRun ? 'Would bless' : 'Blessed';
  console.log(`${verb} ${blessed}, seeded ${seeded}, unchanged ${unchanged} (of ${entries.length}).`);
}

async function validateFreshEntries(env, entries, produced) {
  const failures = [];
  for (const entry of entries) {
    const freshAppMap = currentAppMapPath(env, entry);
    try {
      await fs.access(freshAppMap);
    } catch {
      const candidates = produced?.get(entryKey(entry)) ?? [];
      const hint = candidates.length > 0
        ? ` The record step produced: ${candidates.join(', ')}. Fix appmap_path with discover.`
        : '';
      failures.push(`${entry.test_name}: missing ${freshAppMap}.${hint}`);
      continue;
    }
    const assessment = assessAppMap(await readJson(freshAppMap), (await fs.stat(freshAppMap)).size, env.packagePaths);
    printAssessment(entry, assessment, { details: false });
    failures.push(...assessment.errors.map((error) => `${entry.test_name}: ${error}`));
    if (assessment.errors.length === 0) sanitizeAppMap(env, freshAppMap);
  }
  if (failures.length > 0) {
    throw new Error(`Gold trace suitability check failed:\n  ${failures.join('\n  ')}`);
  }
}

async function checkBaselines(env, entries, options) {
  if (!options.record) {
    let failed = false;
    const assessed = [];
    for (const entry of entries) {
      const appmapFile = baselineAppMapPath(env, entry);
      await assertExists(appmapFile, `Missing baseline for ${entry.test_name}`);
      const assessment = assessAppMap(await readJson(appmapFile), (await fs.stat(appmapFile)).size, env.packagePaths);
      printAssessment(entry, assessment, { details: true });
      failed ||= assessment.errors.length > 0;
      assessed.push({ name: entry.test_name, coverage: coverageOf(assessment, env.packagePaths) });
    }
    printCoverageOverlaps(assessed);
    if (failed) throw new Error('Gold trace suitability check failed.');
    console.log(`Checked ${entries.length} baseline trace(s).`);
    return;
  }

  requireRecordConfig(env, 'check --record');
  const first = await recordCheckPass(env, entries, 'check-first', true);
  const second = await recordCheckPass(env, entries, 'check-second', false);
  const unstable = entries.filter((entry) => first.get(entryKey(entry)) !== second.get(entryKey(entry)));
  if (unstable.length > 0) {
    throw new Error(`Nondeterministic gold traces: ${unstable.map((entry) => entry.test_name).join(', ')}`);
  }
  console.log(`Checked ${entries.length} trace(s): suitable and stable across two recordings.`);
}

async function recordCheckPass(env, entries, sequenceName, printDetails) {
  const produced = await rerecordEntries(env, entries);
  const failures = [];
  const digests = new Map();
  const assessed = [];
  const sequenceDir = tempSequenceDir(env, sequenceName);
  await ensureDir(sequenceDir);
  for (const entry of entries) {
    const candidates = produced.get(entryKey(entry)) ?? [];
    if (!candidates.includes(entry.appmap_path)) {
      failures.push(`${entry.test_name}: expected ${entry.appmap_path}; produced ${candidates.join(', ') || 'nothing'}`);
      continue;
    }
    const appmapFile = currentAppMapPath(env, entry);
    const assessment = assessAppMap(await readJson(appmapFile), (await fs.stat(appmapFile)).size, env.packagePaths);
    if (printDetails) printAssessment(entry, assessment, { details: true });
    failures.push(...assessment.errors.map((error) => `${entry.test_name}: ${error}`));
    assessed.push({ name: entry.test_name, coverage: coverageOf(assessment, env.packagePaths) });
    if (assessment.errors.length === 0) {
      sanitizeAppMap(env, appmapFile);
      digests.set(entryKey(entry), diagramDigest(await readJson(await exportSequenceDiagram(env, appmapFile, sequenceDir, entry))));
    }
  }
  if (printDetails) printCoverageOverlaps(assessed);
  if (failures.length > 0) {
    throw new Error(`Gold trace suitability check failed:\n  ${failures.join('\n  ')}`);
  }
  return digests;
}

// Record the entries, one runner invocation per plan group (see recordPlan). Each
// entry is mapped to the appmap files its group's run produced; with a batch of
// several tests that list covers the whole group, which is still enough to confirm
// the entry's own appmap_path is among them and to hint at the right path when not.
async function rerecordEntries(env, entries) {
  requireRecordConfig(env, '--record');
  const produced = new Map();
  for (const group of recordPlan(env, entries)) {
    for (const entry of group.entries) {
      if (entry.appmap_path) await fs.rm(currentAppMapPath(env, entry), { force: true });
    }
    const before = await snapshotAppmaps(env.appmapsDir);
    runRecordGroup(env, group);
    const changed = changedAppmaps(before, await snapshotAppmaps(env.appmapsDir));
    for (const entry of group.entries) {
      produced.set(entryKey(entry), changed);
    }
  }
  return produced;
}

function requireRecordConfig(env, what) {
  if (!env.config.record && !env.config.framework) {
    throw new Error(`${what} requires 'commands.framework' or 'commands.record' in ${env.manifestPath}`);
  }
}

// The commands that record a set of entries: one per entry for a `record` template,
// or as few as the framework's selector grammar allows for a `framework`. Either way
// the command names only the tests to run; the recorder alone decides where each
// recording file lands under appmap_dir.
function recordPlan(env, entries) {
  const { config } = env;
  if (config.record) {
    return entries.map((entry) => ({
      entries: [entry],
      command: substitute(config.record, { test_file: entry.test_file, test_name: entry.test_name }),
      env: {},
    }));
  }
  return planRecordCommands(config, entries, { batchSize: config.batch_size, cwd: env.workingDir });
}

function runRecordGroup(env, group) {
  runShell(group.command, {
    cwd: env.workingDir,
    env: { ...process.env, ...group.env, ...env.config.record_env },
  });
}

function printRecordPlan(env, entries) {
  requireRecordConfig(env, 'plan');
  const groups = recordPlan(env, entries);
  const how = env.config.framework
    ? `framework ${env.config.framework} (runner: ${resolveRunner(env.config, env.workingDir)}${env.config.runner ? '' : ', detected'})`
    : 'commands.record template, one run per test';
  console.log(`${groups.length} record run(s) for ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} via ${how}, from ${env.workingDir}:`);
  for (const group of groups) {
    console.log(`\n  ${group.command}`);
    for (const entry of group.entries) {
      console.log(`    - ${entry.test_name}`);
    }
  }
}

function entryKey(entry) {
  return `${entry.test_file}\0${entry.test_name}\0${entry.appmap_path ?? ''}`;
}

// ---------------------------------------------------------------------------
// discover — find a test's appmap_path by observing the recorder
// ---------------------------------------------------------------------------

// The appmap_path of a manifest entry is the recorder's choice, not ours: snapshot
// appmap_dir, record the one test, and report every appmap file the run created or
// rewrote. The caller copies the reported path into the manifest entry — nothing is
// written here.
async function discoverAppmapPath(env, options) {
  if (!options.testFile || !options.testName) {
    throw new Error(`discover requires --test-file and --test-name`);
  }
  requireRecordConfig(env, 'discover');
  const before = await snapshotAppmaps(env.appmapsDir);
  for (const group of recordPlan(env, [{ test_file: options.testFile, test_name: options.testName }])) {
    runRecordGroup(env, group);
  }
  const candidates = changedAppmaps(before, await snapshotAppmaps(env.appmapsDir));
  if (candidates.length === 0) {
    throw new Error(
      `The record command wrote no AppMap under ${env.appmapsDir}. ` +
        `The test records nothing — it is not a gold-trace candidate.`,
    );
  }

  console.log(`Recording(s) produced (relative to ${env.appmapsDir}):`);
  for (const candidate of candidates) {
    console.log(`  ${candidate}`);
  }
  if (candidates.length > 1) {
    console.log(`\nMultiple recordings — pick the one that captures the behavior to guard (a curation call).`);
  }
  // What the committed gold set already covers, so the candidate can be judged
  // on what it ADDS, not on its own shape alone.
  const existing = [];
  for (const entry of env.config.entries) {
    const baseline = baselineAppMapPath(env, entry);
    if ((await readFileOrNull(baseline)) === null) continue;
    const assessment = assessAppMap(await readJson(baseline), (await fs.stat(baseline)).size, env.packagePaths);
    existing.push({ name: entry.test_name, coverage: coverageOf(assessment, env.packagePaths) });
  }
  for (const candidate of candidates) {
    const appmapFile = path.join(env.appmapsDir, candidate);
    const assessment = assessAppMap(await readJson(appmapFile), (await fs.stat(appmapFile)).size, env.packagePaths);
    printAssessment({ test_name: candidate }, assessment, { details: true });
    printCoverageDelta(coverageDelta(coverageOf(assessment, env.packagePaths), existing), existing.length);
  }
  console.log(`\nManifest entry stub (paste under 'entries' in ${env.manifestPath}):

  - feature: TODO
    test_file: ${options.testFile}
    test_name: ${options.testName}
    appmap_path: ${candidates[0]}
    summary: TODO`);
}

// ---------------------------------------------------------------------------
// covers — which committed baseline runs a piece of code
// ---------------------------------------------------------------------------
//
// Answers "does a gold trace already run X?" from the committed baselines: no
// recording, no shell tools. Matches on part of a name and prints the ids as the
// recordings spell them, so a misspelled name shows up as a near miss instead of
// looking like a coverage gap. With --fresh it searches the recordings under
// appmap_dir instead, the fallback after recording a whole test directory, and
// names each match by the test name and source location in its metadata.

async function coversCommand(env, options) {
  if (!options.name) {
    throw new Error('covers requires --name (part of a class or method name)');
  }
  const needle = options.name;
  const what = options.fresh ? 'recording' : 'baseline';
  const candidates = options.fresh
    ? [...(await snapshotAppmaps(env.appmapsDir)).keys()].sort().map((relative) => ({ file: path.join(env.appmapsDir, relative), relative }))
    : env.config.entries.map((entry) => ({ file: baselineAppMapPath(env, entry), entry }));
  let searched = 0;
  let matched = 0;
  for (const candidate of candidates) {
    if ((await readFileOrNull(candidate.file)) === null) continue;
    searched += 1;
    const appmap = await readJson(candidate.file);
    const assessment = assessAppMap(appmap, (await fs.stat(candidate.file)).size, env.packagePaths);
    const hits = assessment.all_code_objects.filter((codeObject) => codeObject.includes(needle));
    if (hits.length === 0) continue;
    matched += 1;
    if (candidate.entry) {
      console.log(`  ${candidate.entry.test_name}  (${candidate.entry.test_file})`);
    } else {
      const metadata = appmap.metadata ?? {};
      const where = [metadata.name, metadata.source_location].filter(Boolean).join('  ');
      console.log(`  ${candidate.relative}${where ? `  (${where})` : ''}`);
    }
    console.log(`       ${hits.slice(0, 10).join(', ')}${hits.length > 10 ? ` (+${hits.length - 10} more)` : ''}`);
  }
  if (searched === 0) {
    const where = options.fresh ? env.appmapsDir : path.join(env.baselineRoot, 'appmaps');
    console.log(`No ${what}s to search under ${where}.`);
  } else if (matched === 0) {
    console.log(
      `No ${what} runs a code object matching '${needle}' (${searched} searched). ` +
        `Either nothing runs it, or the recordings spell it differently: try a shorter name, such as the class alone.`,
    );
  } else {
    console.log(`${matched} of ${searched} ${what}(s) run a code object matching '${needle}'.`);
  }
}

// Map of appmap-file relative path -> change signature, recursively under dir.
// A missing dir is an empty snapshot (the recorder may not have created it yet).
async function snapshotAppmaps(dir) {
  const snapshot = new Map();
  async function walk(current) {
    let dirents;
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
      } else if (dirent.name.endsWith('.appmap.json')) {
        const stat = await fs.stat(full);
        snapshot.set(path.relative(dir, full), `${stat.mtimeMs}:${stat.size}`);
      }
    }
  }
  await walk(dir);
  return snapshot;
}

// Paths new in `after` or whose signature changed — i.e. what the record run wrote.
// Re-recording an existing test overwrites its file, so "modified" counts too.
function changedAppmaps(before, after) {
  const changed = [];
  for (const [relPath, signature] of after) {
    if (before.get(relPath) !== signature) {
      changed.push(relPath);
    }
  }
  return changed.sort();
}

// ---------------------------------------------------------------------------
// AppMap CLI surface + digest
// ---------------------------------------------------------------------------

// Resolve the AppMap CLI to use when `commands.appmap_cli` is not configured.
// The IDE extensions install the binary to ~/.appmap/bin/appmap, so prefer that
// when present; otherwise fall back to `appmap` on PATH (the usual CI setup).
// Either way, no configuration is required.
// On Windows the binary carries an .exe extension.
function defaultAppmapCli() {
  const names = process.platform === 'win32' ? ['appmap.exe', 'appmap'] : ['appmap'];
  for (const name of names) {
    const ideBin = path.join(os.homedir(), '.appmap', 'bin', name);
    try {
      accessSync(ideBin, fsConstants.X_OK);
      return ideBin;
    } catch {
      // try the next name
    }
  }
  return 'appmap';
}

function cliInvocation(env) {
  const [bin, ...prefix] = env.config.appmap_cli.split(/\s+/).filter(Boolean);
  return { bin, prefix };
}

// Sanitize an AppMap in place (via `appmap sanitize`): replace every captured
// value string with a per-file, equality-preserving token, so the committed
// baseline is structurally incapable of carrying a secret. Sanitize is
// deterministic and idempotent. It is applied to the fresh recording before the
// baseline is digested and committed, so the digest comparison is
// sanitized-vs-sanitized (see the call site). Done here, in the engine, so
// projects don't have to wire sanitizing into their record command.
function sanitizeAppMap(env, appmapFile) {
  const { bin, prefix } = cliInvocation(env);
  // Pass any allow_values via --allow-file, not --allow: --allow is variadic and
  // would swallow the appmap path into its array (leaving zero positional args).
  // A file also handles values with spaces or shell-special characters cleanly.
  const allowArgs = [];
  if (env.config.allow_values.length > 0) {
    const allowFile = path.join(os.tmpdir(), 'appmap-gold-traces.allow');
    writeFileSync(allowFile, env.config.allow_values.join('\n') + '\n');
    allowArgs.push('--allow-file', allowFile);
  }
  try {
    runCommandQuiet(bin, [...prefix, 'sanitize', ...allowArgs, appmapFile], { cwd: env.workingDir });
  } catch (err) {
    // `sanitize` shipped in @appland/appmap 3.201.0; an older CLI fails here.
    throw new Error(
      `${err.message}\n\nThe 'sanitize' command requires @appland/appmap >= 3.201.0. ` +
        `Update the CLI, or point 'commands.appmap_cli' at a released version >= 3.201.0.`
    );
  }
}

async function exportSequenceDiagram(env, appmapFile, outputDir, entry) {
  // Export into a clean per-entry subdir. The CLI names its output after the
  // appmap file's basename, so two manifest entries with the same basename
  // (e.g. distinct describe blocks both ending in `is_recorded`) would collide
  // in a shared dir, and files left from a prior run would defeat the
  // new-file detection below. A dedicated, emptied dir per entry avoids both.
  outputDir = path.join(outputDir, entry.appmap_path.replace(/[^\w.-]+/g, '_'));
  await fs.rm(outputDir, { recursive: true, force: true });
  await ensureDir(outputDir);
  const before = new Set(await listJsonFiles(outputDir));
  const { bin, prefix } = cliInvocation(env);
  const args = [...prefix, 'sequence-diagram', appmapFile, '--directory', env.appmapYmlDir, '--format', 'json', '--output-dir', outputDir];
  for (const id of env.config.expand) {
    args.push('--expand', id);
  }
  runCommandQuiet(bin, args, { cwd: env.workingDir });
  const after = new Set(await listJsonFiles(outputDir));
  for (const candidate of after) {
    if (!before.has(candidate)) {
      return candidate;
    }
  }

  const fallback = path.join(outputDir, `${entry.test_name}.sequence.json`);
  await assertExists(fallback, `Unable to locate generated sequence diagram for ${entry.test_name}`);
  return fallback;
}

// A single sha256 over the diagram's root subtree digests (mirrors @appland/cli's
// SequenceDiagramDigest). The subtree digests carry only AppMap `stableProperties`,
// so elapsed time, object ids, and value-level volatility are already excluded.
function diagramDigest(diagram) {
  const hash = createHash('sha256');
  for (const action of diagram.rootActions ?? []) {
    hash.update(action.subtreeDigest ?? '');
  }
  return hash.digest('hex');
}

const DEFAULT_HYGIENE = {
  min_events: 10,
  warn_bytes: 500 * 1024,
  warn_events: 1500,
  warn_repeat_count: 100,
  warn_repeat_ratio: 0.25,
};

function assessAppMap(appmap, byteSize = 0, projectPackages = []) {
  const events = Array.isArray(appmap.events) ? appmap.events : [];
  const calls = events.filter((event) => event.event === 'call');
  const codeObjects = new Set();
  const projectCodeObjects = new Set();
  const classes = new Set();
  const projectClasses = new Set();
  const labels = new Set();
  const sqlTables = new Set();
  const httpRoutes = new Set();
  const frequencies = new Map();
  let sqlQueries = 0;
  let httpRequests = 0;

  for (const event of calls) {
    if (event.sql_query) {
      sqlQueries += 1;
      frequencies.set('SQL', (frequencies.get('SQL') ?? 0) + 1);
      for (const table of tablesIn(event.sql_query.sql)) sqlTables.add(table);
      continue;
    }
    if (event.http_server_request) {
      httpRequests += 1;
      const request = event.http_server_request;
      const route = `${request.request_method ?? ''} ${request.normalized_path_info ?? request.path_info ?? ''}`.trim();
      if (route) httpRoutes.add(route);
    } else if (event.http_client_request) {
      httpRequests += 1;
    }
    if (!event.defined_class || !event.method_id) continue;
    const separator = event.static ? '.' : '#';
    const codeObject = `${event.defined_class}${separator}${event.method_id}`;
    codeObjects.add(codeObject);
    classes.add(event.defined_class);
    if (isProjectCode(event.path, projectPackages)) {
      projectCodeObjects.add(codeObject);
      projectClasses.add(event.defined_class);
    }
    frequencies.set(codeObject, (frequencies.get(codeObject) ?? 0) + 1);
  }

  const repeated = [...frequencies.entries()].sort((a, b) => b[1] - a[1]);
  const errors = [];
  const warnings = [];
  if (events.length === 0) errors.push('contains zero events');
  else if (events.length < DEFAULT_HYGIENE.min_events) warnings.push(`contains only ${events.length} events`);
  if (calls.length === 0) errors.push('contains no function, HTTP, or SQL calls');

  collectLabels(appmap.classMap, labels);

  // A gold trace shows a subsystem working end to end, which shows up as calls
  // crossing classes and reaching SQL or HTTP. A recording that stays inside one
  // class and touches neither is the shape of a unit test.
  const ownClasses = projectPackages.length > 0 ? projectClasses : classes;
  if (calls.length > 0 && ownClasses.size <= 1 && sqlQueries === 0 && httpRequests === 0) {
    const scope = ownClasses.size === 0 ? 'no project class' : `only one project class (${[...ownClasses][0]})`;
    warnings.push(`runs ${scope} and makes no SQL or HTTP calls: reads like a unit test`);
  }

  if (byteSize > DEFAULT_HYGIENE.warn_bytes) warnings.push(`is large (${formatBytes(byteSize)})`);
  if (events.length > DEFAULT_HYGIENE.warn_events) warnings.push(`has ${events.length} events`);
  const noisy = repeated.filter(([, count]) =>
    count >= DEFAULT_HYGIENE.warn_repeat_count && count / Math.max(calls.length, 1) >= DEFAULT_HYGIENE.warn_repeat_ratio);
  if (noisy.length > 0) {
    warnings.push(`is dominated by repeated calls: ${noisy.slice(0, 3).map(([name, count]) => `${count}x ${name}`).join(', ')}`);
  }

  return {
    bytes: byteSize,
    events: events.length,
    calls: calls.length,
    sql_queries: sqlQueries,
    http_requests: httpRequests,
    code_objects: codeObjects.size,
    all_code_objects: [...codeObjects].sort(),
    project_code_objects: [...projectCodeObjects].sort(),
    project_classes: [...ownClasses].sort(),
    labels: [...labels].sort(),
    sql_tables: [...sqlTables].sort(),
    http_routes: [...httpRoutes].sort(),
    top_repeated: repeated.slice(0, 5),
    errors,
    warnings,
  };
}

// Table names a SQL statement reads or writes: a rough scan of the words after
// FROM / JOIN / INTO / UPDATE. Enough to say "this trace touches `coupons` and no
// other does"; not a SQL parser.
function tablesIn(sql) {
  const tables = new Set();
  for (const match of String(sql ?? '').matchAll(/\b(?:from|join|into|update)\s+["'`]?([A-Za-z_][\w.]*)/gi)) {
    tables.add(match[1].toLowerCase());
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Coverage: what an entry guards that no other entry guards
// ---------------------------------------------------------------------------
//
// One measured fact keeps the gold set from filling up with near-duplicates: the
// coverage delta. From the recordings, what a trace runs that no other trace
// runs: project code objects, labels, SQL tables, HTTP routes. `discover` reports
// it for a candidate against the committed set; `check` reports it for every
// entry against the entries before it and warns when it is empty. The engine
// prints the facts; whether the additions are worth an entry is the reader's call.

// A recording's project code objects, or every code object when the package
// filter matched none of them (a `packages` entry the matcher cannot read): a
// comparison over nothing would call every entry a duplicate of the first.
function coverageOf(assessment, projectPackages = []) {
  const useProject = projectPackages.length > 0 && assessment.project_code_objects.length > 0;
  return {
    code_objects: new Set(useProject ? assessment.project_code_objects : assessment.all_code_objects),
    labels: new Set(assessment.labels),
    tables: new Set(assessment.sql_tables),
    routes: new Set(assessment.http_routes),
  };
}

const COVERAGE_KINDS = [['code_objects', 'code objects'], ['labels', 'labels'], ['tables', 'SQL tables'], ['routes', 'HTTP routes']];

// What `candidate` covers that none of `others` ([{ name, coverage }]) covers, plus
// the other entry whose code objects overlap the candidate's the most.
function coverageDelta(candidate, others) {
  const added = {};
  for (const [kind] of COVERAGE_KINDS) {
    const union = new Set(others.flatMap((other) => [...other.coverage[kind]]));
    added[kind] = [...candidate[kind]].filter((item) => !union.has(item)).sort();
  }
  let mostSimilar = null;
  for (const other of others) {
    const shared = [...candidate.code_objects].filter((item) => other.coverage.code_objects.has(item)).length;
    const overlap = candidate.code_objects.size > 0 ? shared / candidate.code_objects.size : 0;
    if (!mostSimilar || overlap > mostSimilar.overlap) mostSimilar = { name: other.name, overlap };
  }
  const isNew = Object.values(added).some((list) => list.length > 0);
  return { added, mostSimilar, isNew };
}

function describeAdded(added) {
  return COVERAGE_KINDS
    .filter(([kind]) => added[kind].length > 0)
    .map(([kind, label]) => `${label} ${added[kind].slice(0, 8).join(', ')}${added[kind].length > 8 ? ` (+${added[kind].length - 8} more)` : ''}`)
    .join('; ');
}

function printCoverageDelta(delta, existingCount) {
  if (existingCount === 0) {
    console.log(`       coverage: first entry; nothing to compare against yet`);
    return;
  }
  const similar = delta.mostSimilar ? ` (closest: ${delta.mostSimilar.name}, ${Math.round(delta.mostSimilar.overlap * 100)}% of this trace's code objects appear there)` : '';
  if (delta.isNew) {
    console.log(`       adds coverage no existing entry has: ${describeAdded(delta.added)}${similar}`);
  } else {
    console.log(`       adds no coverage beyond the existing entries${similar}`);
  }
}

// For `check`: each entry against the entries before it, in manifest order, so
// a newly added duplicate is the one that gets the warning. A warning per entry
// whose recording covers nothing the earlier ones do not.
function printCoverageOverlaps(assessed) {
  for (const [index, entry] of assessed.entries()) {
    if (index === 0) continue;
    const delta = coverageDelta(entry.coverage, assessed.slice(0, index));
    if (delta.isNew) continue;
    console.log(`  WARN ${entry.name}: runs no code object, label, SQL table, or HTTP route that the earlier entries do not (closest: ${delta.mostSimilar.name}, ${Math.round(delta.mostSimilar.overlap * 100)}% overlap). Keep it only if it drives a branch inside those functions that ${delta.mostSimilar.name} does not (a refusal, a fallback, a guard); otherwise merge it into that entry.`);
  }
}

function printAssessment(entry, assessment, { details }) {
  const verdict = assessment.errors.length > 0 ? 'FAIL' : assessment.warnings.length > 0 ? 'WARN' : 'OK';
  console.log(`  ${verdict.padEnd(4)} ${entry.test_name}: ${formatBytes(assessment.bytes)}, ${assessment.events} events, ` +
    `${assessment.code_objects} code objects, ${assessment.sql_queries} SQL, ${assessment.http_requests} HTTP, ` +
    `${assessment.labels.length} labels`);
  for (const warning of assessment.warnings) console.log(`       warning: ${warning}`);
  for (const error of assessment.errors) console.log(`       error: ${error}`);
  if (details) {
    if (assessment.top_repeated.length > 0) {
      console.log(`       repeated: ${assessment.top_repeated.map(([name, count]) => `${count}x ${name}`).join(', ')}`);
    }
    if (assessment.labels.length > 0) console.log(`       labels: ${assessment.labels.join(', ')}`);
    if (assessment.project_code_objects.length > 0) {
      const shown = assessment.project_code_objects.slice(0, 30);
      const remaining = assessment.project_code_objects.length - shown.length;
      console.log(`       project code objects: ${shown.join(', ')}${remaining > 0 ? ` (+${remaining} more)` : ''}`);
    }
  }
}

// Is this event's source file inside one of appmap.yml's `packages`? A package
// `path` is a directory for Ruby and Node (`app/models`, `src`), but a dotted
// package name for Java and Python (`org.finos.waltz`, `myapp.core`). A dotted
// name is matched as a directory run anywhere in the file path, since the file
// lives under a source root the config does not mention
// (`waltz-data/src/main/java/org/finos/waltz/data/FlowDao.java`).
function isProjectCode(eventPath, projectPackages) {
  if (!eventPath || eventPath.startsWith('<')) return false;
  const absoluteEvent = path.isAbsolute(eventPath);
  const normalized = eventPath.replaceAll(path.sep, '/').replace(/^\.\//, '');
  return projectPackages.some((packagePath) => {
    const packagePrefix = packagePath.replaceAll(path.sep, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (packagePrefix === '.') return !absoluteEvent && !normalized.startsWith('node_modules/');
    if (!packagePrefix.includes('/') && packagePrefix.includes('.') && !path.isAbsolute(packagePath)) {
      const run = packagePrefix.replaceAll('.', '/');
      return normalized.startsWith(`${run}/`) || normalized.includes(`/${run}/`);
    }
    if (absoluteEvent !== path.isAbsolute(packagePath)) return false;
    return normalized === packagePrefix || normalized.startsWith(`${packagePrefix}/`);
  });
}

function collectLabels(nodes, labels) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    for (const label of Array.isArray(node.labels) ? node.labels : []) labels.add(String(label));
    collectLabels(node.children, labels);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function currentAppMapPath(env, entry) {
  return path.join(env.appmapsDir, entry.appmap_path);
}

function baselineAppMapPath(env, entry) {
  return path.join(env.baselineRoot, 'appmaps', entry.appmap_path);
}

function tempSequenceDir(env, name) {
  return path.join(env.tempRoot, name, 'sequences');
}

// ---------------------------------------------------------------------------
// Process + fs helpers
// ---------------------------------------------------------------------------

function substitute(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

async function listJsonFiles(dir) {
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readFileOrNull(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function assertExists(filePath, message) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`${message}: ${filePath}`);
  }
}

// Run a command, capturing stdout/stderr. The AppMap CLI is chatty (per-export
// "Printed diagram ..." lines, and @appland/models logs SQL it can't parse), so
// we stay quiet on success and surface the captured output only on failure.
function runCommandQuiet(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) {
    throw new Error(`Command failed to start: ${command} (${result.error.message})`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${detail}`);
  }
}

function runShell(command, options) {
  const result = spawnSync(command, { stdio: 'inherit', shell: true, ...options });
  if (result.error) {
    throw new Error(`Command failed to start: ${command} (${result.error.message})`);
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// YAML reader
// ---------------------------------------------------------------------------
//
// js-yaml, vendored under assets/vendor so the skill stays zero-install (see
// vendor/README.md for the version and how to upgrade). Standard YAML: comments
// anywhere, flow collections, anchors, multi-line scalars all work.

function parseYaml(text, filename = 'manifest.yaml') {
  try {
    return loadYaml(text, { filename }) ?? null;
  } catch (error) {
    throw new Error(`Invalid YAML in ${filename}: ${error.message}`);
  }
}
// The appmap-review skill's helper (appmap-review/assets/review.mjs) reuses the
// manifest reader, the appmap.yml lookup, and the CLI resolution from here.
export {
  parseYaml, diagramDigest, changedAppmaps, assessAppMap, coverageOf, coverageDelta,
  loadManifest, locateAppmap, defaultAppmapCli,
};

// Resolve symlinks on argv[1]: import.meta.url is always realpath-resolved, but
// the invoked path may be a symlink (this skill is commonly symlinked into a
// project's .claude/skills/), which would otherwise make this guard false and
// silently skip main().
function invokedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (invokedAsScript()) {
  // Top-level await (not a floating main().catch()) so a rejection's diagnostic
  // is flushed before exit. process.exit() truncated buffered stdout/stderr,
  // which made failed runs look silent with a 0 status.
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
