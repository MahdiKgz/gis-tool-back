# Snap GIS — Feature Branch Consolidation

## Objective

Consolidate all relevant unmerged feature branches into a single integration branch, resolve all merge conflicts, and leave the project in a compilable state.

At this stage, the priority is:

1. Merge existing feature branches.
2. Resolve conflicts correctly.
3. Preserve the implemented features.
4. Make the consolidated project compile.
5. Prepare the project for manual GIS testing.

Full GIS correctness testing, algorithm redesign, performance optimization, and broad architectural refactoring are intentionally deferred until after branch consolidation.

---

## Source of Truth

Treat the latest remote `main` branch as the source of truth for:

- shared infrastructure
- shared types
- existing API contracts
- worker integration
- project configuration
- package configuration

Feature branches may contain:

- incomplete implementations
- outdated shared code
- conflicting implementations
- unrelated commits
- partial tests
- code based on older versions of `main`

Do not assume that a feature branch is correct merely because it contains a completed implementation.

---

## Required Git Workflow

### 1. Inspect the repository

Before making changes, inspect:

- current Git branch
- working-tree status
- local branches
- remote branches
- repository structure
- `package.json`
- package-manager lockfile
- available scripts
- TypeScript configuration
- test configuration

Determine the package manager from the repository files. Do not assume npm, pnpm, or Yarn.

---

### 2. Verify the working tree

Run:

```bash
git status
```

If the working tree contains uncommitted changes:

- stop immediately
- do not discard anything
- do not reset anything
- do not overwrite user changes
- report the existing changes

Continue only when the working tree is clean.

---

### 3. Fetch remote branches

Run:

```bash
git fetch --all --prune
```

Inspect all remote feature branches after fetching.

---

### 4. Update local main

Run:

```bash
git switch main
git pull --ff-only
```

Do not create merge commits while updating `main`.

If `main` cannot be updated using fast-forward only, stop and report the problem.

---

### 5. Create the integration branch

Create a new branch from the latest `main`:

```bash
git switch -c integration/consolidate-feature-branches
```

All consolidation work must happen on this integration branch.

Do not modify remote `main`.

---

## Feature Branch Discovery

Find all relevant remote and local feature branches that have not already been merged into `main`.

Inspect each branch using commands such as:

```bash
git branch --all
git branch --no-merged main
git log main..<branch-name> --oneline
git diff --stat main...<branch-name>
git diff main...<branch-name>
```

Exclude branches that:

- are already fully merged
- contain no meaningful changes
- are clearly abandoned duplicates
- only contain unrelated experiments
- contain changes that have already been replaced by a newer branch

Do not silently exclude a branch. Document every excluded branch and the reason.

---

## Merge Order

Determine a dependency-aware merge order.

Do not merge branches only according to:

- branch name
- creation date
- GEO rule number
- alphabetical order

Inspect actual dependencies, including:

- shared types
- common utility functions
- imports
- parsers
- result schemas
- report schemas
- worker changes
- overlapping files
- shared geometry helpers
- repair workflows
- dry-run workflows
- rule dependencies

Prefer this general order when supported by the code:

1. Shared types and contracts
2. Shared utilities
3. Parser and input-validation changes
4. Geometry type and dimension validation
5. Single-feature geometry rules
6. Layer-level topology rules
7. Cross-feature rules
8. Repair implementations
9. Dry-run and healing workflows
10. API and reporting integration

Briefly print the selected merge order before beginning.

After printing the plan, continue automatically. Do not wait for additional approval between branches.

---

## Merge Process

Merge branches one at a time.

Use:

```bash
git merge --no-ff <branch-name>
```

Each feature branch must have a traceable merge commit.

Do not squash all branches into one commit.

After every merge:

1. Resolve all conflicts.
2. Verify that no conflict markers remain.
3. Preserve both the incoming feature and current shared infrastructure where possible.
4. Stage the resolved files.
5. Complete the merge commit.
6. Record the branch name.
7. Record the conflicted files.
8. Record compatibility changes.
9. Continue to the next branch.

---

## Conflict Resolution Policy

Never resolve conflicts blindly using only:

```bash
git checkout --ours
git checkout --theirs
```

Those commands may be used only for individual files after understanding both versions and confirming that one side must fully replace the other.

For every conflict:

1. Read the `main` implementation.
2. Read the incoming branch implementation.
3. Identify the intended feature behavior.
4. Preserve newer shared contracts from `main`.
5. Adapt the incoming feature to current contracts.
6. Preserve useful behavior from both implementations.
7. Avoid duplicate implementations.
8. Avoid silently removing functionality.
9. Avoid unrelated refactoring.

### General priority

When resolving conflicts, prioritize:

1. preserving the feature implemented by the incoming branch
2. preserving newer infrastructure from `main`
3. maintaining compilation
4. maintaining existing API compatibility
5. avoiding destructive GIS behavior
6. minimizing unrelated code changes

---

## Competing Implementations

When two branches implement different versions of the same capability:

1. Compare completeness.
2. Compare integration with current `main`.
3. Compare test coverage.
4. Compare type safety.
5. Compare GIS behavior.
6. Retain the stronger implementation.
7. Port useful missing behavior from the other implementation.
8. Avoid keeping two duplicate implementations.

Document:

- which implementation was retained
- why it was retained
- which behavior was ported
- which behavior was deferred

---

## GIS-Specific Conflict Rules

When a conflict requires an uncertain GIS-domain decision:

