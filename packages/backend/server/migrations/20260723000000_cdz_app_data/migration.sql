-- CreateTable
CREATE TABLE "cdz_app_data" (
    "slug" VARCHAR NOT NULL,
    "collection" VARCHAR NOT NULL,
    "record_id" VARCHAR NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdz_app_data_pkey" PRIMARY KEY ("slug", "collection", "record_id")
);

-- CreateIndex
CREATE INDEX "cdz_app_data_slug_collection_idx" ON "cdz_app_data" ("slug", "collection");
