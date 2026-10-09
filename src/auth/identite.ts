// Qui fait la requête, avec quel rôle, et pour quel client.
// En production et en test, l'e-mail vient exclusivement du jeton Cloudflare Access vérifié.
// En développement local seulement, l'en-tête X-Dev-Email le remplace.

import type { Env } from "../types.ts";
import { HttpError, interdit, nonAutorise } from "../http.ts";
import { verifierJetonAccess, type ChargeurJwks } from "./access-jwt.ts";

export type Role = "admin_whyme" | "operateur_whyme" | "validateur_client" | "lecteur_client";

export interface Identite {
  email: string;
  role: Role;
  /** null pour les comptes WhyMe, l'identifiant du client pour les comptes client. */
  clientId: string | null;
}

export const ROLES_WHYME: readonly Role[] = ["admin_whyme", "operateur_whyme"];
export const ROLES_CLIENT: readonly Role[] = ["validateur_client", "lecteur_client"];
export const estWhyme = (i: Identite) => ROLES_WHYME.includes(i.role);

const HOTES_LOCAUX = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function emailAuthentifie(request: Request, env: Env, chargeur?: ChargeurJwks): Promise<string> {
  if (env.AUTH_MODE === "dev") {
    // Garde-fou : le mode dev n'est accepté que sur une machine locale et hors production.
    const hote = new URL(request.url).hostname;
    if (env.ENVIRONNEMENT === "production" || !HOTES_LOCAUX.has(hote)) {
      throw new HttpError(500, "configuration", "Mode d'authentification dev interdit ici");
    }
    const email = request.headers.get("x-dev-email")?.trim().toLowerCase();
    if (!email) throw nonAutorise();
    return email;
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(503, "configuration", "Cloudflare Access n'est pas encore configuré");
  }
  const jeton = request.headers.get("cf-access-jwt-assertion");
  if (!jeton) throw nonAutorise();
  const email = await verifierJetonAccess(jeton, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, chargeur });
  if (!email) throw nonAutorise("Jeton d'accès invalide");
  return email;
}

function adminsDOffice(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Résout l'identité complète. Un e-mail authentifié mais inconnu de la plateforme n'a aucun accès. */
export async function identifier(request: Request, env: Env, chargeur?: ChargeurJwks): Promise<Identite> {
  const email = await emailAuthentifie(request, env, chargeur);
  if (adminsDOffice(env).has(email)) return { email, role: "admin_whyme", clientId: null };

  const u = await env.DB.prepare("SELECT role, client_id, actif FROM utilisateurs WHERE email = ?")
    .bind(email)
    .first<{ role: Role; client_id: string | null; actif: number }>();
  if (!u || !u.actif) throw interdit("Ce compte n'a pas accès à la plateforme");
  return { email, role: u.role, clientId: u.client_id };
}
