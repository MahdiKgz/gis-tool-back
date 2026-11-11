# Email verification and password recovery

Set `APP_PUBLIC_ORIGIN` to the public frontend origin, `SMTP_URL` to the SMTP relay URL and `SMTP_FROM` to an authorized sender. Use HTTPS for the frontend in production and SMTP with STARTTLS or implicit TLS. The frontend host must serve the SPA for direct navigation to `/auth/reset` and `/dashboard/security`. Run `pnpm db:deploy` before starting the new backend. Existing accounts can sign in with their mobile number and add an email in **امنیت حساب**.

All endpoints below are under `/api/auth`.

| Method and path | Body | Response |
| --- | --- | --- |
| GET `/email` | | Bearer authentication. Returns `data` containing `email`, `emailVerifiedAt` and `pendingEmail`. |
| POST `/email` | `email`, current `password` | Bearer authentication. Sends a 30-minute verification link and returns the account email state. |
| POST `/email/verify` | `token` | Bearer authentication for the account that requested the link. Returns the updated email state. |
| POST `/forgot-password` | `email` | Returns 202 for any well-formed email when mail is configured. Sends a 15-minute reset link only to a verified address. An active reset link remains valid until used or expired. |
| POST `/reset-password` | `token`, new `password` | Returns 204 on success. The link is consumed, the refresh cookie is cleared and existing refresh sessions become invalid. Issued access tokens expire according to `JWT_ACCESS_TTL`. |

Confirmation replaces the previous verified email and invalidates its reset link. A failed SMTP delivery releases the corresponding token so the request can be retried.

With a migrated test database and Redis available, run the recovery integration test using a local SMTP fixture:

```sh
pnpm test:compile
AUTH_RECOVERY_INTEGRATION=1 node --test dist-test/services/account-recovery.integration.test.js
```
