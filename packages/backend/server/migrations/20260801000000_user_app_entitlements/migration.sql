-- CreateTable
CREATE TABLE "user_app_entitlements" (
    "id" VARCHAR NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "app" VARCHAR NOT NULL,
    "plan" VARCHAR NOT NULL DEFAULT 'manual',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reason" VARCHAR,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_app_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_app_entitlements_user_id_app_key" ON "user_app_entitlements" ("user_id", "app");

-- CreateIndex
CREATE INDEX "user_app_entitlements_user_id_idx" ON "user_app_entitlements" ("user_id");

-- AddForeignKey
ALTER TABLE "user_app_entitlements" ADD CONSTRAINT "user_app_entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
