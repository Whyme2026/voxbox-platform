// Environnement de test : base simulée, mode d'authentification dev, appels à l'API par e-mail.

import { traiter } from "../../src/index.ts";
import type { Env, R2Bucket } from "../../src/types.ts";
import { creerD1 } from "./d1-local.ts";

export const ADMIN = "admin@whyme.test";

/** Stockage R2 en mémoire : garde les objets pour que les tests puissent les vérifier. */
export function creerR2(): R2Bucket & { objets: Map<string, { taille: number; type?: string }> } {
  const objets = new Map<string, { taille: number; type?: string }>();
  return {
    objets,
    async put(key, value, options) {
      const taille = value instanceof ArrayBuffer ? value.byteLength : typeof value === "string" ? value.length : 0;
      const type = (options?.httpMetadata as { contentType?: string } | undefined)?.contentType;
      objets.set(key, { taille, type });
      return { key, size: taille };
    },
    async get(key) {
      const o = objets.get(key);
      return o ? { key, size: o.taille } : null;
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objets.delete(k);
    },
  };
}

export function creerEnv(surcharges: Partial<Env> = {}) {
  const db = creerD1();
  const media = creerR2();
  const env: Env = {
    DB: db,
    MEDIA: media,
    ENVIRONNEMENT: "dev",
    AUTH_MODE: "dev",
    ADMIN_EMAILS: ADMIN,
    ...surcharges,
  };
  return { env, db, media };
}

export interface Reponse<T = any> { status: number; corps: T }

export function client(env: Env) {
  return async function appel<T = any>(methode: string, chemin: string, email?: string, corps?: unknown): Promise<Reponse<T>> {
    const headers: Record<string, string> = {};
    if (email) headers["x-dev-email"] = email;
    if (corps !== undefined) headers["content-type"] = "application/json";
    const res = await traiter(
      new Request(`http://localhost${chemin}`, { method: methode, headers, body: corps === undefined ? undefined : JSON.stringify(corps) }),
      env,
    );
    return { status: res.status, corps: (await res.json()) as T };
  };
}
