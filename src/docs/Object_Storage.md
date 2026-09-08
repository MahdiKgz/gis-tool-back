# MinIO object storage

SnapGIS can use a private S3-compatible bucket instead of backend-local durable files.
`STORAGE_DRIVER=s3` enables this path; `local` exists for legacy development/test compatibility.
Production startup requires S3 and an HTTPS public endpoint. Geometry processing still uses bounded,
private temporary files because GDAL and the CAD tools need filesystem paths; those workspaces are
not durable storage and are removed after use. No frontend geometry parsing is introduced.

## Layout and ownership

Until Organizations/Members exist, the authenticated user ID is the tenant namespace. The API
never accepts a tenant ID, filesystem path, or arbitrary object key from the browser.

```
snapgis-files/
  {userId}/{jobId}/original/{originalFilename}
  {userId}/{jobId}/normalized/input.geojson
  {userId}/{jobId}/healed/{outputFilename}
  temporary/incoming/{userId}/{uploadId}/incoming/{filename}
  temporary/conversions/{userId}/{conversionId}/conversion/{filename}
```

Original bytes are retained separately from normalized WGS84 data and healed output. Analysis
metadata and reports live in PostgreSQL (`analyses`), not local JSON files. Row locks protect
concurrent lifecycle/review writes across processes; immutable reports are stored separately so
progress writes do not reserialize/rewrite them. `uploaded_files.storage_path` and worker payloads
store `s3://bucket/key` references, never presigned URLs. Application credentials are bucket-scoped,
while the API enforces each user's ownership before resolving an object or issuing a URL.

## Local setup

1. Configure `.env` from `.env.example`. Generate DIFFERENT root and application secrets, for example
   `openssl rand -base64 48`. Never commit `.env` or copy root credentials to the API/Python service.
2. `docker compose up -d minio minio-init`
3. `pnpm db:deploy`
4. Migrate existing files as below before switching a populated installation to `STORAGE_DRIVER=s3`.
5. Start/restart the API with `pnpm dev` or `pnpm build && pnpm start`.

S3 API: `http://localhost:9000`; console: `http://localhost:9001`. Both bind to loopback.
The init service creates a private bucket, a dedicated app user, bucket-scoped GetObject/PutObject/
DeleteObject permissions, and a lifecycle policy for `temporary/` only. It manages this bucket's
lifecycle configuration: merge any custom rules into `ops/minio-init.sh` before rerunning setup.
Pin/upgrade the images deliberately after testing. Persistent files live in Docker volume `minio_data`.
`S3_ENDPOINT` is the internal URL used by Node; `S3_PUBLIC_ENDPOINT` must be reachable by the browser.
Inside another Docker container, use `http://minio:9000` on the same network for the internal endpoint.

## API compatibility and direct uploads

The existing authenticated multipart `POST /api/upload` still works (250 MiB limit). It spools only
for parsing, stores original and normalized objects, commits metadata, then removes local files.
This means current clients continue working without a frontend release.

Optional direct-to-MinIO flow, requiring Bearer authentication on the two API calls:

1. `POST /api/upload/presign` with JSON `{ "fileName": "parcels.zip", "size": 12345 }`.
   Response 201 `data`: `{uploadId, method: "POST", url, fields, expiresAt, completePath}`.
2. POST multipart FormData to `url`, appending EVERY returned `fields` entry and the file LAST.
   Do not send the API Bearer token to MinIO. The policy fixes the exact key and byte length (1 byte–250 MiB).
3. `POST completePath?report=compact` with JSON `{name, tolerance, sourceCrs}`.
   CAD requires `sourceCrs` as in multipart intake. The response is the existing dry-run response.
   Each completion is atomically claimed once (409 on replay); expired tickets return 410 and another
   user's ticket returns 404. A failed claimed submission requires a new ticket. Reposting to the
   temporary object cannot modify the original/normalized snapshots that were already accepted.

