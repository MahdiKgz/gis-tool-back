# GEO-012 Multipart Geometry Validation

## Scope

GEO-012 validates `MultiPolygon` component structure and topology, including
multipart geometries nested inside `GeometryCollection`.

## Validation rules

A valid `MultiPolygon`:

- contains at least one polygon component;
- contains no empty or structurally invalid polygon component;
- contains no rotation- or winding-equivalent duplicate component; and
- contains no pair of components with positive-area overlap.

Components may share boundary points or edges. Boundary-only contact has zero
intersection area and remains valid under GeoJSON semantics.

Duplicate signatures use linear-time canonical ring rotation and treat hole
ordering as irrelevant. An RBush index limits topology checks to components
with intersecting bounding boxes before exact intersection area is calculated.

## Policy and pipeline

SnapGIS does not guess which multipart component should be removed or merged.
Invalid multipart features are preserved, reported for manual review, and
quarantined before repair and topology stages.

Worker results expose:

- `invalidMultiPolygonsFound`
- `multipartIntegrityIssuesUnresolved`
- `multipartIntegrityValidationReport`

## Test data

`src/test-data/geojson/geo-012-multipart-integrity.geojson` covers disjoint
valid components, positive-area overlap, rotated duplicate components, and an
empty component. Unit tests also cover boundary touching, empty
`MultiPolygon`, and nested geometry-collection paths.
