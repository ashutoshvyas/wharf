-- CreateEnum
CREATE TYPE "EmailTemplateFlow" AS ENUM ('confirmation', 'recovery', 'magic_link', 'invite', 'email_change', 'reauthentication');

-- CreateTable
CREATE TABLE "instance_email_templates" (
    "id" TEXT NOT NULL,
    "db_instance_id" TEXT NOT NULL,
    "flow" "EmailTemplateFlow" NOT NULL,
    "subject" TEXT,
    "body_html" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instance_email_templates_db_instance_id_flow_key" ON "instance_email_templates"("db_instance_id", "flow");

-- AddForeignKey
ALTER TABLE "instance_email_templates" ADD CONSTRAINT "instance_email_templates_db_instance_id_fkey" FOREIGN KEY ("db_instance_id") REFERENCES "db_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