Presigned upload/download permissions expire after 15 minutes. Preview/download API URLs remain
stable and authenticated; S3-mode original/healed GETs return 302 to a fresh signed GET URL.
Clients must follow redirects and MinIO must allow the frontend's origin through CORS.
Export conversion still returns binary plus `X-Conversion-Result`, or a 202 receipt. Queued inputs
and outputs are object-backed; workers create their own temporary directories. Downloads preserve
Content-Disposition and conversion report headers. The accepted conversion retains its own source
snapshot if a user deletes the original analysis.

**Correction to the supplied guide:** `content-length-range` is a POST policy condition, not a
presigned PUT URL option. We use `@aws-sdk/s3-presigned-post`. See the primary references:
[AWS POST policies](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html)
and [createPresignedPost](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-presigned-post/Function/createPresignedPost3/).

## Migration

Pause ingress and drain active healing before migrating. Back up PostgreSQL and the legacy upload
directory. First inventory, then copy and verify:

```
pnpm storage:migrate
pnpm storage:migrate --apply
# If the checkout was relocated, explicitly authorize its former root:
pnpm storage:migrate --apply --legacy-root=/absolute/old/repository
```

The tool checks owner/job identities, validates managed paths, uploads originals, normalized input
and available healed outputs, downloads each object and compares SHA-256, then commits that file's
metadata/reference changes in a DB transaction. Re-running skips already migrated rows. It never
deletes legacy files. Missing legacy sources/reports are counted separately, never invented.
Switch to `STORAGE_DRIVER=s3` and restart only after the apply summary and representative previews/
downloads are verified. Do not accept uploads during the switch. Keep the DB backup and legacy files
for rollback; blindly switching the driver back after new S3 uploads will not recover those uploads.

## Lifecycle, backup, TLS and Python

* Durable originals, normalized inputs and healed objects do not have an automatic expiry. Deleting
  an owned inactive file removes its objects before metadata, so storage failures leave a retryable
  record. Existing local cleanup remains only for legacy local files.
* Temporary incoming/conversion objects expire through MinIO's `temporary/` lifecycle after two days.
  Conversion API access still expires after 24 hours. Lifecycle cleanup is asynchronous, not an exact
  second-level deletion SLA. Pending upload-ticket DB records are removed by the daily cleanup.
* Configure `CORS_ORIGIN` to the actual frontend origins; `MINIO_API_CORS_ALLOW_ORIGIN` inherits it.
* Use `ops/nginx-storage.conf` with a real storage hostname, certificates and
  `certbot --nginx -d storage.yourdomain.com`. Preserve the Host header: signatures depend on it.
  Public DNS/certificates are deployment-specific; localhost setup does not provision them.
  Leave the console private or use an SSH tunnel; do not expose port 9001 directly on production hosts.
* Configure an independent backup target with `mc alias set backup-target ...`; run
  `mc mirror snapgis/snapgis-files backup-target/snapgis-files-backup` on your backup schedule.
  Avoid `--remove` unless you deliberately want deletions mirrored. Also back up PostgreSQL because
  object contents alone do not contain ownership, display names and current lifecycle metadata.
  Verify restores before swapping endpoints. No backup destination/scheduler is created implicitly.
* Existing Python CAD/conversion scripts operate on temporary files supplied by Node. A future standalone
  Python raster service can use `boto3.client('s3', endpoint_url=..., region_name='us-east-1',
  aws_access_key_id=..., aws_secret_access_key=..., config=Config(s3={'addressing_style':'path'}))`
  with the same scoped app credentials and authorized object keys, rather than root credentials.

## Verification

`pnpm test`, `pnpm build`, `pnpm test:conversion`; `pnpm test:storage` additionally requires local
MinIO, migrated PostgreSQL and the CAD/GDAL runtime. The storage suite creates an isolated test user
and keys, exercises actual direct uploads (including oversize rejection), GeoJSON/DWG/DGN dry-run and
healing, private/owned previews, each export format, a >5 MiB queued export, terminal-state races,
vertex report preservation and deletion, then cleans only its test data.
