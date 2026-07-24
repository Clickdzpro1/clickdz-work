-- CreateTable
CREATE TABLE "cdz_erp_seq" (
    "slug" VARCHAR NOT NULL,
    "doc_type" VARCHAR NOT NULL,
    "year" INTEGER NOT NULL,
    "value" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdz_erp_seq_pkey" PRIMARY KEY ("slug", "doc_type", "year")
);
