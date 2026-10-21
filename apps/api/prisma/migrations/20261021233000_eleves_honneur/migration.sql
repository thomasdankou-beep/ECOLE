-- CreateTable
CREATE TABLE "public_honors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "reportCardId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "className" TEXT NOT NULL,
    "termLabel" TEXT NOT NULL,
    "average" DECIMAL(5,2),
    "showAverage" BOOLEAN NOT NULL DEFAULT true,
    "distinction" TEXT,
    "photoKey" TEXT,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_honors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "public_honors_reportCardId_key" ON "public_honors"("reportCardId");

-- AddForeignKey
ALTER TABLE "public_honors" ADD CONSTRAINT "public_honors_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Isolation par établissement
ALTER TABLE "public_honors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_honors" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "public_honors" USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
