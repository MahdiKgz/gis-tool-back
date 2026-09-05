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
- `selfIntersections` / `SELF_INTERSECTION`
- `spikes` / `SPIKE`
- `undershoots` / `LINE_UNDERSHOOT`
- `overshoots` / `LINE_OVERSHOOT`

The applied metric and shape thresholds are exposed under
`report.appliedOptions`. `minimumGapWidthMeters` is the inclusive accepted gap
width; `gapToleranceMeters` is the larger maximum auto-repair radius.
Detection can report a high-confidence shape or shared-boundary anomaly beyond
the base repair radius. `AutoRepairAvailable` is restricted to repairs backed
by unambiguous topology: strongly evidenced full-edge gaps, dominant-neighbor
sliver absorption, isolated simple polygon crossings, strong outward spikes,
and line endpoints with one safe target. Ambiguous, destructive, or
post-validation-failing candidates remain `ManualReview`. Dry-run executes the
same repair feasibility boundary against an immutable working copy, so a
candidate that would be rolled back during healing is not advertised as an
available automatic repair.

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
GET /heal/:jobId/events
Accept: text/event-stream
Authorization: Bearer <access-token>
```

The SSE stream immediately emits a `snapshot`, followed by `progress` events
and one terminal `completed`, `failed`, or `cancelled` event. Each data event has an
incrementing per-job ID. The latest 100 events are retained in Redis for 24 hours;
a reconnect with `Last-Event-ID` receives every retained event after that ID. An empty `: heartbeat` comment is written
every 20 seconds to prevent idle proxy timeouts.

Progress events identify the active `parsing`, `error-detection`, `healing`,
or `report-generation` stage and include live `gap`, `sliver`, `kink`, and
`spike` counts. The response body otherwise uses the same lifecycle shape as
the compatibility `GET /heal/:jobId` snapshot endpoint.

The browser client consumes this stream with authenticated `fetch` rather
than native `EventSource`, because the latter cannot attach the Bearer access
token. It reconnects after transient disconnections and sends the most recent
event ID in `Last-Event-ID`.

Completed events include a public repair summary and job-scoped links. The
server-side output path is never exposed:

```json
{
  "success": true,
  "data": {
    "jobId": "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
    "status": "completed",
    "progress": 100,
    "result": {
      "repairsApplied": 6,
      "repairs": {
        "gapsClosed": 1,
        "sliversRemovedCount": 1,
        "selfIntersectionsRepaired": 1,
        "spikesRemoved": 1,
        "undershootsRepaired": 1,
        "overshootsRepaired": 1
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

## 4. Preview, compare, and download

```http
GET /heal/:jobId/output
GET /heal/:jobId/original
GET /heal/:jobId/download
```

`output` serves the healed GeoJSON inline for map rendering. `download`
serves the same bytes with an attachment disposition and the cleaned file
name. Both endpoints require a completed manifest, validate that the stored
file is inside `uploads/cleaned_files`, and return `410 OUTPUT_FILE_EXPIRED`
after cleanup removes it.

`original` converts the retained source upload to GeoJSON without changing it,
allowing the map to overlay the pre-healing geometry. Manual-review decisions
are persisted with `PATCH /heal/:jobId/reviews/:issueIndex` and one of the
`approved`, `rejected`, or `manual-edit` actions.

Queued and active jobs can be cancelled with `POST /heal/:jobId/cancel`.
Waiting jobs are removed from BullMQ and active workers check the cancellation
flag at pipeline boundaries and during feature loops before publishing output.

Possible errors include:

- `400 INVALID_JOB_ID`
- `404 JOB_NOT_FOUND`
- `410 SOURCE_FILE_EXPIRED`
- `409 HEALING_NOT_COMPLETE`
- `410 OUTPUT_FILE_EXPIRED`
- `422 INVALID_GIS_FILE`

Uploaded sources, cleaned outputs, and dry-run manifests are removed by the
existing seven-day cleanup policy.
