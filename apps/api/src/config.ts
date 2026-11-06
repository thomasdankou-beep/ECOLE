import { createHmac } from 'crypto';
// Configuration lue depuis l'environnement (voir .env.example).
const env = process.env;

function required(name: string, devDefault: string): string {
  const v = env[name];
  if (v) return v;
  if (env.NODE_ENV === 'production') throw new Error(`Variable d'environnement manquante : ${name}`);
  return devDefault;
}

export function paymentProvider(e: NodeJS.ProcessEnv = env): string {
  const wanted = e.PAYMENT_PROVIDER ?? 'sandbox';
  if (wanted === 'sandbox' && e.NODE_ENV === 'production' && e.ALLOW_SANDBOX_PAYMENTS !== 'true') return 'disabled';
  return wanted;
}

export const config = {
  port: Number(env.PORT ?? 4000),
  webOrigin: env.WEB_ORIGIN ?? 'http://localhost:3000',
  publicApiUrl: env.PUBLIC_API_URL ?? 'http://localhost:4000',
  redisUrl: env.REDIS_URL ?? '',
  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET', 'dev-access-secret'),
    refreshSecret: required('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
    accessTtlSeconds: 15 * 60,
    refreshTtlDays: 30,
  },
  encryptionKey: required('APP_ENCRYPTION_KEY', 'ZGV2LWtleS1kZXYta2V5LWRldi1rZXktZGV2LWtleSE='),
  security: {
    maxFailedLogins: 5,
    lockMinutes: 15,
    otpTtlMinutes: 10,
    /// Rôles pour lesquels la double authentification est obligatoire (CDC §6.1).
    twoFactorRoles: ['DIRECTION', 'COMPTABLE', 'SECRETARIAT'],
    /// En développement, la 2FA est proposée mais pas imposée pour ne pas bloquer la démonstration.
    enforceTwoFactor: env.ENFORCE_2FA === 'true',
  },
  payments: {
    /// SEC-005 : en production, le bac à sable (paiements simulés) n'est jamais actif par défaut ; il faut
    /// ALLOW_SANDBOX_PAYMENTS=true pour une démonstration. Sinon le paiement en ligne est fermé (« disabled »)
    /// tant qu'aucun agrégateur réel (CinetPay, PayDunya) n'est configuré.
    provider: paymentProvider(),
    cinetpay: { apiKey: env.CINETPAY_API_KEY ?? '', siteId: env.CINETPAY_SITE_ID ?? '', secretKey: env.CINETPAY_SECRET_KEY ?? '' },
    paydunya: { masterKey: env.PAYDUNYA_MASTER_KEY ?? '', privateKey: env.PAYDUNYA_PRIVATE_KEY ?? '', token: env.PAYDUNYA_TOKEN ?? '' },
  },
  smsProvider: env.SMS_PROVIDER ?? 'console',
  /// Domaine de la plateforme : chaque école est servie sur <slug>.<domaine> (ou sur son propre domaine).
  platformDomain: (env.PLATFORM_DOMAIN ?? '').toLowerCase(),
  /// École servie quand l'adresse ne désigne aucune école (installation à une seule école, développement).
  defaultTenant: env.DEFAULT_TENANT ?? env.TENANT_SLUG ?? '',
  gotenbergUrl: env.GOTENBERG_URL ?? '',
  isProd: env.NODE_ENV === 'production',
  /// Cookie de session réservé au HTTPS ; COOKIE_SECURE=false seulement pour un essai local en http.
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
};

/** Adresse publique d'une école : son domaine propre, sinon son sous-domaine de la plateforme, sinon l'adresse de l'installation. */
export function tenantOrigin(tenant: { slug: string; domain?: string | null }) {
  if (tenant.domain) return `https://${tenant.domain}`;
  if (config.platformDomain) return `https://${tenant.slug}.${config.platformDomain}`;
  return config.webOrigin;
}

/**
 * Clé propre à un usage, dérivée du secret de signature (SEC-012) : une signature de lien de fichier
 * ne peut pas servir pour un autre usage, et inversement.
 */
export function derivedKey(purpose: 'files' | 'sandbox-payments') {
  return createHmac('sha256', config.jwt.refreshSecret).update(`cahiora:${purpose}`).digest();
}
