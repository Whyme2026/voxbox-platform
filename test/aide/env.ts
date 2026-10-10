// Environnement de test : base simulée, mode d'authentification dev, appels à l'API par e-mail.

import { traiter } from "../../src/index.ts";
import type { Env, R2Bucket } from "../../src/types.ts";
import { creerD1 } from "./d1-local.ts";

export const ADMIN = "admin@whyme.test";

/** Stockage R2 en mémoire : garde les objets pour que les tests puissent les vérifier. */
export function creerR2(): R2Bucket & { objets: Map<string, { taille: number; type?: string; octets: Uint8Array }> } {
  const objets = new Map<string, { taille: number; type?: string; octets: Uint8Array }>();
  return {
    objets,
    async put(key, value, options) {
      const octets = value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new TextEncoder().encode(typeof value === "string" ? value : "");
      const type = (options?.httpMetadata as { contentType?: string } | undefined)?.contentType;
      objets.set(key, { taille: octets.byteLength, type, octets });
      return { key, size: octets.byteLength };
    },
    async get(key, options) {
      const o = objets.get(key);
      if (!o) return null;
      const r = options?.range;
      const octets = r ? o.octets.slice(r.offset, r.length === undefined ? undefined : r.offset + r.length) : o.octets;
      return { key, size: o.taille, body: new Response(octets).body ?? undefined, httpMetadata: { contentType: o.type } };
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
