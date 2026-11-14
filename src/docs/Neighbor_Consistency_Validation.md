# Neighbor Consistency Validation

SnapGIS validates that adjacent polygon exterior boundaries use compatible
vertex segmentation. Two parcels can share the same straight boundary while
only one stores an intermediate vertex. That hidden T-node is geometrically
subtle but makes later editing, exchange and topology operations inconsistent.

## Detection

The detector visits structurally valid Polygon and MultiPolygon exterior
rings. A vertex is eligible only when it is a straight pass-through vertex,
not a corner. An RBush index then finds boundary segments from distinct
features on the same CAD layer that contain the vertex in their strict
interior.

This deliberately excludes:

- real corners and ordinary T-junction contacts;
- segment endpoints, where the neighbor already has the vertex;
- interior-hole rings;
- different CAD layers;
- ambiguous matches against more than one target segment.

Candidate discovery is spatially indexed and avoids an all-pairs polygon scan.
The default coincidence epsilon is 0.1 mm and exists only to absorb numeric
serialization noise; it is not the user-configured snapping tolerance.

## Repair

A unique match is high confidence. SnapGIS inserts the point interpolated on
the neighbor's existing segment, including interpolated extra ordinates. This
splits one segment into two without moving the boundary or changing area.

Repairs are grouped per ring and segment, applied without mutating input and
accepted only when the target endpoints are still current and the resulting
feature passes self-intersection, hole and multipart validation. Stale or
invalid candidates remain unresolved for manual review.

The dry-run report uses `NEIGHBOR_VERTEX_MISMATCH` under the
`neighborConsistency` check. Healing exposes `neighborVerticesInserted` and a
detailed `neighborConsistencyValidationReport`.
