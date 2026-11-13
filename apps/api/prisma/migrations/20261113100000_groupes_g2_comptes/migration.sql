-- Lot G2 · comptes et connexion de la console du groupe (plan validé le 12 novembre 2026, décisions D-G4 et D-G5).
-- Ajoute trois tables : comptes du groupe, codes de récupération, sessions. Aucune donnée existante n'est
-- modifiée et aucun compte n'est créé : le Super Admin crée lui-même le premier compte de chaque groupe.
-- Tout s'applique en une seule transaction : en cas d'erreur, rien n'est changé.

-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('GENERAL', 'FINANCIER', 'PEDAGOGIQUE');

-- CreateTable
CREATE TABLE "group_accounts" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "GroupRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "passwordChangedAt" TIMESTAMP(3),
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totpLastStep" INTEGER,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_accounts_pkey" PRIMARY KEY ("id"),
    -- Un identifiant de connexion au moins : téléphone ou e-mail.
    CONSTRAINT "group_accounts_identifier_check" CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL),
    -- Double authentification obligatoire (D-G5) : un compte qui l'a activée a forcément un secret.
    CONSTRAINT "group_accounts_totp_check" CHECK (NOT "totpEnabled" OR "totpSecret" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "group_recovery_codes" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_sessions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "group_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_accounts_phone_key" ON "group_accounts"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "group_accounts_email_key" ON "group_accounts"("email");

-- CreateIndex
CREATE INDEX "group_accounts_group_id_idx" ON "group_accounts"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_accounts_id_group_id_key" ON "group_accounts"("id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_recovery_codes_account_id_codeHash_key" ON "group_recovery_codes"("account_id", "codeHash");

-- CreateIndex
CREATE INDEX "group_sessions_account_id_idx" ON "group_sessions"("account_id");

-- AddForeignKey : un groupe qui a des comptes ne peut pas être supprimé (les comptes ne sont jamais effacés).
ALTER TABLE "group_accounts" ADD CONSTRAINT "group_accounts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "school_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey : clé composée (compte, groupe), un code ou une session ne peut pas porter un autre groupe que son compte.
ALTER TABLE "group_recovery_codes" ADD CONSTRAINT "group_recovery_codes_account_id_group_id_fkey" FOREIGN KEY ("account_id", "group_id") REFERENCES "group_accounts"("id", "group_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_sessions" ADD CONSTRAINT "group_sessions_account_id_group_id_fkey" FOREIGN KEY ("account_id", "group_id") REFERENCES "group_accounts"("id", "group_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security : le rôle du groupe ne voit et n'écrit que les lignes de son groupe de session (app.group_id),
-- le rôle de la plateforme gère les comptes de tous les groupes, le rôle des écoles n'a aucun droit.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['group_accounts', 'group_recovery_codes', 'group_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO erp_owner USING (true) WITH CHECK (true)', t || '_owner_all', t);
    EXECUTE format($p$CREATE POLICY %I ON %I TO PUBLIC USING (current_user = 'erp_platform') WITH CHECK (current_user = 'erp_platform')$p$, t || '_platform_all', t);
    EXECUTE format($p$CREATE POLICY %I ON %I TO PUBLIC
      USING (current_user = 'erp_group' AND group_id = app_current_group())
      WITH CHECK (current_user = 'erp_group' AND group_id = app_current_group())$p$, t || '_group_own', t);
  END LOOP;
END $$;

-- Journal du groupe : les comptes du groupe y écrivent leurs propres actions (connexions, comptes), dans leur
-- groupe seulement et toujours sous leur nom (« group »), jamais au nom de la plateforme ou de Cahiora.
CREATE POLICY group_audit_group_insert ON group_audit_logs FOR INSERT TO PUBLIC
  WITH CHECK (current_user = 'erp_group' AND group_id = app_current_group() AND "actorKind" = 'group');

-- Les écoles (erp_app) n'ont aucun droit sur les nouvelles tables (droits par défaut retirés, comme au lot G1).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE ALL ON group_accounts, group_recovery_codes, group_sessions FROM erp_app;
  END IF;
END $$;

-- Connexion : le groupe d'un compte n'est pas connu avant la connexion, et le rôle du groupe ne lit rien hors de
-- son groupe de session. Cette fonction renvoie seulement le numéro du compte et celui de son groupe, pour un
-- identifiant donné (e-mail, ou téléphones possibles d'un numéro local) ; jamais son mot de passe ni ses données.
CREATE OR REPLACE FUNCTION group_login_lookup(p_email text, p_phones text[]) RETURNS TABLE (account_id uuid, group_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.group_id FROM group_accounts a
  WHERE (p_email IS NOT NULL AND a.email = lower(p_email))
     OR a.phone = ANY (COALESCE(p_phones, ARRAY[]::text[]))
  ORDER BY a."createdAt"
  LIMIT 5
$$;
REVOKE ALL ON FUNCTION group_login_lookup(text, text[]) FROM PUBLIC;

-- Rôle de la plateforme : droits des lots précédents, plus la gestion des comptes de groupe (création, désactivation,
-- remise d'un accès) ; il ne lit jamais une session ouverte ailleurs que pour la révoquer.
CREATE OR REPLACE FUNCTION grant_platform_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_platform') THEN
    RAISE NOTICE 'Rôle erp_platform absent : droits non attribués (poste de développement)';
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO erp_platform;
  GRANT EXECUTE ON FUNCTION app_current_tenant() TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON tenants TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON platform_admins TO erp_platform;
  GRANT SELECT, INSERT ON platform_audit_logs TO erp_platform;
  GRANT SELECT ON students TO erp_platform;
  GRANT SELECT, INSERT ON sites TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON users TO erp_platform;
  GRANT SELECT, INSERT ON user_roles TO erp_platform;
  GRANT SELECT, UPDATE ON sessions TO erp_platform;
  GRANT INSERT ON audit_logs TO erp_platform;
  GRANT SELECT, INSERT, UPDATE, DELETE ON platform_recovery_codes TO erp_platform;
  GRANT SELECT, INSERT, UPDATE ON two_factor_recovery_requests TO erp_platform;
  GRANT SELECT, DELETE ON recovery_codes TO erp_platform;
  GRANT INSERT ON notifications TO erp_platform;
  -- Groupes scolaires (lot G1) : fiche, rattachement des écoles, journal du groupe (en ajout seul).
  GRANT EXECUTE ON FUNCTION app_current_group() TO erp_platform;
  GRANT SELECT, INSERT, UPDATE, DELETE ON school_groups TO erp_platform;
  GRANT SELECT, INSERT ON group_audit_logs TO erp_platform;
  -- Comptes de la console des groupes (lot G2).
  GRANT SELECT, INSERT, UPDATE ON group_accounts TO erp_platform;
  GRANT SELECT, DELETE ON group_recovery_codes TO erp_platform;
  GRANT SELECT, UPDATE ON group_sessions TO erp_platform;
END $$;

-- Rôles des groupes (créés par infra/postgres/roles-groupes.sh) :
-- - erp_group : console du groupe. Lecture de sa fiche (sans les notes internes), d'une liste réduite de colonnes
--   de ses écoles et de son journal ; ses propres comptes, codes et sessions ; aucune table d'école ;
-- - erp_stats : calcul des chiffres agrégés (lots G3 et G5). Pour l'instant, aucun droit sur aucune table.
CREATE OR REPLACE FUNCTION grant_group_roles() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_group') THEN
    GRANT USAGE ON SCHEMA public TO erp_group;
    GRANT EXECUTE ON FUNCTION app_current_group() TO erp_group;
    GRANT EXECUTE ON FUNCTION group_login_lookup(text, text[]) TO erp_group;
    GRANT SELECT (id, name, "legalName", promoter, phone, email, address, country, "taxId", status, "createdAt", "updatedAt") ON school_groups TO erp_group;
    GRANT SELECT, INSERT ON group_audit_logs TO erp_group;
    -- L'adresse publique de chaque école (son domaine propre) s'ajoute aux colonnes du lot G1.
    GRANT SELECT (id, slug, name, "shortName", country, currency, status, domain, group_id, "groupJoinedAt") ON tenants TO erp_group;
    GRANT SELECT, INSERT, UPDATE ON group_accounts TO erp_group;
    GRANT SELECT, INSERT, UPDATE, DELETE ON group_recovery_codes TO erp_group;
    GRANT SELECT, INSERT, UPDATE ON group_sessions TO erp_group;
  ELSE
    RAISE NOTICE 'Rôle erp_group absent : droits non attribués (poste de développement)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_stats') THEN
    GRANT USAGE ON SCHEMA public TO erp_stats;
  ELSE
    RAISE NOTICE 'Rôle erp_stats absent : droits non attribués (poste de développement)';
  END IF;
END $$;

SELECT grant_platform_role();
SELECT grant_group_roles();
