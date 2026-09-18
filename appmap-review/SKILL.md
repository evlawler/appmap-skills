---
name: appmap-review
description: Review the runtime-behavior change between two revisions using the committed gold traces. Archives and compares each side with the AppMap CLI, then interprets the result into a findings-first report covering unintended side effects, missing security checks, SQL and HTTP risks, and coverage gaps. Use when asked to review a branch, PR, or release for behavioral change, or to decide which changed gold traces to bless. Needs gold traces maintained by appmap-gold-traces.
---

# Skill: AppMap Behavioral Review

Review the **runtime-behavior change** between two revisions and write an
interpreted, actionable code review. It works from **gold traces** — a curated set
of AppMap recordings committed in the repository (maintained by the
**appmap-gold-traces** skill) — so it catches the regressions that still pass the
test suite: a dropped authorization guard, a new query inside a loop, a
security-sensitive function that changed but gained no check.

A normal code review reads the diff. This review reads what the code *did at
runtime* on both revisions and reports what **changed in behavior** — grounded in
the AppMaps, not just the source.

Its sharpest use is finding **unintended side effects**: behavior that changed in
code the fix or feature didn't mean to touch. A diff review can't see these — an
unintended change is either invisible in the diff (an emergent consequence of a
shared helper, a changed default, an import) or hidden in it as something innocuous.
The behavioral diff is *intent-independent*: it shows what actually ran, which you
reconcile against what the change *meant* to do — and the unexplained remainder is
the side effect. Catching that residue is this skill's reason to exist alongside a
diff review.

## When to use

- Review a branch or PR for behavioral change and security risk before merge.
- Given two revisions (or one baseline and the current HEAD), produce the review.
- Investigate how a release changed server behavior versus a prior revision.

## Arguments

```
appmap-review <baseline-rev> [<head-rev>]
```

- **One revision** — it is the **baseline**; `head` defaults to the current `HEAD`.
- **Two revisions** — explicit `baseline` then `head`.

A revision is any git ref (SHA, branch, tag). The head may also be the **working
tree**, for a review before anything is committed: the recordings the gold-traces
engine just made, or baselines blessed but not yet committed. See **Head from the
working tree** below; the baseline always comes from git.

## How it works

The pipeline turns two revisions into one interpreted review:

1. **Compare** the two revisions' gold traces with the bundled helper,
   `assets/review.mjs`. It reads each revision's gold traces from git, builds an
   archive of each side with `appmap archive` (which indexes them and bundles the
   **sequence diagrams (with labels), OpenAPI, scanner findings, and class map**),
   and runs `appmap compare`. The result is the structural change report:
   new/removed/changed traces, SQL diff, OpenAPI diff, per-trace sequence-diagram
   diffs. The changed-vs-unchanged decision is made by a digest that **excludes
   volatile data** (elapsed time, object ids, parameter/return values), so timing
   jitter and unstable test data never register — a `changed` entry is real.
2. **Interpret** the compare output + the source diff into findings, following the
   **review recipe** below.
3. **Render** the scannable report.

## Compare the two revisions

Run the helper from the project root, the directory that holds `gold_traces/`:

```sh
node "${CLAUDE_SKILL_DIR}/assets/review.mjs" compare --base <baseline-rev> [--head <head-rev>]
```

`--head` defaults to `HEAD`. The helper needs git, Node, and the AppMap CLI
(`@appland/appmap` ≥ 3.200.0), and no shell tools, so it runs the same on macOS,
Linux, and Windows. It finds the CLI the way the gold-traces engine does:
`commands.appmap_cli` in the manifest, else `~/.appmap/bin/appmap`, else
`appmap` on `PATH`. In a monorepo, pass `--dir packages/<name>/gold_traces`.

It prints a short summary and where the results are:

