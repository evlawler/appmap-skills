#!/usr/bin/env node

// Behavioral compare for the appmap-review skill.
//
// Turns two revisions into the facts the review interprets: each side's gold
// traces, archived and compared with the AppMap CLI. Run from the project root
// (the directory that holds gold_traces/):
//
//   node <skill>/assets/review.mjs compare --base main
//   node <skill>/assets/review.mjs compare --base v1.2.0 --head feature-branch
//   node <skill>/assets/review.mjs compare --base <last blessed commit> --fresh
//   node <skill>/assets/review.mjs compare --base-appmap old.appmap.json --head-appmap new.appmap.json
//
// It needs only git, Node, and the AppMap CLI, so it runs the same on macOS,
// Linux, and Windows. The steps, and the CLI traps each one avoids:
//
//   1. Collect each side's gold traces into <workspace>/base and <workspace>/head,
//      under appmap_dir, keeping each trace's path below baseline/appmaps/ (two
//      traces may share a basename). Each side is a "source" (see below): the
//      base is always a git revision; the head is a git revision, the fresh
//      recordings (--fresh), or the working tree's baselines (--uncommitted).
//      Or both sides are single files (--base-appmap/--head-appmap): two
//      recordings of one scenario made by hand, copied to one shared trace name
//      so they compare as one trace however the files were named. That mode
//      reads no manifest and no gold traces.
//   2. `appmap archive` each side. It writes its default .appmap/archive/full/<rev>.tar;
//      an absolute --output-file is mangled by its internal tar.
//   3. `appmap restore` each archive into out/report/<rev>. A plain tar extraction
//      leaves the inner appmaps.tar.gz packed, and compare then sees zero AppMaps.
//      restore refuses a directory that already exists, so none is created first.
//   4. `appmap compare` from out/, which needs appmap.yml in its working dir. No
//      --clobber-output-dir: it would delete the restored base/ and head/.
//
// The workspace lives outside the repo, so its files are never committed by accident.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// The manifest reader, the appmap.yml lookup, and the CLI resolution are shared
// with the gold-traces engine, which this skill already depends on.
import { loadManifest, locateAppmap, defaultAppmapCli } from '../../appmap-gold-traces/assets/manage.mjs';

