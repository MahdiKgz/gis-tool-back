# GEO-009 Collapsed Polygon Detection

## Scope

GEO-009 detects polygon components that had positive area before repair but
have zero area or are missing afterward. This before/after contract prevents
pre-existing zero-area input from being mislabeled as repair damage.

## Detection

Before validation and repair, the worker captures a lightweight baseline for
each structurally measurable polygon component:

- feature index and identifier;
- geometry-collection and multipart component paths; and
- positive geodesic area.

The baseline is O(p) in polygon-component count and avoids cloning the full
dataset. After the structural, hole, orientation, and spike repair stages,
the detector measures the same component paths. A positive-to-zero transition
is reported as `ZeroArea`; disappearance is reported as `Missing`.

Components that were already zero-area are excluded and remain GEO-007's
responsibility.

## Policy

A collapsed polygon cannot be reconstructed safely without rollback metadata
or source-domain knowledge. GEO-009 is report-only: findings are preserved,
quarantined, and recommended for manual review.

Worker results expose:

- `collapsedPolygonsFound`
- `collapsedPolygonIssuesUnresolved`
- `collapsedPolygonValidationReport`

## Test data

The paired integration fixtures are:

- `src/test-data/geojson/geo-009-collapse-before.geojson`
- `src/test-data/geojson/geo-009-collapse-after.geojson`

They cover one positive-to-zero collapse and one stable positive-area control.
Unit tests also cover missing components and exclusion of pre-existing zero
area.
