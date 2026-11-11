ALTER TABLE "users"
    ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "email" VARCHAR(254),
    ADD COLUMN "email_verified_at" TIMESTAMPTZ(6),
    ADD COLUMN "pending_email" VARCHAR(254),
    ADD COLUMN "email_token_hash" TEXT,
    ADD COLUMN "email_token_expires" TIMESTAMPTZ(6),
    ADD COLUMN "reset_token_hash" TEXT,
    ADD COLUMN "reset_token_expires" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_reset_token_hash_key" ON "users"("reset_token_hash");