const WORKSPACE_MARKER = '.appmap-review-workspace';

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || options.help) {
    printHelp();
    return;
  }
  if (command !== 'compare') {
    throw new Error(`Unknown command: ${command}. The only command is 'compare'; see --help.`);
  }
  const adhoc = options.baseAppmap !== null || options.headAppmap !== null;
  if (adhoc && (options.baseAppmap === null || options.headAppmap === null)) {
    throw new Error('Ad-hoc mode needs both sides: pass --base-appmap FILE and --head-appmap FILE.');
  }
  if (adhoc && (options.fresh || options.uncommitted)) {
    throw new Error('--base-appmap/--head-appmap cannot be combined with --fresh or --uncommitted.');
  }
  if (!adhoc && !options.base) {
    throw new Error('compare requires --base REV, the revision to compare against.');
  }
  const headSources = [options.head !== null, options.fresh, options.uncommitted].filter(Boolean).length;
  if (headSources > 1) {
    throw new Error('Pass at most one of --head, --fresh, and --uncommitted.');
  }

  const projectRoot = process.cwd();
  const goldDir = path.resolve(projectRoot, options.dir);
  // Ad-hoc mode has no manifest: the recordings are named on the command line
  // and the CLI comes from --appmap-cli or the usual default.
  const config = adhoc ? null : await loadManifest(path.join(goldDir, 'manifest.yaml'));
  const { appmapYmlDir, appmapDir } = await locateAppmap(adhoc ? projectRoot : goldDir);
  const appmapYml = path.join(appmapYmlDir, 'appmap.yml');
  const appmapsDir = path.join(appmapYmlDir, appmapDir);
  const baselineDir = path.join(goldDir, 'baseline', 'appmaps');
  const cli = cliInvocation(adhoc ? options.appmapCli ?? defaultAppmapCli() : config.appmap_cli);

  let base;
  let head;
  if (adhoc) {
    // The revisions are optional here; they only name the source diff.
    const name = options.name ?? sharedName(options.baseAppmap, options.headAppmap);
    base = fileSource(options.baseAppmap, name, options.base && resolveRevision(projectRoot, options.base));
    head = fileSource(options.headAppmap, name, options.head && resolveRevision(projectRoot, options.head));
  } else if (options.fresh) {
    base = gitSource(projectRoot, options.base, baselineDir);
    head = freshSource(config.entries, appmapsDir);
  } else if (options.uncommitted) {
    base = gitSource(projectRoot, options.base, baselineDir);
    head = uncommittedSource(baselineDir);
  } else {
    base = gitSource(projectRoot, options.base, baselineDir);
    head = gitSource(projectRoot, options.head ?? 'HEAD', baselineDir);
  }

  const workspace = await prepareWorkspace(path.resolve(options.workspace ?? path.join(os.tmpdir(), 'appmap-review')));
  const out = path.join(workspace, 'out');

  // 1 — extract. Both appmap_dirs exist even when a side has no traces (a first
  // baseline): `appmap archive` fails on a missing one.
  const counts = {};
  const baseAppmaps = path.join(workspace, 'base', appmapDir);
  const headAppmaps = path.join(workspace, 'head', appmapDir);
  await fs.mkdir(baseAppmaps, { recursive: true });
  await fs.mkdir(headAppmaps, { recursive: true });
  counts.base = await base.collect(baseAppmaps);
  counts.head = await head.collect(headAppmaps);
  if (counts.base === 0) {
    console.error(`note: ${base.rev} has no gold traces under ${baselineDir}; every head trace will show as new.`);
  }
  if (counts.head === 0) {
    console.error('note: the head has no gold traces; every base trace will show as removed.');
  }

  // appmap.yml goes into every directory the CLI runs in, so both sides are
  // indexed with the same config.
  await fs.mkdir(path.join(out, 'report'), { recursive: true });
  for (const dir of [path.join(workspace, 'base'), path.join(workspace, 'head'), out]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(appmapYml, path.join(dir, 'appmap.yml'));
  }

  // 2, 3 — archive and restore
  for (const side of ['base', 'head']) {
    console.error(`Archiving ${side} (${counts[side]} AppMap(s))...`);
    const sideDir = path.join(workspace, side);
    runCli(cli, ['archive', '--revision', side], sideDir);
    runCli(cli, ['restore', '--revision', side, '--output-dir', path.join('..', 'out', 'report', side)], sideDir);
  }

  // 4 — compare
  console.error('Comparing...');
  runCli(cli, ['compare', '--base-revision', 'base', '--head-revision', 'head', '--output-dir', 'report'], out);

  await printSummary({ base, head, counts, reportDir: path.join(out, 'report') });
}

