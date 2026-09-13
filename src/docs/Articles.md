# SnapGIS Articles

Users start without publishing access. An administrator can grant or revoke the
`writer` role. Authorization checks always read current database roles.

Writers manage only their own articles under `/api/articles/writer/mine`.
Articles are either `draft` or `published`; only published records are returned
by public endpoints. Keywords are normalized and stored as individual values so
the public feed can filter by an exact keyword. Categories are aggregated from
published articles.

The public list uses an opaque cursor with deterministic
`publishedAt DESC, id DESC` ordering. Clients must use `nextCursor` unchanged.
