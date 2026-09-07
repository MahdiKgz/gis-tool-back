# CAD map response performance

`POST /api/upload?report=compact` and `GET /api/files/:fileId?report=compact`
return the existing summary, issue groups, affected geometry and options unchanged.
The verbose `checks` are omitted (represented as `{}`). `issues` contains manual-review
marker entries only, with empty `details` and an explicit **original** `issueIndex`.
Clients must never infer the original issue identity from its position in this array.
`issueDetails: {paginated: true, total}` advertises the full issue count.

`GET /api/heal/:jobId/issues?page=1&limit=25&code=EXCESSIVE_COORDINATE_PRECISION`
returns `{success: true, data: {items, page, limit, total}}`. `code` is optional;
filtering happens before pagination. `limit` is 1–100; `page` is a positive safe
integer with a safe offset. Every item retains its complete diagnostic details
and stable `issueIndex`. Authentication and ownership checks match the healing
endpoints: unauthenticated requests fail with 401 and another owner's job with 404.

The frontend now requests compact mode and loads diagnostic pages only when the
user expands details, both in map results and the dashboard file dialog. Other
clients can omit the query parameter to retain the existing full-report contract.
Full reports remain on disk; dry-run detection, CAD tessellation/CRS conversion,
healing inputs and exact geometry have not changed. Manual marker geometry comes
from the already-loaded affected collection; original geometry is fetched only
when the user requests its overlay.

## Measured sample

Existing DWG: 19,695 upload bytes, 30 features, 25,265 coordinate positions.
The serialized public report falls from **60,423,937 to 1,041,315 bytes** (about
98.3% smaller), preserving all geometry and counts. The compact response includes
16 manual markers; all 50,561 issues remain accessible through the paginated API.
These are uncompressed JSON sizes, not network transfer measurements.

This change reduces browser transfer/parse/state overhead. Stored analysis reads
still parse the complete on-disk analysis; it does not introduce a new server-side
storage format or promise bounded memory for arbitrarily large manual-review
collections. Geometry and compact marker counts still scale with the dataset.

## Verification

- Projection test: unchanged analytical report, geometry and counts; stable IDs;
  removal of bulky diagnostics and substantial serialized size reduction.
- Pagination test: filtered totals, original indices, full details, empty pages,
  malformed/oversized/unsafe query rejection.
- Controller/persistence integration: owner access, cross-owner isolation,
  missing authentication and invalid pagination.
- Full backend suite: 238 passed, 11 native opt-in tests skipped; production build passed.
