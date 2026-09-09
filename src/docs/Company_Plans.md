# Plans and company workspaces

Each user has a persisted `planCode`: `starter` (default), `pro`, or `advanced`.
The catalog retains the three existing marketing prices; `advanced` is the GIS
company plan. Assignment is performed by a current database `admin` role via
`/dashboard/admin/plans`, with a `plan_assignments` audit record for each change.
Neither registration nor profile input can grant a plan. Prices are informational:
this release does not implement payments, billing periods, pricing edits, or the
marketing page's processing/storage quotas.

## Company workflow

At `/dashboard/company`, an advanced-plan owner can rename the company, review
team statistics and add up to three colleagues, in addition to themselves.

1. Look up a registered account using an exact Iranian mobile number (Persian and
   Arabic digits are supported). Only name, phone and account creation date appear.
2. Review that card and confirm sending an invitation.
3. Membership activates only after the colleague accepts. Invitations appear
   in the colleague's dashboard with a navigation badge and accept/decline actions.
   No SMS or email is sent. Pending invitations reserve a seat for seven days;
   expiry releases it without a scheduled job. Owners can revoke invitations.

Legacy `mode: "direct"` requests are rejected with 400; omitted mode (or legacy
`mode: "invite"`) creates only an invitation. Existing memberships are preserved.

A user can belong to only one company and cannot own a company while also being
an employee elsewhere. Company row locks serialize capacity changes; user row
locks serialize cross-company membership and upload attribution. Database unique
constraints backstop one ownership/membership per user. Candidate eligibility and
capacity are rechecked on confirmation. Members can leave; owners can remove them.

Downgrading an owner preserves the company, members and history, but suspends
new additions, invitation acceptance and company attribution for new uploads.
Restoring advanced reactivates the same workspace. The employee's personal plan
is preserved, with `effectivePlan` reflecting active company membership.

## Activity and privacy

`upload_activity` snapshots the active company when an upload record is persisted
following successful dry-run processing. The upload and its activity row are
atomic. Failed intake rolls both back. Existing uploads are backfilled as personal
activity only. Joining never exposes earlier personal files or their metrics.

Healing updates identified/healed issue totals; deletion marks the activity as
deleted instead of removing it. Overall company totals include former colleagues
and deleted files. The current-member table shows their attributed historical
activity, including previous membership periods in the same company. `storedFiles`
counts currently retained upload records; bytes count cumulative uploaded bytes,
not MinIO disk usage or conversion exports. Standalone conversion jobs are not
counted as topology uploads. Retrying healing updates the same upload, not a second
activity. A member's later personal uploads are excluded after leaving.

Only the owner can read company-wide statistics. Membership does not grant access
to colleagues' file contents, previews or downloads; existing owner checks stay
in place. Members manage their own files. Totals may update on the next 30-second
refresh after a background job finishes.

## API

All paths below are relative to `/api/business`; except `GET /plans`, they require
a Bearer token. JSON responses use `{success: true, data}`.

| Method | Path | Access / body |
| --- | --- | --- |
| GET | /plans | Public plan catalog |
| GET | /me | Personal/effective plan, own membership and incoming invitations |
| GET | /admin/users | Admin; `search`, `plan`, `skip`, `limit` (1–50) |
| PATCH | /admin/users/:userId/plan | Admin; `{planCode}` |
| GET | /company | Owner; team, seats, aggregate and per-member metrics |
| PATCH | /company | Owner; `{name}` (2–150 characters) |
| POST | /company/lookup | Active owner; `{phone}`; rate limited |
| POST | /company/members | Active owner; `{userId}` |
| DELETE | /company/members/:userId | Owner removes member, or member leaves |
| DELETE | /company/invitations/:invitationId | Owner revokes pending invitation |
| POST | /invitations/:invitationId/respond | Invitee; `{action: "accept" | "decline"}` |

Validation errors are 400; permission failures 403; unavailable resources 404;
capacity, duplicate and membership conflicts 409; expired invitations 410.
Admin checks read current database roles rather than trusting stale JWT roles.

## Deployment and verification

Run `pnpm db:deploy`, regenerate Prisma/build, and restart the API and worker.
Migration `20260909100000_company_plans` is additive and assigns starter to existing
accounts. An admin must explicitly assign advanced to activate a company; no
existing account is automatically upgraded.

- `STORAGE_DRIVER=local pnpm test`: generic regression suite and business validators.
- `pnpm test:business`: real PostgreSQL integration suite using `.env`. Creates
  uniquely identified test accounts/records and deletes only those records afterward.
  Tests real seat races, simultaneous acceptances, permissions, deletion/leave
  history, downgrade/reactivation and HTTP authentication.
- `pnpm test:storage`: dedicated MinIO integration tests for the S3 environment.

The generic upload/conversion fixtures expect local storage; they should be run
with `STORAGE_DRIVER=local` even when the deployment `.env` uses S3.
