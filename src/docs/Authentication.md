# SnapGIS Authentication

SnapGIS stores account records in PostgreSQL through Prisma ORM. Redis stores
rotating refresh sessions and authentication rate-limit counters.

## Local setup

```bash
docker compose up -d
pnpm install
pnpm db:deploy
pnpm seed
pnpm build
pnpm start
```

The Prisma schema is in `prisma/schema.prisma`. Production deployments should
run `pnpm db:deploy` before starting the API. Use `pnpm db:migrate --name <name>`
when creating a development migration after changing the schema.

## Seeded development accounts

| Role | Phone | Password |
| --- | --- | --- |
| Admin | `09120000001` | `SnapGIS.Admin.2026` |
| User | `09120000002` | `SnapGIS.User.2026` |

The seed is idempotent: rerunning it updates these two records without creating
duplicates. These credentials are for local development only.

## Session flow

- `POST /api/auth/register` creates a user and signs them in.
- `POST /api/auth/login` returns a short-lived Bearer access token.
- `POST /api/auth/refresh` rotates the HttpOnly refresh cookie.
- `POST /api/auth/logout` revokes the current refresh session.
- `GET /api/auth/me` returns the current user and requires a Bearer token.

Topology upload, healing, preview, and download endpoints require a valid
access token. Stored analysis jobs are scoped to the user who created them.
