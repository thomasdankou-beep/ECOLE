-- CreateEnum
CREATE TYPE "RoomKind" AS ENUM ('CLASSROOM', 'WORKSHOP', 'LAB', 'OTHER');

-- CreateEnum
CREATE TYPE "InternshipStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- AlterTable
ALTER TABLE "rooms" ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "kind" "RoomKind" NOT NULL DEFAULT 'CLASSROOM';

-- AlterTable
ALTER TABLE "subjects" ADD COLUMN     "practical" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "internship_periods" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "levelId" UUID,
    "trackId" UUID,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internship_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internship_placements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "periodId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "company" TEXT NOT NULL,
    "companyAddress" TEXT,
    "companyPhone" TEXT,
    "tutorName" TEXT,
    "tutorPhone" TEXT,
    "status" "InternshipStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internship_placements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "internship_periods_tenant_id_academicYearId_idx" ON "internship_periods"("tenant_id", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "internship_placements_periodId_studentId_key" ON "internship_placements"("periodId", "studentId");

-- AddForeignKey
ALTER TABLE "internship_periods" ADD CONSTRAINT "internship_periods_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internship_placements" ADD CONSTRAINT "internship_placements_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "internship_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internship_placements" ADD CONSTRAINT "internship_placements_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Isolation des établissements sur les nouvelles tables (même règle que la migration rls).
ALTER TABLE internship_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE internship_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON internship_periods USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE internship_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE internship_placements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON internship_placements USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
