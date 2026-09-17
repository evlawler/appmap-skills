// Two views of a changed trace, and which one to read first.
//
// After `appmap compare`, each changed trace has a diff sequence diagram. This
// module adds a second view, a plain-text diff of the two call trees, and then
// measures both to say which to read first:
//
//   1. `appmap index` each side into a query database in the workspace.
//   2. `appmap query tree --json` the trace on each side; render one line per
//      event (timings and return values left out, SQL kept whole) and diff the
//      two with `git diff --no-index`. Written under <reportDir>/tree/.
//   3. Apply RULES, in order, to the diagram's and the tree diff's measurements.
//
// The sequence diagram stays the authority for whether a trace changed and for
// its labels. The tree is preferred only when a measured condition says it will
// read better: a block that moved to a new caller (the diagram shows a removal
// plus an addition), or a diff too large to scan as JSON.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// Returns { <trace>: { tree: { diff, lines } | null, advice: { read, reason } } }.
// `run(args, cwd)` runs the AppMap CLI and returns its stdout.
export async function describeChangedTraces({ run, workspace, appmapDir, reportDir }) {
  const report = JSON.parse(await fs.readFile(path.join(reportDir, 'change-report.json'), 'utf8'));
  const changed = Array.isArray(report.changedAppMaps) ? report.changedAppMaps : [];
  if (changed.length === 0) return {};

  const sides = {};
  for (const side of ['base', 'head']) {
    // Each side's commands run in its directory, which holds appmap.yml.
    sides[side] = { dir: path.join(workspace, side), appmaps: path.join(workspace, side, appmapDir), db: path.join(workspace, `${side}-query.db`) };
  }
  let indexed = true;
  try {
    console.error('Indexing both sides for call trees...');
    for (const side of ['base', 'head']) {
      run(['index', '--appmap-dir', sides[side].appmaps, '--query-db', sides[side].db], sides[side].dir);
    }
  } catch (error) {
    console.error(`note: call-tree diffs skipped; 'appmap index --query-db' failed (${firstLine(error.message)}). Update @appland/appmap.`);
    indexed = false;
  }

  const views = {};
  for (const item of changed) {
    const tree = indexed ? await writeTreeDiff(run, sides, item.appmap, path.join(reportDir, 'tree')) : null;
    let diagram = null;
    if (item.sequenceDiagramDiff) {
      try {
        diagram = diagramStats(JSON.parse(await fs.readFile(path.join(reportDir, 'diff', item.sequenceDiagramDiff), 'utf8')));
      } catch {
        diagram = null;
      }
    }
    views[item.appmap] = { tree, diagram, advice: decideView(diagram, tree) };
  }
  return views;
}

// ---------------------------------------------------------------------------
// The tree diff
// ---------------------------------------------------------------------------

async function writeTreeDiff(run, sides, trace, treeDir) {
  const files = {};
  for (const side of ['base', 'head']) {
    let nodes;
    try {
      nodes = JSON.parse(run(['query', 'tree', trace, '--json', '--appmap-dir', sides[side].appmaps, '--query-db', sides[side].db], sides[side].dir));
    } catch (error) {
      console.error(`note: no call tree for ${trace} (${side}): ${firstLine(error.message)}`);
      return null;
    }
    files[side] = path.join(treeDir, `${trace}.${side}.txt`);
    await fs.mkdir(path.dirname(files[side]), { recursive: true });
    await fs.writeFile(files[side], renderShape(nodes));
  }
  const diffFile = path.join(treeDir, `${trace}.diff.txt`);
  const diff = gitDiffNoIndex(treeDir, path.relative(treeDir, files.base), path.relative(treeDir, files.head));
  await fs.writeFile(diffFile, diff);
  return { diff: diffFile, ...treeDiffStats(diff) };
}

// One line per event from the typed nodes of `query tree --json`. Left out on
// purpose: elapsed times and return values, which the compare digest also
// ignores. Everything else is kept whole, SQL above all: a query that differs
// only in a literal is usually data, but a changed hardcoded limit or status is
// a finding the digest cannot show, so the reviewer gets to see it.
export function renderShape(nodes) {
  const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const where = (node) => (node.path ? ` @ ${node.path}${node.lineno != null ? `:${node.lineno}` : ''}` : '');
  const lines = nodes.map((node) => {
    const indent = '  '.repeat(node.depth ?? 0);
    switch (node.kind) {
      case 'http_server':
        return `${indent}HTTP→  ${node.method} ${node.route} → HTTP ${node.status_code}`;
      case 'http_client':
        return `${indent}HTTP←  ${node.method} ${node.url}${node.status_code != null ? ` → ${node.status_code}` : ''}`;
      case 'sql':
        return `${indent}SQL    ${oneLine(node.sql_text)}`;
      case 'function':
        return `${indent}CALL   ${node.fqid ?? `${node.defined_class}${node.is_static ? '.' : '#'}${node.method_id}`}`;
      case 'exception':
        return `${indent}EXC    ${node.exception_class}${node.message ? `: ${oneLine(node.message)}` : ''}${where(node)}`;
      case 'log':
        return `${indent}LOG    ${node.logger}.${node.method_id}${node.message ? `: ${oneLine(node.message)}` : ''}`;
      default:
        return `${indent}${String(node.kind ?? '?').toUpperCase()}`;
    }
  });
  return `${lines.join('\n')}\n`;
}