- choose the least destructive behavior
- do not silently change geometries
- do not automatically enable risky repairs
- prefer detection-only behavior over destructive automatic healing
- preserve original geometries where possible
- add a clear `TODO` comment when a decision requires manual verification
- document the issue in the final report

Do not block the entire consolidation because of a non-critical GIS ambiguity.

Stop only when:

- the project cannot compile without making an unsafe decision
- required code is missing
- branch history is corrupted
- a conflict cannot be resolved without deleting major functionality
- repository state is unsafe

---

## Scope Restrictions

This task is branch consolidation, not redesign.

Do not:

- rewrite `gis.worker.ts`
- introduce a new rule engine
- redesign the architecture
- redesign repair strategies
- implement new GIS features
- perform project-wide formatting
- rename unrelated files
- upgrade dependencies without necessity
- optimize algorithms
- redesign APIs
- change result schemas unnecessarily
- delete existing tests
- delete fixtures to make tests pass
- add new `@ts-ignore`
- add new `@ts-nocheck`
- modify `.env`
- commit credentials or secrets
- delete feature branches
- force-push
- push any branch
- merge the integration branch into `main`

Small compatibility changes are allowed only when necessary to:

- resolve conflicts
- connect merged modules
- update imports
- align types
- maintain API compatibility
- make the consolidated project compile

Document every compatibility change.

---

## Environment and Secret Safety

Do not modify or commit:

- `.env`
- credentials
- access tokens
- private keys
- production URLs
- local secrets

If a feature branch contains secrets:

1. do not merge the secret
2. preserve only safe configuration changes
3. report the affected branch and file
4. continue only when repository safety is maintained

---

## Verification During Consolidation

Full functional GIS testing is deferred.

After each branch merge, perform lightweight structural checks when practical:

- inspect `git status`
- inspect changed files
- verify imports
- verify conflict markers are gone
- run a fast TypeScript or build check when available

Do not spend excessive time fixing unrelated pre-existing failures after every branch.

---

## Final Structural Verification

After all relevant branches have been merged, inspect `package.json` and run the repository's actual available scripts.

Run available non-destructive checks such as:

```bash
<package-manager> run typecheck
<package-manager> run build
<package-manager> run lint
```

Only run commands that exist in `package.json`.

Unit tests may be executed when they are already configured and reasonably fast.

Full manual GIS validation is not part of this task.

---

## Failure Handling

When a structural check fails:

1. Determine whether the failure exists on the original `main`.
2. Determine whether it was introduced by consolidation.
3. Fix failures introduced by merges.
4. Do not broaden the task to fix unrelated pre-existing failures.
5. Document all remaining pre-existing failures.

Do not remove tests or weaken TypeScript configuration merely to obtain a passing result.

---

## Conflict Marker Check

Search the entire repository for unresolved merge markers:

```bash
git grep -n -E '^(<<<<<<<|=======|>>>>>>>)'
```

The command must return no unresolved conflict markers before completion.

Also inspect for incorrectly committed conflict fragments that may be indented or embedded inside strings or comments.

---

## Final Git Verification

Before finishing, verify:

```bash
git status
git log --graph --oneline --decorate --all
git diff main...integration/consolidate-feature-branches --stat
```

Confirm that:

- the working tree is clean
- the current branch is `integration/consolidate-feature-branches`
- local `main` has not received consolidation commits
- no remote branch was modified
- every relevant feature branch is represented
- merge commits are traceable
- no unresolved conflict remains

Do not push.

Do not merge into `main`.

---

## Completion Criteria

The consolidation is complete when:

- all relevant feature branches are represented in the integration branch
- excluded branches are documented
- all merge conflicts are resolved
- no conflict markers remain
- each feature branch has a traceable merge history
- necessary compatibility fixes are applied
- the working tree is clean
- the project passes available typecheck and build checks, except documented pre-existing failures
- `main` has not been modified by the consolidation
- no branch has been pushed
- deferred manual GIS tests are documented

---

## Final Report

Provide the final report using exactly the following structure.

### Integration Branch

Include:

- branch name
- starting `main` commit hash
- final integration commit hash
- current working-tree status

### Discovered Branches

List:

- all discovered feature branches
- branches selected for integration
- branches excluded from integration
- reason for every exclusion

### Merge Order

List the exact order in which branches were merged.

### Branch Results

For every integrated branch, include:

- branch name
- merge status
- merge commit hash
- conflicts encountered
- files resolved
- compatibility changes made
- unrelated commits skipped
- deferred concerns

### Important Conflict Decisions

For every important competing implementation, explain:

- conflicting files or modules
- behavior provided by each version
- selected implementation
- reason for selection
- behavior ported from the other version
- remaining uncertainty

### Verification

Include exact commands and their results:

- package-manager detection
- typecheck
- build
- lint
- optional unit tests
- conflict-marker search
- final Git status

Do not summarize command results vaguely.

### Deferred Manual Testing

List all items requiring later manual verification, including:

- GIS correctness
- geometry-repair safety
- CRS handling
- unit and tolerance behavior
- overlap behavior
- gap behavior
- spike detection
- multipart behavior
- ring behavior
- feature mutation
- report output
- API output
- worker execution
- large-file behavior

### TODO Items

List every TODO comment added during consolidation, including:

- file path
- line or surrounding function
- reason
- required manual decision

### Final Status

Use exactly one of these values:

- `consolidation complete`
- `consolidation complete with deferred issues`
- `consolidation blocked`

---

## Final Restrictions

Do not push any branch.

Do not merge the integration branch into `main`.

Do not delete feature branches.

Do not perform manual production deployment.

Stop after presenting the final report.
