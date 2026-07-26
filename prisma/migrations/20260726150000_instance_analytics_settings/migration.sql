-- CreateTable
CREATE TABLE "instance_analytics_settings" (
    "id" TEXT NOT NULL,
    "db_instance_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_analytics_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instance_analytics_settings_db_instance_id_key" ON "instance_analytics_settings"("db_instance_id");

-- AddForeignKey
ALTER TABLE "instance_analytics_settings" ADD CONSTRAINT "instance_analytics_settings_db_instance_id_fkey" FOREIGN KEY ("db_instance_id") REFERENCES "db_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
