-- Sécurité v1.1, lot 13 (SEC-036) : le journal du Super Admin garde l'adresse IP de chaque action.
-- Ajout d'une colonne vide, sans valeur par défaut : aucune ligne existante n'est modifiée
-- (la table reste en ajout seul, son déclencheur ne s'applique qu'aux UPDATE et DELETE de lignes).
ALTER TABLE "platform_audit_logs" ADD COLUMN "ip" TEXT;
