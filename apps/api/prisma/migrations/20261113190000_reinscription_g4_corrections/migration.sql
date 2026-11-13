-- Corrections du lot G4 · réinscription (retour de Dankou du 13 novembre 2026).
-- Cette migration :
-- - ajoute à chaque niveau son « niveau suivant » (5e → 4e), défini par la direction, pour proposer la classe d'un
--   élève admis à la réinscription ; vide par défaut : aucune proposition tant que la direction ne l'a pas défini ;
-- - rend l'historique des inscriptions fiable pour le comptage des élèves facturables à une date passée :
--   l'élève, l'année, la date d'inscription et le type d'une inscription ne se modifient plus, et tout changement de
--   classe, d'état, de date de sortie ou d'annulation doit être inscrit dans l'historique au cours de la même
--   transaction, sinon la transaction est refusée.
-- Aucune donnée existante n'est modifiée : la nouvelle colonne est vide. Tout s'applique en une seule transaction.

-- AlterTable
ALTER TABLE "levels" ADD COLUMN     "nextLevelId" UUID;

-- AddForeignKey
ALTER TABLE "levels" ADD CONSTRAINT "levels_nextLevelId_fkey" FOREIGN KEY ("nextLevelId") REFERENCES "levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Un niveau n'est pas son propre niveau suivant.
ALTER TABLE "levels" ADD CONSTRAINT "levels_next_level_check" CHECK ("nextLevelId" IS NULL OR "nextLevelId" <> "id");

-- Les faits de départ d'une inscription ne changent jamais : élève, établissement, année, date d'inscription, type.
CREATE OR REPLACE FUNCTION enrollment_keep_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.tenant_id, OLD."studentId", OLD."academicYearId", OLD."enrolledAt", OLD."type")
     IS DISTINCT FROM (NEW.tenant_id, NEW."studentId", NEW."academicYearId", NEW."enrolledAt", NEW."type") THEN
    RAISE EXCEPTION 'L''élève, l''année, la date et le type d''une inscription ne se modifient pas (inscription %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enrollments_keep_facts BEFORE UPDATE ON enrollments FOR EACH ROW EXECUTE FUNCTION enrollment_keep_facts();

-- Chaque ligne ajoutée à l'historique marque son inscription pour la transaction en cours (réglage local à la
-- transaction : il disparaît à sa fin, et avec un point de sauvegarde annulé).
CREATE OR REPLACE FUNCTION enrollment_journal_mark() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('cahiora.journal', coalesce(current_setting('cahiora.journal', true), '') || ' ' || NEW."enrollmentId"::text, true);
  RETURN NULL;
END $$;
CREATE TRIGGER enrollment_events_mark AFTER INSERT ON enrollment_events FOR EACH ROW EXECUTE FUNCTION enrollment_journal_mark();

-- Contrôle à la validation de la transaction : une inscription dont la classe, l'état, la date de sortie ou
-- l'annulation a changé doit avoir reçu une ligne d'historique dans cette même transaction.
CREATE OR REPLACE FUNCTION enrollment_require_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.status, OLD."classId", OLD."exitDate", OLD."cancelledAt")
     IS DISTINCT FROM (NEW.status, NEW."classId", NEW."exitDate", NEW."cancelledAt")
     AND position(NEW.id::text IN coalesce(current_setting('cahiora.journal', true), '')) = 0 THEN
    RAISE EXCEPTION 'Inscription % modifiée sans ligne dans son historique', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER enrollments_journaled AFTER UPDATE ON enrollments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enrollment_require_journal();

-- Contrôle « même école » sur la nouvelle clé étrangère (SEC-001) : le niveau suivant appartient à la même école.
SELECT install_same_tenant_checks();
