# SnapGIS Processing Engine Backlog

> This document defines the implementation roadmap for the SnapGIS
> processing engine.

## Development Order

-   [ ] Phase 1 --- Processing Engine
-   [ ] Phase 2 --- Advanced Topology
-   [ ] Phase 3 --- Auto Repair Engine
-   [ ] Phase 4 --- Worker & Reporting
-   [ ] Phase 5 --- Performance
-   [ ] Phase 6 --- Testing

------------------------------------------------------------------------

# Current Status

## Completed

### Geometry

-   [x] Self Intersection Detection
-   [x] Self Intersection Repair
-   [x] Polygon Overlap Detection
-   [x] Multi-pass Overlap Repair
-   [x] Gap Detection
-   [x] Sliver Detection
-   [x] Undershoot Repair
-   [x] Overshoot Repair
-   [x] Duplicate Polygon Detection
-   [x] Duplicate Vertex Detection and Safe Repair
-   [x] Invalid Ring Detection and Safe Repair
-   [x] Ring Closure Validation and Safe Auto-Close

### Infrastructure

-   [x] RBush Spatial Index
-   [x] BullMQ Worker
-   [x] GeoJSON Support
-   [x] KML Support
-   [x] KMZ Support
-   [x] Background Processing

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

-   [ ] Validate exterior ring orientation
-   [ ] Validate interior ring orientation
-   [ ] Normalize orientation

## GEO-005 Invalid Hole Validation

### Detection

-   [ ] Hole Outside Polygon
-   [ ] Nested Hole
-   [ ] Duplicate Hole
-   [ ] Self Intersecting Hole
-   [ ] Hole Touching Boundary
-   [ ] Tiny Hole
-   [ ] Hole Larger Than Polygon

### Repair

-   [ ] Remove tiny holes
-   [ ] Remove outside holes
-   [ ] Normalize hole orientation

## GEO-006 Spike Detection

-   [ ] Detect spikes
-   [ ] Configurable tolerance
-   [ ] Auto repair

## GEO-007 Zero Area Polygon Detection

-   [ ] Detect zero-area polygons

## GEO-008 Tiny Polygon Detection

-   [ ] Detect tiny polygons

## GEO-009 Collapsed Polygon Detection

-   [ ] Detect collapsed polygons after repair

## GEO-010 Geometry Type Validation

-   [ ] Validate geometry types

## GEO-011 Geometry Dimension Validation

-   [ ] Validate geometry dimensions

## GEO-012 Multipart Geometry Validation

-   [ ] Validate MultiPolygon integrity

## GEO-013 Coordinate Precision Validation

-   [ ] Coordinate precision
-   [ ] Floating point robustness

# Phase 2 --- Advanced Topology

-   [ ] Shared Boundary Validation
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
