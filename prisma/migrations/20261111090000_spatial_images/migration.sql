-- CreateEnum
CREATE TYPE "SpatialImageStatus" AS ENUM ('uploading', 'processing', 'ready', 'failed', 'deleting');

-- CreateTable
CREATE TABLE "spatial_images" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "uploader_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "size" BIGINT NOT NULL,
    "status" "SpatialImageStatus" NOT NULL DEFAULT 'uploading',
    "upload_etag" TEXT,
    "error_code" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spatial_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "spatial_images_company_id_created_at_idx" ON "spatial_images"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "spatial_images_status_expires_at_idx" ON "spatial_images"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "spatial_images" ADD CONSTRAINT "spatial_images_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spatial_images" ADD CONSTRAINT "spatial_images_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

