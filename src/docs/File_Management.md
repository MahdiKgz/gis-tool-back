# Authenticated File Management

All file-management endpoints require an access token:

```http
Authorization: Bearer <access-token>
```

The server derives ownership from this token. A client cannot supply or change
the owner ID.

## Read the dashboard summary

```http
GET /api/files/summary
```

Returns the current plan (`free`/`رایگان`), its null expiry and remaining-day
values, and database-aggregated totals for uploaded files, identified issues,
and successfully applied repairs. The issue totals are captured during upload
and updated by the healing worker, so this endpoint does not scan stored
analysis files.

## List the current user's files

```http
GET /api/files?skip=0&limit=10
```

- `skip` defaults to `0`.
- `limit` defaults to `10` and cannot exceed `50`.
- Results are ordered newest first.

The response includes `total` and `hasMore` for pagination. Each row includes
the display name, original filename, upload time, analysis status, healed flag,
and detected issue count.

## Read one file

```http
GET /api/files/:fileId
```

Returns metadata, the full dry-run report, lifecycle timestamps, failure
details, and the public healing result. An unknown file and a file owned by
another user both return `404`.

## Rename a file

```http
PATCH /api/files/:fileId
Content-Type: application/json

{"name":"Updated parcel layer"}
```

Only the user-facing name can be edited. Original file metadata, timestamps,
analysis findings, and healing results are system-managed.

## Delete a file

```http
DELETE /api/files/:fileId
```

The database record, source upload, analysis record, and healed output are
deleted. Files with queued or active healing return `409` and must finish or
fail before deletion.
