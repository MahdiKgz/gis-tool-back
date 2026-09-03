ALTER TABLE "uploaded_files"
ADD COLUMN "heal_status" VARCHAR(24) NOT NULL DEFAULT 'dry-run-complete',
ADD COLUMN "identified_issues" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "healed_issues" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "uploaded_files"
ADD CONSTRAINT "uploaded_files_identified_issues_nonnegative_check"
CHECK ("identified_issues" >= 0),
ADD CONSTRAINT "uploaded_files_healed_issues_nonnegative_check"
CHECK ("healed_issues" >= 0),
ADD CONSTRAINT "uploaded_files_heal_status_check"
CHECK (
  "heal_status" IN (
    'dry-run-complete',
    'queued',
    'processing',
    'completed',
    'failed'
  )
);

CREATE INDEX "uploaded_files_user_id_heal_status_idx"
ON "uploaded_files"("user_id", "heal_status");
