// Types minimaux des services Cloudflare utilisés par la plateforme.
// Volontairement réduits à ce que le code utilise : pas de dépendance externe à installer.

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number; [k: string]: unknown };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface R2Object {
  key: string;
  size: number;
  body?: ReadableStream;
  httpMetadata?: { contentType?: string };
}

export interface R2Bucket {
  put(key: string, value: ReadableStream | ArrayBuffer | string | null, options?: Record<string, unknown>): Promise<R2Object | null>;
  get(key: string, options?: { range?: { offset: number; length?: number } }): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  /** Métadonnées d'un objet (taille) sans son contenu ; null s'il n'existe pas. */
  head(key: string): Promise<R2Object | null>;
}

export interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type AuthMode = "access" | "dev";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS?: Fetcher;
  ENVIRONNEMENT: "dev" | "test" | "production";
  AUTH_MODE: AuthMode;
  /** E-mails (séparés par des virgules) qui sont administrateurs WhyMe d'office. */
  ADMIN_EMAILS?: string;
  /** Domaine d'équipe Cloudflare Access, ex. https://whyme.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience (AUD) de l'application Cloudflare Access qui protège la plateforme. */
  ACCESS_AUD?: string;
  /** Clé d'API Brevo (secret Cloudflare) pour les e-mails transactionnels ; absente : pas d'envoi hors développement. */
  BREVO_CLE?: string;
  /** Adresse d'expédition des e-mails (domaine vérifié chez Brevo). */
  COURRIEL_EXPEDITEUR?: string;
  /** Why me : adresse d'expédition des e-mails aux candidats et recruteurs (domaine vérifié chez Brevo). */
  COURRIEL_EXPEDITEUR_WHYME?: string;
  /** Why me : adresse du service de montage (conteneur ffmpeg en UE) ; absente : montages en attente. */
  MONTAGE_URL?: string;
  /** Why me : liaison interne vers le Worker voxbox-montage (Cloudflare refuse qu'un Worker appelle l'adresse
   *  workers.dev d'un autre Worker du même compte). Prioritaire sur MONTAGE_URL. */
  MONTAGE_SERVICE?: Fetcher;
  /** Why me : secret partagé avec le service de montage (secret Cloudflare). */
  MONTAGE_CLE?: string;
  /**
   * Clé d'API Mistral AI (secret Cloudflare, formule payante du compte WhyMe) pour l'option Analyse.
   * Absente : aucune réponse n'est envoyée, les transcriptions restent « à faire ».
   */
  MISTRAL_API_KEY?: string;
  /** Version déployée du Worker (liaison « version_metadata » de Cloudflare) : change à chaque déploiement. */
  VERSION_DEPLOIEMENT?: { id: string; tag?: string; timestamp?: string };
}
