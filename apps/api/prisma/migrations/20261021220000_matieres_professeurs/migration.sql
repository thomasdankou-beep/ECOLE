-- CreateTable
CREATE TABLE "teacher_subjects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,

    CONSTRAINT "teacher_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teacher_subjects_teacherId_subjectId_key" ON "teacher_subjects"("teacherId", "subjectId");

-- AddForeignKey
ALTER TABLE "teacher_subjects" ADD CONSTRAINT "teacher_subjects_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_subjects" ADD CONSTRAINT "teacher_subjects_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Isolation par établissement
ALTER TABLE "teacher_subjects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teacher_subjects" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "teacher_subjects" USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
