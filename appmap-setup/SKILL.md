---
name: appmap-setup
description: Set up AppMap recording in a repository - confirm the AppMap tools are installed where the other skills expect them, get one unit test and one integration test recording, prune noisy classes from the recordings, and write the working record commands into gold_traces/manifest.yaml so every later session records the same way. Use when asked to set up, install, or configure AppMap recording for a project. Does not curate gold traces or run a review; see appmap-setup-review for that.
---

# Skill: AppMap Recording Setup

Get a repository recording AppMap data reliably, and write down the exact
commands so every later session can record without rediscovering them.

```
Phase 0  tools and environment
Phase 1  build and run the tests as-is
Phase 2  record ONE unit test              -> commit "config"
Phase 3  record ONE integration test
Phase 4  prune noise from the recordings   -> commit "exclusions"
Phase 5  write the record commands into gold_traces/manifest.yaml, smoke-test
                                           -> commit "commands"
```

This skill is the high-level workflow only. The how-to lives in the companion
skills: **appmap-record** (how to record, per language and build tool) and
**appmap-config** (`appmap.yml` and label syntax). It works on whatever commit is
checked out; it does not choose branches or revisions.

The setup leaves no separate document behind. Everything a later session needs
is in two files the tools read anyway: `appmap.yml` says what is recorded and
where recordings land, with a comment per exclusion saying why; and
`gold_traces/manifest.yaml` says how to record, in the `commands` block the
gold-traces engine executes. A hand-kept doc would be a third copy of the same
facts, and the copy nothing runs is the one that drifts.

Before starting, look for `appmap.yml` and `gold_traces/manifest.yaml`. If both
exist, the repo has been set up before: run
`node "${CLAUDE_SKILL_DIR}/../appmap-gold-traces/assets/manage.mjs" plan --dir gold_traces`
to see the record commands, and skip to whichever phase is still missing.

## Phase 0 — Tools and environment (do these in parallel, fail fast)

The AppMap tools must be at the location the other skills and the gold-traces
engine look in first:

```sh
~/.appmap/bin/appmap --version        # must be 3.201 or newer (needed for sanitize)
ls ~/.appmap/lib/java/appmap.jar      # Java projects only: the agent jar
```

If either is missing, install the AppMap extension for VS Code or JetBrains
and open the project once. The extension downloads both and keeps them
up to date. Do not install the CLI from npm as a substitute; nothing keeps
that copy current.

If you don't have access to an IDE, you can instead fetch https://raw.githubusercontent.com/getappmap/appmap-js/release-manifests/appmap-latest.json
then find the asset entry matching this machine's OS/arch (appmap-linux-x64, 
appmap-linux-arm64, appmap-macos-x64, appmap-macos-arm64, or appmap-win-x64.exe),
download its url, verify the download's sha256 against the entry's digest, 
chmod +x it, put it on PATH as appmap, and confirm with appmap --version.

Ruby, Python, and Node agents are project dependencies, added the way 
**appmap-record** describes.

Then confirm the project's build toolchain works with the versions the project
expects, and the database, if the build or tests need one.

## Phase 1 — Build and test as-is

Confirm the project builds and its tests can run before touching any config.
Note the exact commands; they become the record commands later.

## Phase 2 — Configure recording (commit "config")

Follow **appmap-record** for the language and build tool. In a multi-module
project, share one config and one output directory across modules (see the
multi-module note in appmap-record, `languages/java.md`). Add the output directory (`tmp/appmap/`)
and `.appmap/` to `.gitignore`.

Record ONE unit test, then verify the `.appmap.json`: correct version and
metadata, call events with parameters. Commit `appmap.yml`, any build or test
hooks, and the `.gitignore` entries.

## Phase 3 — Integration tests

Find the integration or system suites (separate module, profile, or test
config). Get one class recording green. Often no new AppMap config is needed.
Verify SQL events appear if the tests hit a database. Keep the exact working
command for each suite; they go into the manifest in the last phase.

Anything project-specific you learn on the way belongs next to the thing it is
about, as a comment: a listener that must be imported for SQL to be captured
goes in the test bootstrap that imports it; a process that must never be
recorded (an endless loop that never flushes) goes in `appmap.yml`.

## Phase 4 — Prune noise (commit "exclusions")

Follow **appmap-config**, "Cutting noise": measure the biggest recording with
`appmap stats`, exclude the generated code and the small helpers it shows, and
re-record. Confirm the tests still pass and the recordings are well under
1 MB each. Give every exclusion a one-line comment saying why. Commit the
`appmap.yml` changes.

## Phase 5 — Write the record commands into the manifest (commit "commands")

Seed `gold_traces/manifest.yaml` from the gold-traces template and fill in only
its `commands` block; delete the template's example entry and leave the bare
`entries:` key with nothing under it (the engine's minimal YAML parser does not
read `[]`). Curating entries is the **appmap-gold-traces** skill's job, and it
starts from this file.

```sh
mkdir -p gold_traces/baseline/appmaps
cp "${CLAUDE_SKILL_DIR}/../appmap-gold-traces/assets/manifest.template.yaml" gold_traces/manifest.yaml
```

Put `gold_traces/` in the directory the record command runs from: the package
root in a single-package repo, the package directory in a monorepo (one
manifest per recorded package). The engine derives every path from that
placement; see the gold-traces skill, "Layout".

In `commands`, write what Phases 1 to 3 found, the way the engine wants it:

- `framework`: the test framework name (`pytest`, `rspec`, `jest`, `maven`, ...).
- `runner`: the launcher that runs it in this repo (virtualenv path, wrapper
  script, profile, workspace flag), only if the engine's detected default is
  not right. `plan` shows what the engine would pick without it.
- `args`: flags that go after the test selectors.
- `record_env`: any environment variables the command needs.
- For a runner the engine does not know, a full `record` template with the
  `{test_file}` and `{test_name}` placeholders instead of `framework`.

Then confirm and smoke-test:

```sh
node "${CLAUDE_SKILL_DIR}/../appmap-gold-traces/assets/manage.mjs" plan --dir gold_traces
```

`plan` prints the exact record command. Run it once by hand with a real test
substituted, and confirm a recording appears under `appmap_dir`. If the repo has
a `CLAUDE.md`, add one line pointing at the manifest and the gold-traces skill,
so a session that has not loaded the skill still knows where recording is
configured. Commit the manifest and that line together.

## What this skill leaves behind

Three commits, in this order. Other workflows (for example
**appmap-setup-review**) cherry-pick them onto another revision, so keep them
separate and keep each one self-contained:

| Commit | Contents |
| --- | --- |
| "config" | `appmap.yml`, build or test hooks, `.gitignore` entries |
| "exclusions" | the `appmap.yml` exclusions, each with its reason |
| "commands" | `gold_traces/manifest.yaml` with `commands` filled and a bare `entries:` key, plus the optional `CLAUDE.md` pointer line |
