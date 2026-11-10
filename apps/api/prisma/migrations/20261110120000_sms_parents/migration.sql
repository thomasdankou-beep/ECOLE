-- SMS aux familles (paiement, absence) : journal des SMS envoyés.
-- Ajout seulement : une table nouvelle, aucune ligne existante modifiée.

-- CreateTable
CREATE TABLE "sms_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "segments" INTEGER NOT NULL DEFAULT 1,
    "studentId" UUID,
    "userId" UUID,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sms_messages_tenant_id_createdAt_idx" ON "sms_messages"("tenant_id", "createdAt");

-- Isolation par école (RLS), comme toutes les tables d'école.
ALTER TABLE "sms_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sms_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_messages" USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
