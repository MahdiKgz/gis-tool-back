# Dry-Run and Heal API Workflow

The upload and repair lifecycle has two explicit stages. Uploading never
queues or writes a repaired dataset.

## 1. Upload and validate

```http
POST /upload
Content-Type: multipart/form-data
```

Form fields:

- `file` (required): `.geojson`, `.json`, `.kml`, `.kmz`, `.shp`, or `.zip`
- `tolerance` (optional): positive millimeters, default `25`

Successful uploads return `201 Created`:

```json
{
  "success": true,
  "data": {
    "jobId": "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
    "status": "dry-run-complete",
    "report": {
      "mode": "dry-run",
      "valid": false,
      "summary": {
        "featuresScanned": 4,
        "checksRun": 12,
        "issuesFound": 3,
        "affectedFeatures": 2,
        "autoRepairableIssues": 1,
        "manualReviewIssues": 2
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
    "queuedAt": "2026-07-25T09:30:00.000Z"
  }
}
```

Possible errors include:

- `400 INVALID_JOB_ID`
- `404 JOB_NOT_FOUND`
- `410 SOURCE_FILE_EXPIRED`
- `422 INVALID_GIS_FILE`

Uploaded sources, cleaned outputs, and dry-run manifests are removed by the
existing seven-day cleanup policy.
