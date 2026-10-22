-- AlterTable
ALTER TABLE "students" ADD COLUMN     "photoKey" TEXT;

-- CreateTable
CREATE TABLE "student_files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_files_studentId_idx" ON "student_files"("studentId");

-- AddForeignKey
ALTER TABLE "student_files" ADD CONSTRAINT "student_files_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Isolation par établissement
ALTER TABLE "student_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "student_files" USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