function parseArgs(args) {
  const options = {
    help: false,
    dir: 'gold_traces',
    base: null,
    head: null,
    fresh: false,
    uncommitted: false,
    workspace: null,
    baseAppmap: null,
    headAppmap: null,
    name: null,
    appmapCli: null,
  };
  const valued = {
    '--dir': 'dir', '--base': 'base', '--head': 'head', '--workspace': 'workspace',
    '--base-appmap': 'baseAppmap', '--head-appmap': 'headAppmap', '--name': 'name', '--appmap-cli': 'appmapCli',
  };
  let command = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!command && !arg.startsWith('-')) {
      command = arg;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--fresh') {
      options.fresh = true;
    } else if (arg === '--uncommitted') {
      options.uncommitted = true;
    } else if (arg in valued) {
      index += 1;
      if (args[index] === undefined) throw new Error(`${arg} needs a value.`);
      options[valued[arg]] = args[index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { command, options };
}

function printHelp() {
  console.log(`Usage:
  node <skill>/assets/review.mjs compare --base REV [--head REV | --fresh | --uncommitted]
                                         [--dir DIR] [--workspace DIR]
  node <skill>/assets/review.mjs compare --base-appmap FILE --head-appmap FILE [--name NAME]
                                         [--base REV] [--head REV] [--appmap-cli CMD] [--workspace DIR]

Compares the gold traces of two revisions with the AppMap CLI (archive, restore,
compare) and prints where the results are. Interpreting them is the review.

The second form (ad-hoc mode) compares two recordings made by hand, for example
one Postman run recorded on each of two branches. It reads no manifest and no
gold_traces/, only the nearest appmap.yml above the current directory.

  --base REV        The baseline revision: any git ref. Its gold traces are read from git.
  --head REV        The head revision (default: HEAD). Its gold traces are read from git.
  --fresh           Head is the working tree: the recordings under appmap_dir for the
                    manifest's entries. Run gold-traces 'check --record' or
                    'update --dry-run' first; they sanitize the recordings.
  --uncommitted     Head is the working tree: the baselines under DIR/baseline/appmaps,
                    blessed but not committed.
  --dir DIR         Gold-traces directory, relative to the project root (default: gold_traces).
  --base-appmap FILE, --head-appmap FILE
                    Ad-hoc mode: the recording made on each side. Both are copied to one
                    trace name, so the compare reports one trace however the files are named.
  --name NAME       Ad-hoc mode: that trace name (default: the files' shared basename, else
                    'recording'). In this mode --base and --head are optional and only name
                    the source diff.
  --appmap-cli CMD  Ad-hoc mode: the AppMap CLI to run (default: ~/.appmap/bin/appmap if
                    present, else appmap on PATH). Other modes take it from the manifest.
  --workspace DIR   Where the work happens (default: <system temp>/appmap-review). It is
                    cleared on every run, so the command refuses a non-empty directory it
                    did not make.
  --help            Show this help.

The summary ends with the command line as typed and the directory it ran in;
copy both into the report so a reader can rerun the compare.

Output, under the workspace:
  out/report/change-report.json   new, removed, and changed traces; SQL, API, and findings diffs
  out/report/diff/                one diff sequence diagram per changed trace
`);
}

// ---------------------------------------------------------------------------
// Sources: where each side's recordings come from
// ---------------------------------------------------------------------------
//
// A source is { label, collect(dest) } plus, for a git revision, { rev, sha,
// short }. `collect` copies the side's recordings under `dest` (the side's
// appmap_dir in the workspace) and returns how many it copied. The summary
// prints the label; the source diff line uses the sha when there is one.

function gitSource(projectRoot, rev, baselineDir) {
  const revision = resolveRevision(projectRoot, rev);
  return { ...revision, collect: (dest) => extractFromGit(projectRoot, revision.sha, baselineDir, dest) };
}

function freshSource(entries, appmapsDir) {
  return {
    label: `working tree, fresh recordings under ${appmapsDir}`,
    collect: (dest) => copyFreshRecordings(entries, appmapsDir, dest),
  };
}

function uncommittedSource(baselineDir) {
  return {
    label: `working tree, baselines under ${baselineDir}`,
    collect: (dest) => copyTree(baselineDir, dest),
  };
}

// One recording made by hand, copied to adhoc/<name>.appmap.json. The revision,
// when given, only names the source diff.
function fileSource(file, name, revision) {
  const source = path.resolve(file);
  return {
    ...(revision ?? {}),
    label: `${revision ? `${revision.label}, ` : ''}recording ${source}`,
    single: true,
    collect: async (dest) => {
      const target = path.join(dest, 'adhoc', `${name}.appmap.json`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.copyFile(source, target);
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error(`Recording not found: ${source}`);
        throw error;
      }
      return 1;
    },
  };
}

function sharedName(baseFile, headFile) {
  const strip = (file) => path.basename(file).replace(/\.appmap\.json$/, '');
  return strip(baseFile) === strip(headFile) ? strip(baseFile) : 'recording';
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(cwd, args) {
  // Baselines can be large; the default 1 MB buffer would cut them off.
  const result = spawnSync('git', args, { cwd, maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`Could not run git (${result.error.message}). The review reads gold traces from git history.`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr.toString('utf8').trim()}`);
  }
  return result.stdout;
}

function resolveRevision(cwd, rev) {
  let sha;
  try {
    sha = git(cwd, ['rev-parse', '--verify', `${rev}^{commit}`]).toString('utf8').trim();
  } catch (error) {
    throw new Error(`Cannot resolve '${rev}' to a commit.\n${error.message}`);
  }
  const line = git(cwd, ['log', '-1', '--format=%h %s', sha]).toString('utf8').trim();
  const [short, ...subject] = line.split(' ');
  return { rev, sha, short, label: `${rev} = ${short} ${subject.join(' ')}` };
}

// Write every gold trace committed at `sha` into `dest`, each at its path below
// baseline/appmaps/. git prints paths relative to the working directory, and the
// `./` in `<sha>:./<path>` reads them back the same way, so a project below the
// repo root (server/ in a monorepo) needs nothing special.
async function extractFromGit(cwd, sha, baselineDir, dest) {
  const spec = toGitPath(path.relative(cwd, baselineDir));
  const listing = git(cwd, ['ls-tree', '-r', '-z', '--name-only', sha, '--', spec]).toString('utf8');
  const files = listing.split('\0').filter((file) => file.endsWith('.appmap.json'));
  for (const file of files) {
    const relative = file.slice(spec.length + 1);
    const target = path.join(dest, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, git(cwd, ['cat-file', 'blob', `${sha}:./${file}`]));
  }
  return files.length;
}

function toGitPath(relative) {
  return relative.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Working-tree heads
// ---------------------------------------------------------------------------

async function copyFreshRecordings(entries, appmapsDir, dest) {
  const missing = [];
  let copied = 0;
  for (const entry of entries) {
    const source = path.join(appmapsDir, entry.appmap_path);
    try {
      await fs.access(source);
    } catch {
      missing.push(`${entry.test_name}: ${source}`);
      continue;
    }
    const target = path.join(dest, entry.appmap_path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    copied += 1;
  }
  if (missing.length > 0) {
    throw new Error(
      `--fresh needs a recording for every manifest entry. Missing:\n  ${missing.join('\n  ')}\n` +
        `Record them with the gold-traces engine: 'check --record', or 'update --record --dry-run'.`,
    );
  }
  return copied;
}

async function copyTree(source, dest) {
  let copied = 0;
  for (const relative of await listAppmaps(source)) {
    const target = path.join(dest, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, relative), target);
    copied += 1;
  }
  return copied;
}

async function listAppmaps(root, dir = root) {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const found = [];
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) found.push(...(await listAppmaps(root, full)));
    else if (dirent.name.endsWith('.appmap.json')) found.push(path.relative(root, full));
  }
  return found;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

// The workspace is cleared on every run. To make that safe for a --workspace the
// caller names, clear only a directory this command made: one with the marker
// file, or one holding nothing but the base/, head/, and out/ an earlier run left.
async function prepareWorkspace(dir) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const ours = names.includes(WORKSPACE_MARKER) || names.every((name) => ['base', 'head', 'out'].includes(name));
  if (!ours) {
    throw new Error(`Refusing to clear ${dir}: it is not empty and this command did not make it. Pass --workspace with a new or empty directory.`);
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, WORKSPACE_MARKER), 'Made by appmap-review/assets/review.mjs. Cleared on every run.\n');
  return dir;
}

// ---------------------------------------------------------------------------
// AppMap CLI
// ---------------------------------------------------------------------------

function cliInvocation(appmapCli) {
  const [bin, ...prefix] = appmapCli.split(/\s+/).filter(Boolean);
  return { bin, prefix };
}

// Quiet on success; the CLI prints progress for every AppMap. On Windows an
// npm-installed `appmap` is a .cmd script, which Node starts only through a shell.
function runCli(cli, args, cwd) {
  const shell = process.platform === 'win32' && !/\.exe$/i.test(cli.bin);
  const bin = shell && /\s/.test(cli.bin) ? `"${cli.bin}"` : cli.bin;
  const result = spawnSync(bin, [...cli.prefix, ...args], { cwd, encoding: 'utf8', shell, maxBuffer: 256 * 1024 * 1024 });
  const command = [cli.bin, ...cli.prefix, ...args].join(' ');
  if (result.error) {
    throw new Error(`Could not start the AppMap CLI: ${command} (${result.error.message}). Install @appland/appmap, or set commands.appmap_cli in the manifest.`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Command failed in ${cwd}: ${command}\n${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

async function printSummary({ base, head, counts, reportDir }) {
  const reportFile = path.join(reportDir, 'change-report.json');
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  const list = (value) => (Array.isArray(value) ? value : []);
  const changed = list(report.changedAppMaps);
  const added = list(report.newAppMaps);
  const removed = list(report.removedAppMaps);

  const traces = (source, count) => (source.single ? '' : ` (${count} gold traces)`);
  console.log(`Base: ${base.label}${traces(base, counts.base)}`);
  console.log(`Head: ${head.label}${traces(head, counts.head)}`);
  console.log('');
  console.log(`Traces: ${changed.length} changed, ${added.length} new, ${removed.length} removed.`);
  for (const item of changed) {
    const diff = item.sequenceDiagramDiff ? `  (diff/${item.sequenceDiagramDiff})` : '';
    console.log(`  changed  ${item.appmap}${diff}`);
  }
  for (const name of added) console.log(`  new      ${name}`);
  for (const name of removed) console.log(`  removed  ${name}`);

  const sql = report.sqlDiff;
  if (sql) {
    const tables = [
      ...list(sql.newTables).map((table) => `+${table}`),
      ...list(sql.removedTables).map((table) => `-${table}`),
    ];
    console.log(`SQL: ${list(sql.newQueries).length} new queries, ${list(sql.removedQueries).length} removed` +
      `${tables.length > 0 ? `; tables ${tables.join(', ')}` : ''}.`);
  }
  const api = report.apiDiff;
  if (api) {
    const differences = list(api.nonBreakingDifferences).length + list(api.unclassifiedDifferences).length;
    console.log(`API: ${api.breakingDifferencesFound ? 'BREAKING change found' : 'no breaking change'}, ${differences} other difference(s).`);
  }
  const findings = report.findingDiff;
  if (findings) {
    console.log(`Scanner findings: ${list(findings.new).length} new, ${list(findings.resolved).length} resolved.`);
  }
  const failures = list(report.testFailures);
  if (failures.length > 0) console.log(`Test failures recorded: ${failures.length}.`);

  console.log('');
  console.log(`Command:       ${invocation()}`);
  console.log(`Run in:        ${process.cwd()}`);
  console.log(`Change report: ${reportFile}`);
  console.log(`Diff diagrams: ${path.join(reportDir, 'diff')}`);
  if (base.sha) {
    console.log(`Source diff:   git diff ${head.sha ? `${base.short}..${head.short}` : base.short}`);
  } else {
    console.log('Source diff:   not named; pass --base REV [--head REV] to have it printed here.');
  }
}

// The command line as typed, for the report's invocation record. Values with
// spaces are quoted so the line can be run again as printed.
function invocation() {
  const quote = (arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg);
  return ['node', process.argv[1], ...process.argv.slice(2)].map(quote).join(' ');
}

// Resolve symlinks on argv[1] (the skill is often symlinked into .claude/skills/),
// as the gold-traces engine does.
function invokedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (invokedAsScript()) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
