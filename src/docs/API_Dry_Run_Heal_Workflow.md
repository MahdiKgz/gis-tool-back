# Dry-Run and Heal API Workflow

The upload and repair lifecycle has two explicit stages. Uploading never
queues or writes a repaired dataset.

## 1. Upload and validate

```http
POST /upload
Content-Type: multipart/form-data
```

Form fields:

- `name` (required): a user-facing dataset name between 2 and 150 characters
- `file` (required): `.geojson`, `.json`, `.kml`, `.kmz`, `.shp`, or `.zip`
- `tolerance` (optional): positive millimeters, default `25`

The upload owner is derived from the bearer access token. The endpoint does not
accept a client-selected `userId` because that would allow one user to create
records owned by another user.

Successful uploads return `201 Created`:

```json
{
  "success": true,
  "data": {
    "jobId": "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
    "userId": "9f2107aa-b0b6-4616-b03b-8888d70612a5",
    "name": "Parcel boundaries",
    "status": "dry-run-complete",
    "report": {
      "mode": "dry-run",
      "valid": false,
      "summary": {
        "featuresScanned": 4,
        "checksRun": 18,
        "issuesFound": 3,
        "issueGroups": 1,
        "affectedFeatures": 2,
        "autoRepairableIssues": 1,
        "manualReviewIssues": 2
      },
      "issueGroups": [
        {
          "groupId": "tinyPolygons:TINY_POLYGON",
          "check": "tinyPolygons",
          "code": "TINY_POLYGON",
          "issueCount": 3,
          "affectedFeatureCount": 2,
          "affectedFeatureIndexes": [1, 3],
          "affectedFeatureIds": ["parcel-7", "parcel-9"],
          "geometryTypes": ["Polygon"],
          "disposition": "ManualReview"
        }
      ],
      "affectedFeatureCollection": {
        "type": "FeatureCollection",
        "features": [
          {
            "type": "Feature",
            "id": "parcel-7",
            "properties": {},
            "geometry": {
              "type": "Polygon",
              "coordinates": [
                [
                  [51.4, 35.7],
                  [51.5, 35.7],
                  [51.5, 35.8],
                  [51.4, 35.8],
                  [51.4, 35.7]
                ]
              ]
            },
            "snapgisFeatureIndex": 1
          }
        ]
      },
      "issues": []
    },
    "heal": {
      "method": "POST",
      "path": "/heal/6c2d5ee6-9852-4ddd-86db-f62582ef93de"
    }
  }
}
```

Each item in `report.issues` identifies its validation check, issue code,
feature index and ID, geometry type, geometry-collection path, and applicable
coordinate or polygon paths. `disposition` indicates whether the healing
pipeline has a conservative automatic repair or whether manual review is
required.

Relational findings such as polygon gaps and line endpoint topology also
include `relatedFeatureIndex`, `relatedFeatureId`, and related coordinate or
polygon paths. Both sides are included in the issue group's affected feature
indexes and in `affectedFeatureCollection`.

Dry-run includes these topology checks:

- `overlaps` / `POLYGON_OVERLAP`
- `gaps` / `POLYGON_GAP`
- `slivers` / `SLIVER_POLYGON`
- `undershoots` / `LINE_UNDERSHOOT`
- `overshoots` / `LINE_OVERSHOOT`

The applied metric and shape thresholds are exposed under
`report.appliedOptions`. Detection can report a high-confidence shape or
shared-boundary anomaly beyond the repair tolerance. Such findings are
`ManualReview`; `AutoRepairAvailable` remains restricted to safe endpoint or
gap movements inside the supplied millimetre tolerance.

Use `report.issueGroups` for the frontend error list. It contains one item per
`check` and `code` combination, regardless of whether the same problem affects
two or two thousand features. `issueCount` retains the total finding count,
while `affectedFeatureIndexes` identifies every geometry to highlight.
`report.issues` remains the detailed drill-down list and is not intended to be
rendered as the primary error list.

`report.affectedFeatureCollection` is directly renderable GeoJSON. It contains
each affected feature once, with its complete original geometry and coordinate
arrays. The `snapgisFeatureIndex` foreign member links the rendered feature
back to every matching item in `report.issues`.

The dry run is read-only. It does not modify the uploaded file, write a
cleaned file, or add a BullMQ job.

## 2. Queue healing

```http
POST /heal/:jobId
```

Use the `jobId` returned by `/upload`. A successful request returns
`202 Accepted` and queues one BullMQ job named `heal-gis-file`. The dry-run ID
is also used as the BullMQ job ID, making repeated requests idempotent.

```json
{
  "success": true,
  "data": {
    "jobId": "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
    "dryRunJobId": "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
    "status": "queued",
    "progress": 0,
    "queuedAt": "2026-07-25T09:30:00.000Z"
  }
}
```

The analysis manifest is updated before the job is added, preventing a fast
worker from racing the queued state. Worker events persist `processing`
progress, terminal completion data, and final failure after retry exhaustion.
Completed BullMQ jobs may therefore be removed without losing client-visible
state.

## 3. Track healing

```http
GET /heal/:jobId
```

The endpoint returns one of `dry-run-complete`, `queued`, `processing`,
`completed`, or `failed`, together with numeric progress and lifecycle
timestamps. Clients can poll this endpoint while the status is queued or
processing.

Completed responses include a public repair summary and job-scoped links. The
server-side output path is never exposed:

```json
{
  "success": true,
  "data": {
    "jobId": "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
    "status": "completed",
    "progress": 100,
    "result": {
      "repairsApplied": 7,
      "repairs": {
        "gapsClosed": 2,
        "overlapsHealed": 1,
        "duplicateVerticesRemoved": 4
      },
      "output": {
        "fileName": "cleaned-source.geojson",
        "previewPath": "/heal/6c2d5ee6-9852-4ddd-86db-f62582ef93de/output",
        "downloadPath": "/heal/6c2d5ee6-9852-4ddd-86db-f62582ef93de/download"
      }
    }
  }
}
```

## 4. Preview and download

```http
GET /heal/:jobId/output
GET /heal/:jobId/download
```

`output` serves the healed GeoJSON inline for map rendering. `download`
serves the same bytes with an attachment disposition and the cleaned file
name. Both endpoints require a completed manifest, validate that the stored
file is inside `uploads/cleaned_files`, and return `410 OUTPUT_FILE_EXPIRED`
after cleanup removes it.

Possible errors include:

- `400 INVALID_JOB_ID`
- `404 JOB_NOT_FOUND`
- `410 SOURCE_FILE_EXPIRED`
- `409 HEALING_NOT_COMPLETE`
- `410 OUTPUT_FILE_EXPIRED`
- `422 INVALID_GIS_FILE`

Uploaded sources, cleaned outputs, and dry-run manifests are removed by the
existing seven-day cleanup policy.
