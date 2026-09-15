# AppMap Behavioral Review

Two skills that catch the regressions a test suite passes — dropped guards, new
queries, **unintended side effects** — by diffing recorded *behavior*, not just the
source.

- **appmap-gold-traces** (maintenance) — owns the committed data: curate the manifest,
  record, keep traces lean and deterministic, and **bless** baselines.
- **appmap-review** (review) — given two revisions, locate each one's gold traces in
  git, archive them, run `appmap compare`, and **interpret** the result into a
  scannable, actionable review.

## Data model

A manifest (`gold_traces/manifest.yaml`) names the curated gold tests. The baseline is
**raw `*.appmap.json` committed in git** — the source of truth, blessed deliberately,
diffable per-trace. The indexed/archive form (sequence diagrams, openapi, findings) is
**derived at review time, never committed** — it lives under `.appmap/`, like the rest
of the CLI's working artifacts. Functions on paths worth interpreting carry AppMap
**labels** (`security.*`, `io.*`, …).

## Maintenance (appmap-gold-traces): curate → record → bless

Re-record the gold tests on a release and **bless** the baselines. The engine (`assets/manage.mjs`) provides five maintenance operations:

- **plan** — show the record commands the engine would run. The manifest names the
  test framework (`pytest`, `rspec`, `jest`, `maven`, ...) and the engine builds the
  commands, batching the gold set into as few runner invocations as that framework
  allows.
- **check** — report size/shape/coverage and, when recording, verify two-run stability.
- **discover** — record one candidate, report its path, assess its shape, and say
  what it runs that no committed baseline runs.
- **covers** — list the committed baselines (or, with `--fresh`, the recordings under
  `appmap_dir`) that run a code object whose id contains a given name. Answers "does
  a gold trace already run this?" without recording anything.
- **update** (digest-gated) — optionally record, then re-bless a baseline only when its behavioral **digest**
  changed (raw appmaps differ on every recording — timestamps, ids — so a blind copy
  would churn git), and seed baselines for new entries. Unchanged baselines stay
  byte-identical.

Deciding *whether* a change is intended is appmap-review's job, not maintenance's. The
maintenance skill only judges trace hygiene (deterministic, in-scope, lean) and applies
the bless.

## Review (appmap-review)

1. **Resolve** `baseline` and `head` (one revision ⇒ baseline + HEAD; two ⇒ explicit).
2. **Check capture-config parity** — both sides recorded the same way, or re-record the
   stale side (the common failure: base predates SQL capture / labels).
3. **Compare** with the helper, `appmap-review/assets/review.mjs compare`. It reads each
   revision's gold traces from git (or the head from the working tree), archives each
   side with `appmap archive`, restores them, and runs `appmap compare` → change
   report. Changed-vs-unchanged is decided by the `subtreeDigest`, which excludes
   elapsed time, ids, and values — so timing and unstable-data jitter never register.
4. **Interpret** (the recipe below) the compare output + the source diff into findings.
5. **Render** the scannable report.

## Division of labor

- **AppMap CLI** produces *facts*: archive/index, label-bearing sequence diagrams,
  `compare`. Deterministic, noise-immune, no opinions.
- **appmap-gold-traces** owns the *committed data* + the bless lifecycle.
- **appmap-review** owns the *interpretation* — one agent, one pass.

Labels are one pipeline across the skills: the review *suggests* labels on
changed-but-unlabeled functions → **appmap-config** *applies* them → archive *bakes them
into `sequence.json`* → the next review *reads them* for severity.

## The review recipe

Run in one pass over the compare output + source diff (full text in
`appmap-review/SKILL.md`):

| Step | Report section | Grounded by |
|---|---|---|
| Feature List & **intended scope** | Feature List | git diff + `--name-only` |
| Coverage matrix + test-gap commands | Coverage Matrix | manifest + changed traces |
| Suggest labels (changed-but-unlabeled fns) | Suggested Labels | compare + diff |
| Suggestions: general / SQL / HTTP | Suggestions / SQL Pass / HTTP Pass | compare + diff |
| **Reconcile drift vs. intent** | Behavioral Drift + **Unintended Side Effects** | footprint − intent |
| **Absence** | Suggestions (🔴) | compare + diff |

The two steps a diff review structurally can't do — the reason behavioral review
exists — are the headline:

- **Unintended side effects** — behavior changed *outside the stated scope*; graded
  *acceptable* (mechanical blast radius — confirm + bless) vs. *concerning* (out-of-scope
  call-shape / query / guard change — flag). Cross-reference `git diff --name-only`.
- **Absence** — a security-labeled function that changed but gained no guard.

## Notes

**No SQL fingerprint in the skill.** The engine reports changed query nodes as facts;
grading SQL significance (a dropped predicate vs. a new projected column) is the
reviewer's "SQL Pass," not the engine's. A regex-based fingerprint used to live here and
was deleted — regex SQL parsing is unreliable (subqueries, CTEs, dialects), and the
reliable, AST-based normalization already exists upstream (`@appland/models`'s
`abstractSqlAstJSON`, which drives the digest and `appmap compare`'s `sqlDiff`). If
projection-quiet grading is ever wanted as a deterministic signal, it belongs in
`appmap compare`'s `sqlDiff` (built on the AST parser), not the skill.

**Future home — `appmap golden`.** The gold-trace lifecycle (manifest + committed
baselines + record-config + digest-gated bless) is generic, so it ultimately belongs in
the CLI as `appmap golden record|status|bless`, built on the existing
`compare` / `SequenceDiagramDigest`. Then it ships and versions with `@appland/appmap`,
the layout/schema become CLI conventions, and both skills become prompts + thin
invocations. The only project-specific input — the record command — stays as config the
CLI reads.

## TODO

- [ ] Merge appmap-js **#2369** (labels on diagram actions); pin a minimum `appmap_cli`
      version once released.
- [ ] appmap-review: add the capture-config parity check to `review.mjs compare`
      (locate-in-git → archive → restore → `appmap compare` is already there).
- [ ] Add `appmap archive --output-dir` (emit the indexed dir, skip the tar round-trip).
- [ ] Drive the archived set from the manifest (archive only the curated tests).
- [ ] Fold the label-annotated digest into `compare-report` as a first-class section.
- [ ] Propose `appmap golden record|status|bless` to appmap-js; once it exists,
      `manage.mjs` retires entirely and the skill ships no engine.
- [ ] **Deferred:** decide whether projection-quiet SQL grading is worth a deterministic
      `sqlDiff` mode, or the reviewer's judgement suffices.
