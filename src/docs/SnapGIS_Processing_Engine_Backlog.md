# SnapGIS Processing Engine Backlog

> This document defines the implementation roadmap for the SnapGIS
> processing engine.

## Development Order

-   [x] Phase 1 --- Processing Engine
-   [ ] Phase 2 --- Advanced Topology
-   [ ] Phase 3 --- Auto Repair Engine
-   [ ] Phase 4 --- Worker & Reporting
-   [ ] Phase 5 --- Performance
-   [ ] Phase 6 --- Testing

------------------------------------------------------------------------

# Current Status

## Completed

### Geometry

-   [x] Self Intersection Detection and Dry-Run Reporting
-   [x] Self Intersection Repair
-   [x] Polygon Overlap Detection
-   [x] Multi-pass Overlap Repair
-   [x] Gap Detection, Dry-Run Reporting, and Repair Integration
-   [x] Sliver Detection, Dry-Run Reporting, and Minimum-Area Repair
-   [x] Undershoot Detection, Dry-Run Reporting, and Repair
-   [x] Overshoot Detection, Dry-Run Reporting, and Repair
-   [x] Duplicate Polygon Detection
-   [x] Duplicate Vertex Detection and Safe Repair
-   [x] Invalid Ring Detection and Safe Repair
-   [x] Ring Closure Validation and Safe Auto-Close
-   [x] Ring Orientation Validation and Normalization
-   [x] Invalid Hole Validation and Conservative Repair
-   [x] Spike Detection and Safe Repair
-   [x] Zero-Area Polygon Detection
-   [x] Tiny Polygon Detection
-   [x] Collapsed Polygon Detection After Repair
-   [x] Geometry Type Validation
-   [x] Geometry Dimension Validation
-   [x] Multipart Geometry Validation
-   [x] Coordinate Precision and Floating-Point Validation

### Infrastructure

-   [x] RBush Spatial Index
-   [x] BullMQ Worker
-   [x] GeoJSON Support
-   [x] KML Support
-   [x] KMZ Support
-   [x] Background Processing
-   [x] Durable Heal Status, Result Preview, and Download Delivery

------------------------------------------------------------------------

# Phase 1 --- Processing Engine (Highest Priority)

## GEO-001 Duplicate Vertex Detection

-   [x] Detect duplicated vertices
-   [x] Remove redundant vertices safely
-   [x] Validation report
-   [x] Unit tests
-   [x] GeoJSON test dataset

## GEO-002 Invalid Ring Detection

-   [x] Detect unclosed rings
-   [x] Detect corrupted rings
-   [x] Detect rings with insufficient vertices
-   [x] Auto repair when safe

## GEO-003 Ring Closure Validation

-   [x] Detect open rings
-   [x] Auto close rings

## GEO-004 Ring Orientation Validation

-   [x] Validate exterior ring orientation
-   [x] Validate interior ring orientation
-   [x] Normalize orientation

## GEO-005 Invalid Hole Validation

### Detection

-   [x] Hole Outside Polygon
-   [x] Nested Hole
-   [x] Duplicate Hole
-   [x] Self Intersecting Hole
-   [x] Hole Touching Boundary
-   [x] Tiny Hole
-   [x] Hole Larger Than Polygon

### Repair

-   [x] Remove tiny holes
-   [x] Remove outside holes
-   [x] Normalize hole orientation

## GEO-006 Spike Detection

-   [x] Detect spikes
-   [x] Configurable tolerance
-   [x] Auto repair

## GEO-007 Zero Area Polygon Detection

-   [x] Detect zero-area polygons

## GEO-008 Tiny Polygon Detection

-   [x] Detect tiny polygons

## GEO-009 Collapsed Polygon Detection

-   [x] Detect collapsed polygons after repair

## GEO-010 Geometry Type Validation

-   [x] Validate geometry types

## GEO-011 Geometry Dimension Validation

-   [x] Validate geometry dimensions

## GEO-012 Multipart Geometry Validation

-   [x] Validate MultiPolygon integrity

## GEO-013 Coordinate Precision Validation

-   [x] Coordinate precision
-   [x] Floating point robustness

## Gap and Sliver Repair Hardening

-   [x] Repair complete, parallel exterior gap edges on a neutral midpoint
-   [x] Separate the accepted gap width from the 3x repair radius
-   [x] Reject partial-edge and corner-only gap repair candidates
-   [x] Remove minimum-area Polygon and MultiPolygon sliver components
-   [x] Preserve compactness-only narrow parcels for manual review
-   [x] Keep high-precision safe features eligible for topology healing
-   [x] Add a 50 mm cadastral regression fixture

## Expanded Evidence-Based Auto Repair

-   [x] Repair isolated top-level Polygon and MultiPolygon crossings before
    ring-orientation quarantine
-   [x] Repair strong outward ring spikes beyond the coordinate tolerance
-   [x] Absorb uniquely edge-adjacent compactness slivers into a dominant
    neighbor
-   [x] Repair unique full-edge inferred gaps with absolute and relative width
    gates
-   [x] Repair unique directional polygon-boundary undershoots and overshoots
-   [x] Reject competing targets, intervening lines, invalid output, and new
    third-party overlaps transactionally
-   [x] Run the same transactional feasibility checks during dry-run so failed
    candidates are shown as manual review before healing starts
-   [x] Run line endpoint healing against final polygon boundaries in the
    worker
-   [x] Add combined cadastral dry-run and actual-repair regressions and verify
    the real worker path

# Phase 2 --- Advanced Topology

-   [x] Shared Boundary Validation
-   [ ] Neighbor Consistency Validation
-   [ ] Boundary Coincidence Validation
-   [ ] Polygon Adjacency Validation
-   [ ] Connectivity Validation

# Phase 3 --- Auto Repair Engine

-   [ ] Confidence Engine
-   [ ] Repair Strategy
-   [ ] Repair Metadata
-   [ ] Rollback Metadata

# Phase 4 --- Worker & Reporting

-   [ ] Validation Report Generator
-   [ ] Repair Report Generator
-   [ ] Structured Error Logs
-   [ ] Statistics Generator
-   [ ] Quality Score
-   [ ] JSON Report Export

# Phase 5 --- Performance

-   [ ] Chunk Processing
-   [ ] Streaming Validation
-   [ ] Parallel Processing
-   [ ] Memory Optimization
-   [ ] Benchmark Suite
-   [ ] Stress Testing

# Phase 6 --- Testing

-   [ ] Unit Test Suite
-   [ ] Integration Test Suite
-   [ ] Regression Test Suite
-   [ ] Stress Dataset
-   [ ] GeoJSON Sample Collection
-   [ ] Invalid Geometry Collection

# Definition of Done

-   [ ] Production-ready implementation
-   [ ] Pipeline integrated
-   [ ] Validation implemented
-   [ ] Auto repair implemented (when applicable)
-   [ ] Unit tests
-   [ ] Integration tests
-   [ ] Regression tests
-   [ ] GeoJSON samples
-   [ ] No regression
-   [ ] Documentation updated
