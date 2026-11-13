-- Lot G4 · réinscription (demande de Dankou du 13 novembre 2026).
-- Une réinscription est une nouvelle inscription de l'année sur le MÊME dossier d'élève : matricule, notes,
-- bulletins, paiements et historique restent attachés à l'élève. Cette migration :
-- - ajoute à l'inscription son type (inscription ou réinscription), la date et le motif de sortie, l'annulation ;
-- - crée l'historique des inscriptions (ajout seul) et le suivi des doublons possibles (décision de la direction) ;
-- - ajoute le site choisi aux pré-inscriptions (GRP-003) ;
-- - interdit, dans la base elle-même, la suppression des élèves, des inscriptions, des factures et des bulletins publiés.
-- Aucune donnée existante n'est modifiée : les nouvelles colonnes sont vides, les nouvelles tables aussi.
-- Tout s'applique en une seule transaction : en cas d'erreur, rien n'est changé.

-- CreateEnum
CREATE TYPE "EnrollmentType" AS ENUM ('NEW', 'RETURNING');

-- CreateEnum
CREATE TYPE "EnrollmentEventKind" AS ENUM ('ENROLLED', 'REENROLLED', 'CLASS_CHANGED', 'TRANSFERRED', 'WITHDRAWN', 'CANCELLED', 'REINSTATED');

-- CreateEnum
CREATE TYPE "DuplicateStatus" AS ENUM ('PENDING', 'DIFFERENT', 'SAME');

-- AlterEnum
ALTER TYPE "EnrollmentStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "enrollments" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" UUID,
ADD COLUMN     "exitDate" DATE,
ADD COLUMN     "exitReason" TEXT,
ADD COLUMN     "type" "EnrollmentType";

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "siteId" UUID;

-- CreateTable
CREATE TABLE "enrollment_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "kind" "EnrollmentEventKind" NOT NULL,
    "data" JSONB,
    "actorId" UUID,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "otherId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DuplicateStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "createdById" UUID,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duplicate_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrollment_events_enrollmentId_createdAt_idx" ON "enrollment_events"("enrollmentId", "createdAt");

-- CreateIndex
CREATE INDEX "duplicate_reviews_tenant_id_status_idx" ON "duplicate_reviews"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_reviews_studentId_otherId_key" ON "duplicate_reviews"("studentId", "otherId");

-- CreateIndex
CREATE INDEX "enrollments_tenant_id_academicYearId_idx" ON "enrollments"("tenant_id", "academicYearId");

-- CreateIndex
CREATE INDEX "applications_tenant_id_siteId_idx" ON "applications"("tenant_id", "siteId");

-- AddForeignKey
ALTER TABLE "enrollment_events" ADD CONSTRAINT "enrollment_events_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_reviews" ADD CONSTRAINT "duplicate_reviews_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_reviews" ADD CONSTRAINT "duplicate_reviews_otherId_fkey" FOREIGN KEY ("otherId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Cohérence de l'annulation : statut « annulée » si et seulement si la date d'annulation est remplie, et toujours avec
-- un motif. (Comparaison en texte : la nouvelle valeur du type n'est utilisable qu'après cette transaction.)
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_cancel_check"
  CHECK ((("status"::text = 'CANCELLED') = ("cancelledAt" IS NOT NULL)) AND ("status"::text <> 'CANCELLED' OR "cancelReason" IS NOT NULL));

-- Doublons : deux dossiers différents, un motif connu, une décision datée dès qu'elle est prise.
ALTER TABLE "duplicate_reviews" ADD CONSTRAINT "duplicate_reviews_pair_check" CHECK ("studentId" <> "otherId");
ALTER TABLE "duplicate_reviews" ADD CONSTRAINT "duplicate_reviews_reason_check" CHECK ("reason" IN ('NOM_NAISSANCE', 'NOM_TELEPHONE'));
ALTER TABLE "duplicate_reviews" ADD CONSTRAINT "duplicate_reviews_decision_check" CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL));

-- Row Level Security des deux nouvelles tables, comme toutes les tables d'école : une école ne voit que ses lignes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enrollment_events', 'duplicate_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

-- Conservation des historiques, garantie par la base même si le code se trompait :
-- - l'historique des inscriptions est en ajout seul (ni modification ni suppression) ;
-- - élèves, inscriptions, factures et décisions sur les doublons ne se suppriment jamais (paiements, reçus et notes
--   l'étaient déjà) ;
-- - un bulletin publié ne se supprime plus (un bulletin non publié peut toujours être recalculé).
CREATE TRIGGER enrollment_events_append_only BEFORE UPDATE OR DELETE ON enrollment_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER enrollments_no_delete BEFORE DELETE ON enrollments FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER students_no_delete BEFORE DELETE ON students FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER duplicate_reviews_no_delete BEFORE DELETE ON duplicate_reviews FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE OR REPLACE FUNCTION forbid_published_report_card_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."publishedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Un bulletin publié ne se supprime pas (table %)', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER report_cards_keep_published BEFORE DELETE ON report_cards FOR EACH ROW EXECUTE FUNCTION forbid_published_report_card_delete();

-- Droits du rôle des écoles : lecture et ajout seulement pour l'historique ; aucune suppression d'élève,
-- d'inscription, de facture ni de décision sur un doublon.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON enrollment_events FROM erp_app;
    REVOKE DELETE, TRUNCATE ON enrollments, students, invoices, duplicate_reviews FROM erp_app;
  END IF;
END $$;

-- Contrôle « même école » sur les nouvelles clés étrangères (SEC-001).
SELECT install_same_tenant_checks();
