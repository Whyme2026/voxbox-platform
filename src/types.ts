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
}

export interface R2Bucket {
  put(key: string, value: ReadableStream | ArrayBuffer | string | null, options?: Record<string, unknown>): Promise<R2Object | null>;
  get(key: string): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
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
}
