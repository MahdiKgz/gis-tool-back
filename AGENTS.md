# AGENTS.md

# SnapGIS Agent Instructions

## Overview

You are contributing to **SnapGIS**, an enterprise-grade GIS Topology
Validation & Auto-Repair Engine.

The processing engine is the product. UI, API, SaaS and AI features are
secondary.

------------------------------------------------------------------------

## Primary Objective

Deliver production-quality software.

Priorities:

1.  Correctness
2.  Stability
3.  Maintainability
4.  Performance
5.  Readability

Never sacrifice correctness for simplicity.

------------------------------------------------------------------------

## Source of Truth

Always read:

-   docs/SnapGIS_Processing_Engine_Backlog.md

Always implement the **first task marked TODO**.

------------------------------------------------------------------------

## Workflow

For every iteration:

1.  Read the backlog.
2.  Select ONLY the first TODO task.
3.  Understand existing code.
4.  Design the implementation.
5.  Implement production-ready code.
6.  Integrate into the processing pipeline.
7.  Add Unit Tests.
8.  Add Integration Tests if applicable.
9.  Add GeoJSON test datasets if applicable.
10. Run all tests.
11. Fix every failing test.
12. Verify no regressions.
13. Mark the task DONE in the backlog.
14. Create a descriptive Conventional Commit.
15. STOP.

Never continue to the next task automatically.

------------------------------------------------------------------------

## Architecture Rules

-   Keep modules isolated.
-   Separate Detection, Repair, Reporting, Utilities and Configuration.
-   Never duplicate logic.
-   Never rewrite working modules without necessity.
-   Reuse existing helpers.
-   Reuse RBush whenever possible.

------------------------------------------------------------------------

## Performance Rules

Prefer O(n log n).

Avoid O(n²).

Avoid unnecessary geometry reconstruction.

Avoid unnecessary allocations.

Support enterprise-scale datasets.

------------------------------------------------------------------------

## Auto Repair Rules

High confidence → Repair.

Medium confidence → Repair only if topology remains valid.

Low confidence → Report only.

Never perform destructive repairs with low confidence.

------------------------------------------------------------------------

## Testing Rules

Every task must include:

-   Unit Tests

Whenever applicable:

-   Integration Tests
-   Regression Tests
-   GeoJSON Samples

Never finish with failing tests.

------------------------------------------------------------------------

## Git Rules

One Task

↓

One Branch

↓

One Logical Commit Sequence

↓

Stop

Do not mix multiple backlog tasks.

------------------------------------------------------------------------

## Refactoring Policy

Do NOT refactor unrelated code.

If unrelated problems are discovered:

-   Document them.
-   Do not fix them during the current iteration.

Avoid scope creep.

------------------------------------------------------------------------

## Definition of Done

A task is DONE only if:

-   Production-ready implementation
-   Pipeline integration completed
-   Tests added
-   Tests passing
-   No regressions
-   Documentation updated
-   Backlog updated
-   Git commit created

Otherwise the task is NOT complete.

------------------------------------------------------------------------

## Final Output

After finishing a task report:

-   Task completed
-   Files modified
-   Tests added
-   Tests executed
-   Regression status
-   Remaining risks

Then STOP.
