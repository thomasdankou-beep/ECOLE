-- CreateEnum
CREATE TYPE "AnnualOutcome" AS ENUM ('ADMIS', 'NON_ADMIS');

-- CreateTable
CREATE TABLE "annual_decisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "outcome" "AnnualOutcome" NOT NULL,
    "note" TEXT,
    "decidedById" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "annual_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "annual_decisions_studentId_academicYearId_key" ON "annual_decisions"("studentId", "academicYearId");

-- AddForeignKey
ALTER TABLE "annual_decisions" ADD CONSTRAINT "annual_decisions_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Isolation par établissement
ALTER TABLE "annual_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "annual_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "annual_decisions" USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
