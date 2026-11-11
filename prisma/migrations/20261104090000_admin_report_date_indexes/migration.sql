-- Global administrator reports filter upload/account creation dates across all owners.
CREATE INDEX "users_created_at_idx" ON "users"("created_at");
CREATE INDEX "uploaded_files_created_at_idx" ON "uploaded_files"("created_at");
CREATE INDEX "upload_activity_created_at_idx" ON "upload_activity"("created_at");
