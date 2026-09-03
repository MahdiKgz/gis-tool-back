CREATE TABLE "uploaded_files" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "stored_file_name" VARCHAR(255) NOT NULL,
    "storage_path" TEXT NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_in_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploaded_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "uploaded_files_user_id_created_at_idx"
ON "uploaded_files"("user_id", "created_at");

ALTER TABLE "uploaded_files"
ADD CONSTRAINT "uploaded_files_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
