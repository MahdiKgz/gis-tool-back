CREATE TABLE "analyses" ("id" UUID PRIMARY KEY, "payload" JSONB NOT NULL);
CREATE TABLE "storage_uploads" (
  "id" UUID PRIMARY KEY, "user_id" UUID NOT NULL, "key" TEXT NOT NULL,
  "original_name" TEXT NOT NULL, "size" INTEGER NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL, "claimed_at" TIMESTAMPTZ(6)
);
CREATE INDEX "storage_uploads_expires_at_idx" ON "storage_uploads"("expires_at");
