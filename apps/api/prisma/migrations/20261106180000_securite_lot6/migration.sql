-- Sécurité v1.1, étape 2, lot 6 (SEC-015) : l'annulation d'un reçu est demandée par le comptable
-- et n'a lieu qu'après validation par la direction (matrice RBAC : Comptable C, Direction V).
-- Trois colonnes facultatives ajoutées ; aucune donnée existante n'est modifiée ni supprimée.
ALTER TABLE "receipts"
  ADD COLUMN "cancelRequestedAt"   TIMESTAMP(3),
  ADD COLUMN "cancelRequestedById" UUID,
  ADD COLUMN "cancelRequestReason" TEXT;
