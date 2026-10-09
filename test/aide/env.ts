// Environnement de test : base simulée, mode d'authentification dev, appels à l'API par e-mail.

import { traiter } from "../../src/index.ts";
import type { Env, R2Bucket } from "../../src/types.ts";
import { creerD1 } from "./d1-local.ts";

export const ADMIN = "admin@whyme.test";

const r2Vide: R2Bucket = {
  async put() { return null; },
  async get() { return null; },
  async delete() {},
};

export function creerEnv(surcharges: Partial<Env> = {}) {
  const db = creerD1();
  const env: Env = {
    DB: db,
    MEDIA: r2Vide,
    ENVIRONNEMENT: "dev",
    AUTH_MODE: "dev",
    ADMIN_EMAILS: ADMIN,
    ...surcharges,
  };
  return { env, db };
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
