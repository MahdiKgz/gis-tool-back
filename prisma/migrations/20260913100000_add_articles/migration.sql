CREATE TYPE "ArticleStatus" AS ENUM ('draft', 'published');

CREATE TABLE "articles" (
  "id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "slug" VARCHAR(220) NOT NULL,
  "excerpt" VARCHAR(360) NOT NULL,
  "content" TEXT NOT NULL,
  "cover_image_url" VARCHAR(1000),
  "category" VARCHAR(80) NOT NULL,
  "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "ArticleStatus" NOT NULL DEFAULT 'draft',
  "published_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "articles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "articles_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "articles_slug_key" ON "articles"("slug");
CREATE INDEX "articles_author_id_updated_at_idx" ON "articles"("author_id", "updated_at");
CREATE INDEX "articles_author_id_status_idx" ON "articles"("author_id", "status");
CREATE INDEX "articles_status_published_at_idx" ON "articles"("status", "published_at");
CREATE INDEX "articles_category_status_idx" ON "articles"("category", "status");
CREATE INDEX "articles_keywords_gin_idx" ON "articles" USING GIN ("keywords");