// git diff --no-index exits 1 when the files differ; only other codes are errors.
function gitDiffNoIndex(cwd, a, b) {
  const result = spawnSync('git', ['diff', '--no-index', '--unified=3', '--', a, b], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new Error(`Could not run git diff (${result.error.message}).`);
  if (result.status !== 0 && result.status !== 1) throw new Error(`git diff --no-index failed:\n${result.stderr.trim()}`);
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

// Over a diff sequence diagram: nodes in all; nodes by diff mode (1 added,
// 2 removed, 3 changed); the roots of moved blocks (an id removed and added
// again, not counting nodes inside another moved block); labels on changed nodes.
export function diagramStats(diagram) {
  const stats = { total: 0, diff: 0, added: 0, removed: 0, changed: 0, moved: [], labels: new Set() };
  const removed = new Map(); // id -> parent id
  const added = new Set();
  const walk = (node, parentId) => {
    stats.total += 1;
    const id = node.stableProperties?.id ?? node.name ?? '';
    if (node.diffMode) {
      stats.diff += 1;
      if (node.diffMode === 1) { stats.added += 1; added.add(id); }
      else if (node.diffMode === 2) { stats.removed += 1; removed.set(id, parentId); }
      else stats.changed += 1;
      for (const label of node.labels ?? []) stats.labels.add(label);
    }
    for (const child of node.children ?? []) walk(child, id);
  };
  for (const root of diagram.rootActions ?? []) walk(root, '');
  const moved = [...removed.keys()].filter((id) => id && added.has(id));
  stats.moved = moved.filter((id) => !moved.includes(removed.get(id)));
  return stats;
}

// Over a unified diff of the two trees: changed lines, and how many of them are
// copies of a line that appears three or more times (a loop that ran a
// different number of times, which the compare ignores by design).
export function treeDiffStats(text) {
  const lines = text.split('\n').filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
  const counts = new Map();
  for (const line of lines) {
    const content = line.slice(1).trim();
    counts.set(content, (counts.get(content) ?? 0) + 1);
  }
  let repeated = 0;
  for (const count of counts.values()) if (count >= 3) repeated += count;
  return { lines: lines.length, repeated };
}

// ---------------------------------------------------------------------------
// Which view to read first
// ---------------------------------------------------------------------------

// In order; the first rule whose `when` holds decides. `d` is diagramStats,
// `t` is treeDiffStats or null when no tree diff was written.
export const RULES = [
  {
    read: 'diagram',
    when: (d, t) => t && t.lines === 0,
    why: () => 'the call trees read the same, so the change is in something the tree does not print',
  },
  {
    read: 'diagram',
    when: (d, t) => t && t.repeated >= t.lines / 2,
    why: (d, t) => `the tree diff is mostly repeated lines (${t.repeated} of ${t.lines}): a loop ran a different number of times, which the compare ignores; the diagram folds loops`,
  },
  {
    read: 'diagram',
    when: (d) => d.diff < 3,
    why: (d) => `${d.diff} node${d.diff === 1 ? '' : 's'} changed; small enough to read as is`,
  },
  {
    read: 'tree',
    when: (d) => d.moved.length > 0,
    why: (d) => `${d.moved.slice(0, 3).map((id) => id.split('/').pop()).join(', ')} removed and added again: a moved block, which the tree diff shows as a move`,
  },
  {
    read: 'tree',
    when: (d) => d.diff > 30 || d.diff > d.total / 4,
    why: (d) => `${d.diff} of ${d.total} nodes changed; plain text scans better at this size`,
  },
  {
    read: 'diagram',
    when: () => true,
    why: (d) => `${d.diff} of ${d.total} nodes changed; the tree diff is there if the diagram is unclear`,
  },
];

export function decideView(diagram, tree) {
  if (!diagram) {
    return tree && tree.lines > 0
      ? { read: 'tree', reason: 'no diff sequence diagram was written for this trace' }
      : { read: 'diagram', reason: 'no readable diff was written for this trace; read the change report' };
  }
  const rule = RULES.find((candidate) => candidate.when(diagram, tree));
  let { read } = rule;
  let reason = rule.why(diagram, tree);
  // Labels are only in the diagram; when the tree is preferred, both are needed.
  if (read === 'tree' && diagram.labels.size > 0) {
    read = 'both';
    reason += `; the changed nodes carry labels (${[...diagram.labels].join(', ')}), which only the diagram shows`;
  }
  return { read, reason };
}

function firstLine(text) {
  return String(text).split('\n')[0];
}