```
Base: main = 0070766 feat(routing): cancel a routed fleet's onward legs (48 gold traces)
Head: HEAD = 7e08cc3 chore(gold-traces): re-bless multi-hop relay (50 gold traces)

Traces: 1 changed, 2 new, 0 removed.
  changed  pytest/test_multi_hop_routing  (diff/pytest/test_multi_hop_routing.diff.sequence.json)
  new      pytest/test_cancel_fleet_route_rejects_fleets_without_onward_legs
  new      pytest/test_routed_fleet_halts_when_the_onward_chain_is_gone
SQL: 2 new queries, 0 removed.
API: no breaking change, 0 other difference(s).
Scanner findings: 0 new, 0 resolved.

Change report: <workspace>/out/report/change-report.json
Diff diagrams: <workspace>/out/report/diff
Source diff:   git diff 0070766..7e08cc3
```

Read the two outputs it names. They are the evidence for the recipe:

| Output | What it holds |
| --- | --- |
| `change-report.json` | the structural facts: `changedAppMaps`, `newAppMaps`, `removedAppMaps`, `sqlDiff`, `apiDiff`, `findingDiff` |
| `diff/**/*.diff.sequence.json` | one diagram per changed trace; each action carries its `diffMode` (added/removed/changed) and its AppMap **labels** |

The workspace is `<system temp>/appmap-review`. It sits outside the repo, so its
files never get committed by accident, and it is cleared at the start of every
run. Pass `--workspace DIR` to keep two reviews side by side. When a CLI step
fails, the error names the command and the directory it ran in, and the workspace
is left in place to inspect.

Note: captured values in gold traces are **sanitized** — each is a stable,
equality-preserving token (`<v1>`, `<uuid:v3>`), not real data. Reason from labels,
call structure, and SQL *shape*, never from a value's contents; equal tokens still
signal equal values (data flow), and both revisions are sanitized identically so a
token never registers as a change.

## Head from the working tree

The natural moment to review is before committing, and the gold-traces workflow
depends on it: **appmap-gold-traces** says "re-record, review, then bless what the
review confirms". The recordings that review must judge are not in git yet. The
base always comes from git; the head can come from three places:

| Head | Flag | When | What it contains |
| --- | --- | --- | --- |
| a commit | `--head <rev>` (default `HEAD`) | the change is committed | the baselines committed at that revision |
| fresh recordings | `--fresh` | after `check --record` or `update --dry-run`, before `update` blesses anything | the recordings under `appmap_dir` for the manifest's entries: the candidates for blessing, sanitized by the engine |
| uncommitted baselines | `--uncommitted` | after `update` blessed, before the commit | the working tree's `gold_traces/baseline/appmaps`, as a commit would contain them |

`--fresh` is the one that closes the loop: run it, decide from the findings which
drift is intended, then `update` (with `--only` for a partial bless), then commit.
It needs a recording for every manifest entry and names any that are missing.
`--uncommitted` is a last look at what a commit would contain.

Everything after the compare is unchanged. In the report, write `working tree` as
the head revision, and state once in the banner that the head recordings are
uncommitted. The source diff for the recipe is `git diff <baseline>` with no head
ref, which includes uncommitted changes; the helper prints it.

## Interpret — the review recipe

The compare output is *facts*; the **review is your interpretation of them** — what
each change means and what to do. A fixed findings table can't reason about a change
the way you can. Run all steps in one pass, then render.

Everywhere a step needs runtime evidence, read the **change report** and the
**per-trace diff sequence diagrams**, together with the **source diff**
(`git diff <baseline>..<head>`). The AppMaps are not background — they are the
evidence of *what changed*.

