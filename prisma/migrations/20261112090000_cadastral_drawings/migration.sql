CREATE TABLE "cadastral_drawings" (
    "image_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "features" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "cadastral_drawings_pkey" PRIMARY KEY ("image_id", "user_id")
);
CREATE INDEX "cadastral_drawings_user_id_idx" ON "cadastral_drawings"("user_id");
ALTER TABLE "cadastral_drawings" ADD CONSTRAINT "cadastral_drawings_image_id_fkey"
    FOREIGN KEY ("image_id") REFERENCES "spatial_images"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cadastral_drawings" ADD CONSTRAINT "cadastral_drawings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
