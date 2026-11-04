# Admin user management and system reports

All routes below are mounted under `/api/business` and require a valid access token plus the **current database** `admin` role. Read responses use `Cache-Control: no-store`. Token role claims alone do not grant access. The additive `20261104090000_admin_report_date_indexes` migration adds creation-date indexes for global account/upload reporting; it changes no tables, columns or stored data. Apply it using `pnpm db:deploy` before rollout.

## User management

- `GET /admin/users?search=&plan=&role=&skip=0&limit=10` retains the existing plan-management endpoint. `search` matches name or phone (including Persian/Arabic digits), up to 100 characters. `plan` accepts `starter`, `pro`, `advanced`; empty means all. `role` accepts `user`, `writer`, `admin`; empty means all. Role filtering means membership in the roles array, so an administrator may also have the `user` role. Maximum limit is 50.
- Response `data` is `{items: AdminUser[], pagination:{skip,limit,total}}`.
- `AdminUser` is `{id,name,phone,createdAt,roles,planCode,plan,usage:{uploads,bytes,identifiedIssues,healedIssues},storedFiles}`. Usage is all-time upload activity, including subsequently deleted uploads. `storedFiles` counts currently retained upload records. Passwords and storage details are never selected.
- `GET /admin/users/:userId` returns `{user:AdminUser,recentFiles:FileMetadata[]}`. The latest ten **retained** files are ordered by creation time descending, with UUID as a stable tie-breaker.
- `PATCH /admin/users/:userId` requires `{name,phone}` and returns `AdminUser`. Name is trimmed, 2–100 characters, and excludes control characters. Phone supports Persian/Arabic digits and is normalized to an 11-digit Iranian mobile number starting `09`. Every other body property is rejected, including roles, plans, password and identifiers. Duplicate normalized phone numbers return `409 PHONE_ALREADY_EXISTS`. Roles, password hash and plan are preserved. Profile editing does not rename an existing company.
- Writer access uses the existing `PATCH /admin/users/:userId/writer-role` with `{enabled:boolean}` and returns `{userId,roles}`. There is no general role setter and no new capability to grant administrator access, create, suspend or delete accounts.

`FileMetadata` is `{id,name,originalName,healStatus,sizeInBytes,identifiedIssues,healedIssues,createdAt}`. Detail views do not expose file contents or add download access.

## Reports

`GET /admin/reports?from=YYYY-MM-DD&to=YYYY-MM-DD` accepts strict Gregorian dates. Dates are inclusive UTC calendar days. Default end is today UTC; default start is 29 days before the selected end. Reversed, impossible or greater-than-366-day ranges return `400 INVALID_REPORT_RANGE`.

Response `data`:

```ts
{
  range: {from: string, to: string, timeZone: "UTC"},
  summary: {
    users: number, newUsers: number, companies: number, activeCompanies: number,
    uploads: number, bytes: number, identifiedIssues: number, healedIssues: number,
    storedFiles: number, deletedFiles: number,
    completed: number, failed: number, processing: number
  },
  plans: [{code: "starter" | "pro" | "advanced", name: string, count: number}],
  statuses: [{status: string, count: number}],
  daily: [{date: string, uploads: number, completed: number, failed: number,
           bytes: number, identifiedIssues: number, healedIssues: number}],
  recentFailures: [(FileMetadata & {user: {id: string, name: string}})]
}
```

- `users`, `companies`, `activeCompanies` and `plans` are current global snapshot counts; active companies have an owner whose assigned plan is `advanced`. `newUsers` counts accounts created in the requested period.
- All upload totals, statuses and daily rows use **upload creation date** in the requested range. Activity snapshots preserve deleted-file history. `storedFiles` counts retained records created in the range; `deletedFiles` counts upload snapshots created in the range whose `deletedAt` is set.
- `completed` and `failed` represent current status for those uploads. There is no completion-event timestamp in upload activity, so these are not completion events on each calendar day. `processing` includes `queued` and `processing`.
- Every UTC date in the range appears in `daily`, including zero-activity days. Date grouping is performed in PostgreSQL, avoiding loading all uploads into process memory.
- `recentFailures` contains at most ten currently retained failed files created in the range, newest first, with safe metadata and current owner name. Deleted failures remain in totals but have no retained filename metadata to show.
- Each read uses a repeatable-read transaction for a consistent database snapshot; list usage is grouped for only the requested page of accounts.

## Verification

`pnpm run test:business` compiles and runs real PostgreSQL service/HTTP checks with `.env`. Tests create and clean up only their own fixtures. The admin suite exercises authentication, current database roles despite stale token claims, profile validation and duplicate conflict handling, writer-role reuse, cumulative deleted history, safe metadata, pagination, strict UTC date limits and inclusive boundaries. `admin-inputs.test.ts` additionally covers Persian phones, forbidden profile fields, leap dates, defaults and the 366-day limit in the generic test suite.
