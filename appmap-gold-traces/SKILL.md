---
name: appmap-gold-traces
description: Maintain a committed baseline of curated AppMap recordings (gold traces). Bootstrap gold_traces/manifest.yaml, choose suitable tests, record them with the bundled engine, check size and run-to-run stability, and bless new baselines when code legitimately changes. Use when asked to create, update, check, or bless gold traces, or when a review needs a baseline. To diff and review two revisions, see appmap-review.
---

# Skill: Maintain AppMap Gold Traces

Maintain a curated set of AppMap recordings — **gold traces** — committed in the
repository as a behavioral baseline. A gold trace is a behavioral *snapshot*: the
test stays green, but the recording captures the shape of the path it exercised, so
a later revision can be diffed against it to catch *unintended* behavior change.

This skill owns the **data lifecycle**: curating which tests are gold, recording
them, keeping them lean and deterministic, and **blessing** new baselines as the
code legitimately evolves. To actually *diff and review* one revision against
another, see **appmap-review** — that skill reads these gold traces from git
history, compares them, and writes the interpreted review.

## When to use

- **Bootstrap** a gold-traces baseline in a project that doesn't have one.
- **Maintain** the baseline during a release: re-record, review (with the
  **appmap-review** skill), bless what the review confirms, and add a trace when
  the release touched a path no trace runs.
- Keep traces lean and deterministic so the comparison stays trustworthy.

This is the *baseline-maintenance* layer over AppMap. To make recordings, see
**appmap-record**; to **review** a change, see **appmap-review**.

## How it works

The model is **curate → record → bless**, with the diff-and-review delegated to
**appmap-review**:

1. A manifest (`gold_traces/manifest.yaml`) names a curated set of tests and the
   recordings they produce.
2. The raw baseline AppMaps are committed under `baseline/appmaps/` — the source of
   truth: deliberately blessed, sanitized, small (KBs). Everything derived
   (sequence diagrams, archives, the review) is produced on demand and not committed.
3. To decide what to bless on a release, re-record the gold tests and **review the
   change with appmap-review** (whether a change is intended, a regression, or a side
   effect is its job). The engine's `update --dry-run` reports *which* traces changed;
   bless the ones the review confirms (the engine copies the fresh recordings over the
   changed baselines and leaves the rest byte-identical).

Three properties keep the baseline trustworthy — they are this skill's real job:

**Curate for coverage.** A gold trace only guards a code path it actually executes.
A conditional gate (`if game.is_private: <check>`) is invisible to a trace that never
drives that branch. Curate the manifest so some entry exercises each guarded branch —
especially the *negative* branch of a security gate; a single happy-path trace is not
enough.

**Label what should be interpreted.** appmap-review reasons about a change from:

1. Code object names
2. AppMap **labels** on the functions involved (`security.*`, `io.*`, …).

The label names and how to apply them per language are in **appmap-config**.

**Record consistently.** Every gold trace must be recorded with the *same* capture
config — e.g. SQL capture on, labels applied. If the config changes, re-record the
whole set; otherwise a later review is swamped by instrumentation drift instead of
behavior.

## What makes a trace suitable

A good gold trace is the **smallest deterministic recording that exercises one
release-critical subsystem once**. Curate for *distinct* coverage: prefer one
representative trace per subsystem over many near-identical ones.

**Reuse an existing test before synthesizing one.** A repo may already have a
test that exercises a feature end-to-end — point the manifest at that. Before
adding an entry, search the suite for coverage of the command/handler you want to
guard. Synthesize a fresh test only when no existing one covers the path — and then 
it's a new, normal, test that the project will benefit from.

Rule a candidate **out** before adding it to the manifest:

- **It records little or nothing.** Some tests assert over in-memory data without driving the
  instrumented call graph. Confirm that a test actually records a useful amount of data before 
  committing it. Granular unit tests aren't a good candidate for gold traces.