**1 — Feature List & intended scope.** Inspect the source diff, enumerate the
features and functional changes (application code only — not tests/config), and name
each as a complete declarative statement (e.g. "Added a gameByCode query that resolves
a private game by code"). Note which produced runtime drift in the compare — those are
higher-signal. Also capture the **intended scope** — the yardstick for Step 5: the
files/subsystems the diff touches (`git diff --name-only <baseline>..<head>`) and any
behavior-preserving claims in the commits ("refactor", "rename", "no functional
change"). A change that claims to preserve behavior but moves a trace is a finding.

**2 — Coverage Matrix.** For each feature, list the gold/manifest tests that exercise
it. ✅ covered; ❌ **uncovered** when a behavior that should be guarded has no trace —
especially a security-sensitive path with no *negative* test. Decide "covered" from
the recordings, not from test names, in two steps. First, the compare: a trace that
changed runs the code that changed, so every feature behind a changed trace is
covered by that trace. Second, for a feature whose traces did not change, ask the
gold-traces engine whether any baseline runs its code:

```sh
node "${CLAUDE_SKILL_DIR}/../appmap-gold-traces/assets/manage.mjs" covers --dir gold_traces --name <ClassName>
```

A hit is ✅ (the change did not alter the call shape). A miss, after trying the
class name alone, is ❌. For each ❌, name the test to `discover`, found the way
**appmap-gold-traces** describes in "Finding the test for a code path"; if no test
exists, say that a focused test is needed and what it must drive. New entries are
added only when `discover` shows the recording runs something no baseline runs.

**3 — Suggested Labels.** For functions that **changed in the compare but carry no
label**, suggest one so the next review can interpret them. Primary-language
application code only. → per label: `label`, `file`, `line`, `description` (why).
Take label names from the taxonomy in **appmap-config** ("Labels"), plus any
project-specific labels already in use (e.g. `security.join_code`). The same skill
has the syntax for applying them.

**4 — Suggestions (three domain passes).** Each suggestion: `file`, `line`, `type`
(bug | security | performance), `priority` (low | medium | high), `label` (a few
words), `description`, and the trace(s) it is based on (state if the runtime evidence
was used). Respect decisions explained in comments; don't suggest reverting to a
prior form; skip style/refactor/docs/test suggestions unless the improvement is large.

- **4a General** — focus on (1) bugs/errors, (2) security vulnerabilities, (3) performance.
- **4b SQL** — DB-related only; read the SQL diff + query nodes. Check for: N+1 /
  inefficient patterns; unsanitized input / SQL injection; dynamic SQL without
  parameterization; improper escaping; string-concatenated queries; lack of
  least-privilege; DB error-message exposure; hardcoded credentials; missing query
  timeouts; unbounded LIMIT/OFFSET; trust in user-supplied table/column names;
  `SELECT *`; missing audit on sensitive ops; no prepared statements; missing
  validation on filter/sort params; NULL/type mishandling; second-order injection;
  multiple statements per query; outdated drivers; uncontrolled metadata access
  (`information_schema`); poor batch error handling. Also use the recorded SQL to
  confirm what a performance fix claims: a LIMIT pushed down into the database
  shows up in the query text (for example `fetch next ? rows only`), and a fix
  whose query text did not change did not do what its commit message says.
- **4c HTTP** — request-handling only; read changed server/client request nodes.
  Check for: missing input validation; weak/absent auth; insecure transport (HTTP not
  HTTPS); poor session management; missing content-type checks; insufficient CSRF
  protection; open redirects; trusting `Host` / `X-Forwarded-For`; unsanitized input
  in query/path; verb tampering; caching sensitive data; verbose error leakage; no
  rate limiting; permissive CORS; unsafe multipart parsing; missing security headers
  (CSP, X-Frame-Options); misuse of status codes; untrusted-body deserialization;
  malformed-header handling; insecure file uploads.

**5 — Reconcile drift against intent (the side-effect check — the headline step).**
For **every** changed trace, ask: does the change map to an enumerated feature *and*
to code the diff actually touched (cross-reference the changed functions against
`git diff --name-only`)? That splits the footprint in two:

- **Intended drift** — explained by a feature and the touched code. Confirm it matches
  the work, then it's bless-able. Assign severity from impact: a *dropped* guard and an
  *added* guard carry the same label but opposite severity; the compare can't tell them
  apart, you can.
- **Unintended side effect** — behavior that changed **outside the stated scope**: a
  trace in a subsystem the diff didn't touch, drift that maps to no feature, or a
  "refactor/no-op" commit whose traces moved anyway. **This is what a diff review
  structurally misses** — the residue of footprint minus intent. Grade each:
  - *Acceptable* (🟢 note): mechanical propagation — an additive schema column appearing
    in unrelated `SELECT`s; a shared helper the diff changed reaching its call sites
    identically. Action: **confirm the blast radius** is intended, then bless.
  - *Concerning* (🟡/🔴 flag): a changed **call shape**, a new query/loop/exception, a
    dropped guard, or an ordering change — in code the change didn't mean to alter; or a
    behavior-preserving claim contradicted. These get a finding.

  → Suggestion fields; `type: side-effect`; cite the changed trace, the out-of-scope
  function, and whether it appears in the diff.

**6 — Absence findings.** The strongest *security* findings are often about what's
**missing**: a security-labeled function that changed but gained **no** guard, while
sibling paths did. Traces show what ran; cross-check the source diff for what *should*
run but doesn't. → Suggestion fields; usually `priority: high`, `type: security`.

Steps 5–6 are the headline findings; steps 1–4 are the scaffolding around them.

## Report format

The report is **findings-first**: the reader lands on the verdict and the actionable
findings; the evidence that backs them is one click away. The recipe above is
unchanged — this section is how its output is *rendered*. Four principles govern it:

- **Plain language, for a reader who has never opened this codebase.** The report
  is read by people who haven't read the diff, don't know this skill's internals, and
  may not know the application. Write every finding so that such a reader can follow
  it end to end without opening a file. Concretely:
  - Say what happens to a *person* before what happens to a *function*: "the person
    is logged out", "the key is not issued", "bob is created and then deleted again".
    Then name the code that does it.
  - Ordinary words over security or engineering shorthand. Not "fail-closed", "inherits
    the gate", "call shape", "footprint", "static residue", "blast radius", "guard",
    "negative branch". Say "both paths refuse the key", "gets the check from its
    parent class", "the order of calls changed", "code this PR didn't touch", "the
    test that checks refusal".
  - Introduce every name before using it: a function, a controller, a table, a page.
    One clause is enough ("`ApiKey.issue`, the one function that hands out keys").
  - Expand product terms on first use ("gold traces — recorded test runs that show
    which functions and queries each test actually executes").
  - The test: read the finding aloud to a colleague from another team. If it sounds
    like a design document, rewrite it.
- **Diagram the mechanism.** A finding about a sequence of steps, a branch, or two
  paths that differ gets an ASCII diagram, not a paragraph. Draw the real path from
  the recording: the steps in order, the point where the check fires, and where the
  two outcomes split. Mark what is tested and what is not. A diagram plus three plain
  sentences beats four dense paragraphs. Keep it inside a fenced block so it survives
  GitHub rendering; keep lines under 90 characters so it does not wrap.

- **Single home.** Every fact is stated exactly once. A finding lives in **Findings**
  and nowhere else — ledger and coverage rows *reference* it by number (`→ #2`). A
  cross-cutting caveat (first-ever baseline, partial trace set) is stated once in the
  banner and never restated. Test recommendations live inside the finding they fix or
  the coverage gap that motivates them — there is no separate tests section. A
  concerning Step-5 side effect **is** a finding (`type: side-effect`); an acceptable
  one is a line in the drift narrative.
- **Tiered rendering.** 🔴/🟡 findings get the full block (file, evidence, risk, fix).
  🟢 findings get one bullet each. A purely intended change that was considered and
  cleared is not a finding at all — it is the ✅ *Intended changes verified* row in
  the ledger.
- **Clean is a row, not a section.** A pass that found nothing (compare, side-effects,
  absence, SQL, HTTP) earns exactly one ledger row with a one-line note. Prose exists
  only where there are findings to explain.

Prose budgets: Feature List entries are strictly one line; **Background**, **What is
right**, **What is off**, and **Fix** are ≤ 3 sentences each; code blocks only for a
diagram or where the reader should copy-paste. Step 1's intended-scope notes are
working input to Step 5 — don't render them.

Keep the scannable idiom: emoji severity markers, ✅/❌ tables, clickable `file:line`
links. Structure (outer fence is `~~~` so nested code blocks can use normal
```` ``` ````; GitHub renders `<details>` folded in PR comments and job summaries, so
the detail stays accessible without being paid for on every read):

~~~markdown
# AppMap Behavioral Review — <feature/release>

**Revisions:** `<head>` vs `<baseline>` · **Date:** <YYYY-MM-DD> ·
**Commits:** `<sha>` <short subject> · … (group out-of-scope commits in one parenthetical)

> ⚠️ **How this review works.** <Two or three sentences for a reader who has never
> heard of gold traces: recorded test runs were re-run on the head revision and
> compared with the base revision's recordings. Then any cross-cutting caveat — first
> baseline, uncommitted head recordings, entries with nothing to compare against —
> stated once here and referenced elsewhere.>

## What the change does

One paragraph, in ordinary words, for someone who has not read the PR: what a user
can now do or no longer can, which doors it applies to, and what stays the same.
Name the feature the way a person would, not the way the code does.

## Summary

| Severity | Findings | Action required |
| --- | --- | --- |
| 🔴 High | … | … |
| 🟡 Medium | … | … |
| 🟢 Low | … | … |

One or two sentences: merge-blocking or not, and the single most important action.

## Findings

Numbered across all severities, ordered by severity.

### 1 · 🔴 HIGH — <one-line title, in plain words: what happens to whom>

**File:** [path:line](path) · **Evidence:** <trace name — or "source diff only"
when no trace covers it>

**Background.** Two or three sentences a newcomer needs before the finding makes
sense: what this part of the app does for a person, and which function or page is
involved (named once, explained once).

```
<ASCII diagram of the real path, drawn from the recording or the diff:
 the steps in order, the point where the check fires, where outcomes split,
 and which branch is tested. Under 90 columns.>
```

**What is right.** What the change gets correct, in one or two sentences, so the
reader knows the finding is not "this feature is broken".

**What is off.** What the evidence shows and why it matters, said from the person's
side first ("the person is logged out"), then the code's side. Who is exposed and
how reachable it is, in ordinary words.

**Fix.** The concrete change, then the regression test to add (≤ 3 sentences plus a
copy-paste block if warranted):

```python
def test_cannot_<bypass>(...):
    ...
```

### 🟢 Low

- **4** · <title in plain words> — [file:line](path) — one sentence on what is off,
  one on the fix. A low finding about a sequence of steps still gets the short
  diagram; drop the Background and What-is-right parts.

## Checks performed

The audit trail: every pass the review ran, one row each.

Row labels are plain words; recipe step numbers never appear in the rendered report.

| Check | Result | Note |
| --- | --- | --- |
| Recorded behavior compared | ✅ no change · ⚠️ n changed, n new, n removed → #n · — not run | <one line, e.g. "run-to-run noise such as timings and generated values is ignored, so every reported change is a real difference in what ran"> |
| Behavior changed in code the PR did not touch | ✅ none · ⚠️ → #n | <one line> |
| Places that should have the check but do not | ✅ · 🔴 → #n | <one line> |
| Tests and recordings for the new behavior | ✅ · ❌ n gaps (detail ↓) | <one line> |
| Database queries | ✅ clean · ⚠️ → #n | <one line> |
| HTTP responses | ✅ clean · ⚠️ → #n | <one line> |
| Intended changes confirmed by a recording | ✅ | <one line — the cleared features, with their evidence> |

<details>
<summary><b>Review detail</b> — features, coverage, labels, drift</summary>

### Feature List

Numbered, one line each: **bold lead-in** naming the feature, then what it does.

### Coverage Matrix

| Feature | Covered by | Status |
| --- | --- | --- |
| <feature> | `test_name` | ✅ |
| **<security-relevant feature>** | **no test** | ❌ **uncovered** → #n |
| <client-only/untraced> | — | — |

(✅ a gold/unit trace exercises it; ❌ a behavior that *should* be guarded isn't —
especially a security path with no negative test; — out of trace scope.) For each
❌, one line saying how to close it: the existing test to `discover`, or, if none
runs the path, the focused test to write and the entry point it must drive.

### Suggested Labels

- **`<label>`** — [file:line](path) `<fn>` — why.

### Behavioral Drift

Short prose: the **intended** drift (which traces changed as the feature predicts),
which subsystems held still, which traces are new — plus any acceptable Step-5
side effects (mechanical propagation, confirmed blast radius).

</details>
~~~

## Show the recordings to the reader

The report is text; the recordings behind it are browsable. When the reader can reach
a port on the machine that ran the review (a Devin session, a shared dev box), open
the CLI's web UI over the recordings and hand them the link alongside the report:

```
appmap index    --appmap-dir <gold_traces>/baseline/appmaps
appmap query ui --appmap-dir <gold_traces>/baseline/appmaps --port <port> --no-open
```

`appmap query ui` serves a dashboard over the indexed recordings — endpoints, SQL,
functions, exceptions, labels, per-recording call trees, and a branch compare — and
is the interface meant for a person. `appmap index` must run first; `query ui` reads
the index it builds under `~/.appmap/data/` and fails with "query DB not found"
otherwise. Pass `--port` so the URL is stable enough to share, and `--no-open` on a
headless machine. The agent-facing counterpart of the same data is
`appmap query mcp` (and the `appmap query …` verbs on the command line).

Do **not** reach for `appmap open <file>` for this. It renders one recording in the
single-map IDE viewer, not the browsable overview, and in CLI 3.20x its bundled
viewer page is blank in a browser (`ReferenceError: process is not defined` from
`appmap.js`). Report that, don't patch the CLI around it.

## Rules for the interpretation

- **Reason from labels + structure + source, never from a rule table.** A
  `security.authorization` change → reason about the auth implication; a removed SQL
  read → reason about what guard/data it provided; an `io.http` change → an
  external-call implication. The label names the domain; you supply the meaning.
- **Reconcile footprint against intent — this is the point.** The behavioral diff
  shows *everything* that changed; the source diff + commit messages say what was
  *meant* to change. The gap is the unintended side effect, which a diff review can't
  see. Always cross-reference a changed trace against `git diff --name-only`: drift in
  code the change didn't touch is the finding to chase. Distinguish mechanical
  propagation (acceptable — confirm the blast radius) from a changed call shape or new
  query/exception out of scope (concerning).
- **Severity is yours to assign** from impact, not from the label namespace. An
  *added* guard on a security path and a *dropped* guard on the same path carry the
  same label but opposite severity — the compare cannot tell them apart; you can.
- **The strongest findings are often about *absence*.** A security-labeled function
  that changed but gained **no** guard — while sibling paths did — is the
  ❌-uncovered row and usually the headline. Traces show what ran; cross-check the
  source diff for what *should* run but doesn't.
- **Coverage is path-dependent.** A trace only guards the branch it executes. A
  conditional gate (`if private: <check>`) is invisible to a trace that never drives
  that branch — so a clean compare on a happy-path trace does not clear a
  conditional guard. Flag the missing negative trace.
- **Cite evidence for every finding** (trace name + changed node + label + `file:line`),
  so the report is auditable against the compare output and the diff.
- **Write for a reader who has never seen the code.** Labels, node names, and recipe
  steps are how *you* reason; they are not how the finding is explained. A finding is
  finished when someone from another team can read it, look at the diagram, and say
  back what happens to the person and what to change. If explaining it needs a term
  like "fail-closed" or "guard", replace the term with the thing it stands for.
- **A clean compare is a valid report:** render it as ✅ rows in the checks ledger
  (noting that timing/value jitter is excluded by construction), rather than omitting
  the report — the ledger is what proves the checks ran.
