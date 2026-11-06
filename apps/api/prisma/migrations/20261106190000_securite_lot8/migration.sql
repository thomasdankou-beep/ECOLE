-- Sécurité v1.1, étape 3, lot 8 (SEC-021, SEC-022).
-- Ajout de colonnes facultatives uniquement : aucune donnée existante n'est modifiée ni supprimée.

-- SEC-022 : pas de temps du dernier code de double authentification accepté (un code ne sert qu'une fois).
ALTER TABLE "users" ADD COLUMN "totpLastStep" INTEGER;

-- SEC-021 : double authentification du Super Admin et déconnexion qui coupe vraiment la session.
ALTER TABLE "platform_admins"
  ADD COLUMN "totpSecret"        TEXT,
  ADD COLUMN "totpEnabled"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "totpLastStep"      INTEGER,
  ADD COLUMN "sessionsRevokedAt" TIMESTAMP(3);