- **Its size is repetition, not structure.** A loop- or large-fixture-driven test can
  balloon to MBs because the *same* helper function invocations repeat per iteration. Distinguish the
  two size modes before reacting: many big *parameter values* → the engine's `sanitize`
  step already replaces these with short tokens, so they add little committed weight
  (values aren't behavioral; see *Keeping traces lean*); many *repeated events* → pick a
  smaller fixture, or update *appmap.yml* to `exclude` the repeated function (especially if
  it's trivial in nature, and/or well-covered by a unit test).
- **It is nondeterministic.** Unseeded RNG, wall-clock branching, or run-to-run ordering
  drift makes the trace bless on every compare and trains you to ignore real changes.
  See *Determinism*. Verify a fresh candidate with `check --record` before trusting it.
  Consider making an unstable test stable by fixing the random behavior (e.g. changing
  the test setup to use a fixed seed).
- **It duplicates coverage.** Several traces walking the same path don't strengthen the
  baseline; they multiply the review and bless cost. Keep one. This is measured,
  not judged: `discover` prints what a candidate's recording runs that no
  committed trace runs, and `check` warns about an entry whose recording adds
  nothing to the entries before it.
- **It is a unit test.** A recording that stays inside one project class and
  never reaches SQL or HTTP shows a function, not a subsystem. `check` and
  `discover` warn about this shape.

**This suitability check is mandatory, not user-prompted.** After adding or changing
an entry, run:

```sh
node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" check --dir gold_traces --record \
  --only <test_name>
```

`check --record` records twice, verifies behavioral-digest stability, and reports
bytes, events, project code objects, labels, SQL/HTTP counts, and dominant
repeated calls. It fails on empty traces. Large, repetitive, or unit-test-shaped
traces produce warnings that must be resolved or explicitly judged acceptable
before blessing.
Do this automatically whenever curating a trace; do not wait for the user to ask
whether trace sizes and shapes are appropriate.

## Finding the test for a code path

This is the hard part of curation. An integration test names the entry point it
drives (a route, a command, a job), not the function four calls below it. So a
search for a code object's own name finds its unit tests and misses the test
that shows the subsystem working. The gap between a code object and its best
test is a call chain, and something has to walk it.

Run these in order, cheapest first, and stop at the first one that answers:

```
1. covers --name <code object>                engine, seconds, exact
     hit  -> a gold trace already runs it. Nothing to add.

2. covers --name <the class that calls it>    engine, seconds, exact
     hit  -> that entry's test file is the right neighbourhood. Its
             sibling tests are the first candidates to discover.

3. walk the call chain upward                 subagent, minutes, a guess
     X <- Service#addFlow <- FlowsController#create <- POST /flows
     at each hop, search test source for that name; keep hits in the
     integration-test directories; note what input reaches X.

4. record one test directory, then look       engine + recorder, exact, slow
     covers --fresh --name <code object>
     for a small suite, or when step 3 finds nothing convincing.
```

**Steps 1, 2, and 4 are one command.** `covers` reads the committed baselines
(or, with `--fresh`, the recordings under `appmap_dir`) and prints each one
that runs a code object whose id contains the name, with the ids spelled as
the recordings spell them:

```sh
node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" covers --dir gold_traces --name <ClassOrMethod>
```

A miss is not proof of a gap: try a shorter name, the class alone, before
concluding that nothing runs it. For step 4, record the test directory with
the project's normal test command (see **appmap-record**), then run `covers
--fresh`; it prints each matching recording with its test name and source
location, which is what `discover` needs next.

**Step 3 is a subagent.** Launch one agent with the prompt in
`assets/find-candidates.md`, filling in: the code object with its file and
line; the integration-test directories (the directories of the manifest's
existing `test_file` values, or the framework's usual layout when the manifest
is empty); a hop limit of 4; and a result limit of 3. It returns a table with
one row per candidate: test file, test name, layer (integration or unit), the
call chain it found, and what input makes that chain reach the code object. It
must not record or edit anything. Its freedom is in the search; its output is
fixed, and the engine measures every candidate before one is chosen.

**Then measure every candidate.** Each step is a command with a yes/no result:

```
for each candidate:
    discover --test-file <F> --test-name <T>
        "project code objects" line contains the code object?
            no  -> the chain was wrong for this input. Drop it.
        "reads like a unit test" warning?
            yes -> drop it
    paste the printed entry into manifest.yaml
    check --record --only <T>
        FAIL (empty, unstable) -> drop it, remove the entry
pick: fewest events among the ones left, then the one that adds the
      most beyond the committed set (discover prints both)
update --only <T>
```

Fewest events comes first because a gold trace is reviewed on every future
revision, so a large trace costs more every time, while the extra helper a
bigger test happens to run is worth little. When the code object is a guard or
a refusal, prefer the candidate that drives the refused branch: it is the
behavior most worth guarding and usually the smallest recording.

**When the only candidate is unsuitable**, the check output says why, and each
reason has a first fix. Some fixes help every trace; try those first.

| What `check` or `discover` said | First try | Why first |
| --- | --- | --- |
| Dominated by one repeated helper | Add that function to `exclude` in appmap.yml | Fixes every recording in the project |
| Unstable across two runs | Fix the test setup: a fixed seed, a fixed clock | Usually one line, and the project gets a better test |
| Too large from a big fixture | A smaller test among the candidates, or a focused new one | The focused test is a normal test the project benefits from |
| Reads like a unit test, or records nothing | A focused new test that drives the entry point | The existing one never leaves one class |

If none of these is practical, the path stays uncovered, and the review's
coverage matrix says so with the reason. That is an honest gap, not a failure
of the process.

**Growing the set.** The gold set should grow by guarding more, not by
repeating what it guards. One entry per subsystem, extended by the code it
runs, beats forty near-identical ones. Add an entry only when `discover` shows
the recording runs something no committed baseline runs; `check` warns about an
entry whose recording adds nothing to the entries before it. One kind of entry
is worth keeping despite that warning: a negative-branch test (a refusal, a
guard, a fallback) runs the same functions as its happy-path twin and differs
only inside them, so the comparison cannot tell them apart. The warning names
the closest entry; if this one drives a branch that entry does not, keep it and
say so in its `summary`.

## Sanitization

- **Values are not behavior — and the engine strips them.** On bless the engine runs
  **`appmap sanitize`** (needs `@appland/appmap` ≥ 3.201.0) on the fresh recording,
  replacing every captured parameter/return/message value with a short,
  equality-preserving token (`<v1>`, `<uuid:v3>`). So the committed baseline is
  structurally incapable of carrying a secret, and it's also smaller. The engine sanitizes 
  the recordings **before** computing its bless digest and compares that against the (also sanitized) 
  committed baseline. Sanitization is performed by the gold trace helper functions and CLI commands;
  you don't need to add it explicitly.

## Layout

The engine and templates ship with this skill; the *data* lives in the target
project and is committed there.

```
<this skill's directory>/assets/
  manage.mjs                          engine (config-driven, zero-install Node)
  manage.test.mjs                     engine tests (node --test, no deps)
  frameworks.mjs                      test-framework registry: per-framework test selectors and batching
  frameworks.test.mjs                 registry tests
  manifest.template.yaml              manifest template (commands + entries)
  find-candidates.md                  subagent prompt: find the test that runs a code path
  vendor/js-yaml.mjs                  the YAML reader (vendored, MIT; see vendor/README.md)

<project>/gold_traces/                 created at bootstrap, committed in the project
  manifest.yaml                       the manifest: record commands + the curated entries
  baseline/appmaps/**.appmap.json     committed baselines
<project>/.appmap/gold-traces/         derived sequence exports (regenerated, gitignored)
```

The engine has no npm dependencies — it runs straight from Node, with its YAML
reader vendored under `assets/vendor/`. Invoke it from the **project root**:

```sh
node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" <command> --dir gold_traces [options]
```

(The path before `/assets/` is this skill's directory, the one holding this
SKILL.md. Claude Code fills it in when it loads the skill; any other runner should
substitute the skill's absolute path. `--dir` defaults to `gold_traces`.)


## Monorepos

Keep a `gold_traces/` directory for each *appmap.yml* file in the project.

It's not your role to create or maintain *appmap.yml* files as part of gold traces maintenance.
During initial setup, if the project doesn't contain any *appmap.yml* files, then this
configuration needs to be created in collaboration with the user. How many
*appmap.yml* files a project needs (one per language, one or more per monorepo) is
covered in **appmap-config**, "Layout".

A `gold_traces/` per package (`packages/<name>/gold_traces/`)
keeps traces versioned and reviewed alongside the code they guard, and lets packages be
recorded and blessed independently (each `--dir` is its own baseline). A single repo-root
`gold_traces/` is fine too when the repo is effectively one project. This is an ownership
choice, not a technical one.

You don't configure paths: the engine runs the record/appmap commands from the **gold_traces parent directory** 
and reads recordings from wherever the **nearest-ancestor `appmap.yml`** collects them (its directory + its
`appmap_dir`). So for `packages/<name>/gold_traces`, commands run in `packages/<name>`
and recordings come from the nearest ancestor `appmap.yml`:

```sh
node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" update --dir packages/<name>/gold_traces --record
```

## Bootstrap (first time in a project)

When `gold_traces/` does not yet exist:

1. **Create the directory** and seed it from the template:
   ```sh
   mkdir -p gold_traces/baseline/appmaps
   cp "${CLAUDE_SKILL_DIR}/assets/manifest.template.yaml"  gold_traces/manifest.yaml
   ```
   The engine's derived work lands in `.appmap/gold-traces` (AppMap's regenerable
   working dir). Ensure `.appmap/` is gitignored — most AppMap projects already ignore
   it; add `.appmap/` to the repo `.gitignore` if not.

2. **Fill in the `commands`.** Name the test framework and, if the default
   launcher is not right for this project, the launcher:
   ```yaml
   commands:
     framework: pytest                          # pytest | unittest | rspec | minitest | rails-test |
                                                # jest | vitest | mocha | maven | gradle
     runner: .venv/bin/appmap-python pytest     # optional: replaces the default launcher
     args: -q                                   # optional: flags after the test selectors
   ```
   The engine knows how each framework names one test and how it names several,
   so it records the whole gold set in as few runs as the framework allows. `node
   "${CLAUDE_SKILL_DIR}/assets/manage.mjs" --help` lists the frameworks, each one's default
   launcher, and what `test_name` must be for it. Find the launcher by inspecting
   the project: lean on the `appmap-record` skill to make a sample recording, and
   check the README, LLM instruction files, `package.json` scripts, `Makefile`,
   `pytest.ini`/`tox.ini`, `Gemfile`/`Rakefile`, and CI workflows for the wrapper
   script, virtualenv path, profile, or workspace flag the project needs. Then
   run `plan --dir gold_traces` to see the exact commands before recording
   anything. Once written, the `commands` block is the source of truth; never
   re-derive it.

   For a runner the engine does not know, give a full shell template as
   `commands.record` instead of `framework`. It runs once per test and MUST
   include the `{test_file}` and `{test_name}` tokens so it records one
   **specific** test rather than the whole suite.

   Either way the command cannot choose where the recording file lands — the
   recorder decides that, under `appmap_dir`. Don't add output-path flags;
   record, then find the file with `discover` (step 3). Paths are derived, not
   configured (see **Config reference**).

3. **Curate the entries.** Pick one subsystem at a time and find the test that
   shows it working end to end (**Finding the test for a code path**; at
   bootstrap there are no baselines yet, so start at its step 3 or, for a small
   suite, step 4). Then let the engine confirm each choice:
   ```sh
   node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" discover --dir gold_traces \
     --test-file <test_file> --test-name <test_name>
   ```
   `discover` records the one test and prints the recording path(s) it produced,
   relative to `appmap_dir` — exactly the `appmap_path` value — plus a paste-ready
   entry stub, the recording's shape, and what it runs that the entries already
   added do not. Add the entry only when that last line is not empty. Get every
   `appmap_path` from `discover`; do **not** guess it from naming conventions or
   hunt for recordings with `ls`/`find`. Use `feature` to group entries by
   subsystem.

4. **Check suitability and stability.** This is required for every new entry:
   ```sh
   node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" check --dir gold_traces --record
   ```
   Resolve failures and investigate warnings. Reuse a better existing test before
   synthesizing a focused test; synthesize only when no existing test captures the
   required path.

5. **Seed the baseline.** Reuse the second checked recording and copy it into the
   baseline:
   ```sh
   node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" update --dir gold_traces
   ```
   `update` seeds `baseline/appmaps/`
   (every entry is new on the first run, so all are seeded). To seed only specific
   entries, add `--only <test_name>`, repeatable. `update` also runs the structural
   suitability gate before writing.

6. **Mark baselines binary** so Git doesn't produce noisy line diffs. Add to the
   repo-root `.gitattributes`:
   ```
   gold_traces/baseline/appmaps/**/*.appmap.json binary
   ```

7. **Commit** the new baseline as its own change:
   ```sh
   git add gold_traces .gitattributes
   git commit -m "chore(gold-traces): establish baseline"
   ```

## Maintain (each release)

Refresh the baseline as part of the release so it tracks what shipped. **Skip only
if the release touched no traceable application code.**

**First, upgrade an old manifest.** If `manifest.yaml` says `schema_version: 1`
or has no `schema_version` line, every engine command prints a note. Upgrade it
before anything else; it is a small edit:

1. Set `schema_version: 2` at the top.
2. Replace `commands.record` with `commands.framework`, so the gold set records
   in batches. The old template names the runner: `pytest`, `rspec`, `jest`,
   `mvn`, and so on map to the framework names in **Config reference**. The
   text before the test selectors was the launcher; keep it as `runner:` only
   if it is not the default or the detected one (run `plan` to see what the
   engine picks without it), and keep any flags after the selectors as `args:`.
   A `.venv/bin/appmap-python pytest` launcher should be dropped in favor of the
   detected form, which runs pytest inside the same venv. If the runner is not
   one the engine knows, keep `commands.record`; it still works, one run per
   test.
3. Delete any `expect` and `expect_labels` lines. The engine no longer reads
   them and prints a note while they remain.
4. Run `plan` and confirm the commands look right, then commit the migrated
   manifest with the refreshed baseline.

**Then the release flow.** Every step is a command with a yes/no result, except
the two marked as a decision.

```
1. check --record          stable? not empty? not noisy?      FAIL -> fix, stop
2. update --dry-run        which baselines would change?      none -> step 5
3. appmap-review           does the source diff explain
                           each changed trace?                 <- decision
4. update --only <test>    bless the ones the review approved
5. covers --name <class>   for each changed application class:
                           does a gold trace run it?
                           miss -> Finding the test for a code path
                                   -> discover, check, update     <- decision
6. git commit
```

1. **Record the gold set and check it.** Two recordings, compared for
   stability, plus the size and shape report:
   ```sh
   node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" check --dir gold_traces --record
   ```
   A FAIL (empty trace, or drift between the two runs with no code change) is a
   trace problem, not a code problem: fix it first (**Determinism**, **Keeping
   traces lean**). Do not carry a failing entry into the next step.

2. **See which baselines would change.** Reuse the fresh recordings in a dry run:
   ```sh
   node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" update --dir gold_traces --dry-run
   ```
   It marks each trace `bless` (behavior changed), `seed` (new entry), or counts it
   `unchanged`. The digest excludes timing and value jitter, so a `bless` is a real
   change. If nothing would be blessed, skip to step 5.

3. **Review the changed traces.** Deciding whether a changed trace is the
   feature, a regression, or an unintended side effect is **appmap-review**'s
   job. Run it with the last blessed commit as the baseline and `--fresh` as the
   head (its "Head from the working tree"): the review then reads the fresh,
   already-sanitized recordings under `appmap_dir`, which is exactly the set
   `update` would bless. The last blessed commit:
   ```sh
   git log -1 --format=%h -- gold_traces/baseline/appmaps/
   ```

4. **Bless what the review approved.** Drop `--dry-run`, and do not pass
   `--record` (reuse step 1's recordings). Scope it with `--only` when the
   review approved some entries and not others; without `--only` it blesses
   every changed trace:
   ```sh
   node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" update --dir gold_traces [--only <approved_test>]
   ```
   A changed trace the review did not approve stays unblessed and is a finding.

5. **Add a trace for new code that no trace runs.** The compare already
   answered most of this: a trace that changed runs the code that changed. For
   the application classes the release touched whose traces did not change,
   ask the engine:
   ```sh
   node "${CLAUDE_SKILL_DIR}/assets/manage.mjs" covers --dir gold_traces --name <ClassName>
   ```
   A hit means the code is covered and the change did not alter the call
   shape. A miss (after trying the class name alone) means no gold trace runs
   it: follow **Finding the test for a code path**, then `discover`, paste the
   entry, `check --record --only <test>`, and `update --only <test>`.

   The engine reports coverage by function, not by branch. A release that
   adds a branch inside a covered function shows as a hit in `covers` and as
   a changed trace in the compare, and that is enough: branch coverage is the
   test suite's job, not the gold set's. The one exception is a security
   gate, an authorization check or a disclosure decision. A dropped check is
   invisible to a happy-path trace, so a new gate gets a trace that drives its
   refused branch, found the same way as any other test. Nothing else earns an
   entry just for being a new branch.

6. **Commit**, staging only what genuinely changed (manifest edits, newly-blessed
   baselines):
   ```sh
   git add gold_traces <touched source files>
   git commit -m "chore(gold-traces): refresh baseline for <version>"
   ```
## Config reference

`gold_traces/manifest.yaml` — one file: recording `commands` + the curated
`entries`. Paths are **not** configured — they are derived.

Schema version 2 describes recording with `commands.framework`. Schema version
1, or a manifest with no `schema_version` line, remains readable, and every
command prints a note asking for the upgrade. The upgrade is a hand edit; see
the start of **Maintain**. What a trace covers is read from its recording, so
an entry declares nothing about it; the `expect` and `expect_labels` fields of
older manifests are ignored, and the engine prints a note asking for them to be
deleted.

| Field | Meaning |
|---|---|
| `commands.framework` | The test framework: `pytest`, `unittest`, `rspec`, `minitest`, `rails-test`, `jest`, `vitest`, `mocha`, `maven`, or `gradle`. The engine builds the record commands from its registry (`assets/frameworks.mjs`) and batches the gold set into as few runs as the framework allows. Preferred whenever the project's runner is one of these. Exclusive with `commands.record`. |
| `commands.runner` *(optional)* | Replaces the launcher, the part of the command before the test selectors (for example `npx appmap-node yarn jest`, `./mvnw -Pintegration test`). Unset, the engine detects it per project: a Python `.venv`/`venv` with `appmap-python` installed (both tools named by path, because `appmap-python` finds its command through `PATH` and does not add the venv to it), else a uv, Poetry, or Pipenv lock file; a Maven or Gradle wrapper script. `plan` shows the result. |
| `commands.args` *(optional)* | Flags appended after the test selectors (for example `-q`). |
| `commands.batch_size` *(optional)* | Most tests that may share one run. Unset means as many as the framework and the shell allow. Set it to keep runs small on purpose, for example to isolate a flaky test. Command length is limited separately and automatically: the engine measures this machine's shell limit (`ARG_MAX` minus the environment on POSIX, the 8 KB line on Windows) and splits any run that would exceed it. |
| `commands.record` | For a runner the registry does not know: a shell template to record ONE test, run from the gold_traces parent dir with `{test_file}` and `{test_name}` substituted, once per entry. Exclusive with `commands.framework`. |
| `commands.record_env` | Extra env vars for the record command (e.g. a recorder enable flag). Merged over the framework's own defaults, such as `APPMAP=true` for rspec and minitest. |
| `commands.appmap_cli` | AppMap CLI the engine runs — exports the bless-gating sequence diagram **and** sanitizes each recording before it is committed (`sanitize` needs **`@appland/appmap` ≥ 3.201.0**). **Leave unset**: it auto-discovers `~/.appmap/bin/appmap` (where the IDE extensions install it), else `appmap` on `PATH`. A committed value is machine-specific config in a shared file (breaks on other machines/platforms); set it only for an unusual CLI location or a custom-compiled CLI (appmap-js itself sets `node built/cli.js`). |
| `expand` *(optional)* | Package code-object ids to render at function granularity (`--expand`). Default empty — package granularity already catches function changes. |
| `allow_values` *(optional)* | Values `appmap sanitize` keeps verbatim in blessed baselines (the engine passes them via `--allow-file`), exact whole-value match. Curate small public vocabularies only (enum state/role names); never anything that could identify a person or authenticate a request. |
| `entries` | The curated list. Each: `feature`, `test_file`, `test_name`, `appmap_path` (get it from `discover`), `summary`. |

Paths are **derived**: commands run from the gold_traces parent directory, and
recordings are read from the nearest-ancestor `appmap.yml` (its directory + its
`appmap_dir`). Place `gold_traces/` inside the directory you want commands to run from,
within an AppMap project.

The manifest and `appmap.yml` are read as standard YAML by a vendored copy of
js-yaml (`assets/vendor/`), so comments on the same line as a value, flow
lists such as `entries: []`, and anchors all work. Quote a value that contains
`: ` or starts with a special character, as in any YAML file.

## Keeping traces lean

**A gold trace demonstrates behavior; it should be KBs, not MBs.** A trace
balloons when a high-frequency pure leaf is instrumented (e.g. a geometry helper
called thousands of times in one request → a multi-MB blob that is pure noise).
Two levers, preferred order:

1. **Exclude a well-tested, high-call pure leaf** in the project's `appmap.yml`.
   A package-local path exclusion is relative to that package's `path`:
   ```yaml
   packages:
     - path: my_pkg
       exclude:
        - geometry.distance
   ```
   Only exclude leaves whose behavior is already unit-tested and whose *callers*
   still appear in the trace. Never exclude a package whose call structure the
   gold set exists to guard. Changing `exclude` shrinks *every* affected baseline — the
   one case where re-blessing the whole set at once is correct (confirm each
   diff is only the leaf removal, then bless all). The `exclude` syntax for each
   language, and the YAML quoting rule for method ids that contain `#`, are in
   **appmap-config**, "Cutting noise".
2. **Prefer a minimal fixture** for a new entry — build the minimal object graph
   the behavior needs (tens of events) instead of a heavyweight end-to-end setup.

## Determinism

The comparison only works if traces are reproducible. A nondeterministic trace
(unseeded RNG, wall-clock branching, ordering that varies run to run) drifts on
every compare and trains you to ignore real changes. Seed RNG in the test
(e.g. pass an explicit `seed=` rather than calling an unseeded resolver), pin any
time-dependent input, and stabilize collection ordering. If a fresh entry drifts
with no code change, fix the test before blessing it.

## Engine commands

The engine has five commands — `check` (shape, coverage, and stability), `update`
(record + digest-gated bless), `discover` (find a new entry's `appmap_path`),
`covers` (which baseline runs a piece of code), and `plan` (show the record
commands without running them). Diffing and reviewing a change is the
**appmap-review** skill's job. To let a person browse a set of recordings, run
`appmap index --appmap-dir DIR` then `appmap query ui --appmap-dir DIR --port N`
(see **Show the recordings to the reader** in appmap-review); `appmap open` is
the single-map IDE viewer, not that.

```
update    [--dir DIR] [--only TEST] [--record] [--dry-run]
check     [--dir DIR] [--only TEST] [--record]
discover  [--dir DIR] --test-file FILE --test-name NAME
covers    [--dir DIR] --name NAME [--fresh]
plan      [--dir DIR] [--only TEST]
```

Recording, in every command that records, follows `commands.framework`: the
selected entries are grouped into as few runner invocations as the framework's
command line allows (one `pytest` run for the whole set; one `jest` run with the
files and a name filter; one `mvn` run with a `-Dtest=` list; one run per file
for minitest). Each agent still writes one recording per test, so entries keep
their own `appmap_path`. A run that would exceed this machine's command-line
limit is split in halves until every piece fits, so a large gold set works on
Windows too, with more runs there than on Linux or macOS. `commands.batch_size`
caps the count per run on top of that. With `commands.record` instead, each
entry is recorded in its own run. Frameworks and their default launchers:
`manage.mjs --help`.

`check`:

- Without `--record`, checks committed baselines.
- With `--record`, records twice and fails on behavioral drift.
- Reports size and shape without relying on `jq`, `du`, or other optional shell
  tools.
- Fails on zero-event/no-call traces.
- Warns when an entry's recording covers nothing (code objects, labels, SQL
  tables, HTTP routes) the earlier recordings do not, and when a recording
  stays inside one project class with no SQL or HTTP, the shape of a unit test.
- Warns at 500 KiB, 1,500 events, or when one call repeats at least 100 times and
  accounts for at least 25% of calls.

`update`:

- Re-blesses each baseline whose behavior changed (copies the fresh recording over
  it) and **seeds** a baseline for any entry that lacks one. A trace whose behavioral
  digest matches its baseline is left **byte-identical** — no git churn.
- `--record` re-records the selected tests first (needs `commands.framework` or
  `commands.record`).
- `--dry-run` reports what would be blessed/seeded without writing.
- `--only TEST` (repeatable) limits the run to named entries.

`discover`:

- Records the one test through the configured framework or template and reports
  every appmap file the run produced — paths relative to `appmap_dir`, i.e. the
  entry's `appmap_path` — plus a paste-ready entry stub. This is **the** way to
  determine an `appmap_path`; never derive one by hand.
- Prints the same size/shape assessment for every candidate so empty, noisy, or
  unit-test-shaped recordings are visible before they enter the manifest.
- Compares each candidate with the committed baselines and prints what it adds
  (code objects, labels, SQL tables, HTTP routes) and the closest existing entry
  with its overlap. It prints the facts; whether the additions are worth an
  entry is the reader's call (**Finding the test for a code path**).

`covers`:

- Lists the committed baselines that run a code object whose id contains
  `--name` (part of a class or method name), with the matching ids spelled as
  the recordings spell them. A miss says how many baselines were searched and
  suggests a shorter name, so a misspelling is not mistaken for a gap.
- With `--fresh`, searches the recordings under `appmap_dir` instead, and
  prints each match with its test name and source location from the recording's
  metadata. Use it after recording a test directory to find the tests that run
  a code path.
- Reads files only; it never records and needs no shell tools.

`plan`:

- Prints the record command(s) the engine would run for the selected entries,
  and which entries each run covers. Use it after filling in `commands` to
  confirm the launcher and the test selectors before recording, and whenever a
  recording run fails, to see the exact command to reproduce by hand.
