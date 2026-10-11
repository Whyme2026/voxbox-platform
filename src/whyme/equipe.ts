// Équipe WhyMe de l'espace RH (/rh/, protégé par Cloudflare Access comme Parlorama, mais avec ses propres comptes).
// Un compte Parlopop (table utilisateurs, ADMIN_EMAILS) n'ouvre pas l'espace RH, et un compte RH n'ouvre pas
// Parlorama : les deux activités sont cloisonnées.

import type { Env } from "../types.ts";
import { interdit } from "../http.ts";
import { emailAuthentifie } from "../auth/identite.ts";

export type RoleRh = "admin_rh" | "operateur_rh";
export interface IdentiteRh { email: string; role: RoleRh }

/** gerer : campagnes, clients, entreprises, recruteurs, interviews ; equipe : comptes de l'équipe RH. */
export type ActionRh = "gerer" | "equipe";

const MATRICE: Record<RoleRh, readonly ActionRh[]> = {
  admin_rh: ["gerer", "equipe"],
  operateur_rh: ["gerer"],
};

function adminsDOffice(env: Env): Set<string> {
  return new Set((env.RH_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export async function identifierRh(request: Request, env: Env): Promise<IdentiteRh> {
  const email = await emailAuthentifie(request, env);
  if (adminsDOffice(env).has(email)) return { email, role: "admin_rh" };
  const m = await env.DB.prepare("SELECT role FROM rh_equipe WHERE email = ? AND actif = 1").bind(email).first<{ role: RoleRh }>();
  if (!m) throw interdit("Ce compte n'a pas accès à l'espace RH Why me");
  return { email, role: m.role };
}

export async function exigerRh(request: Request, env: Env, action: ActionRh): Promise<IdentiteRh> {
  const id = await identifierRh(request, env);
  if (!MATRICE[id.role].includes(action)) throw interdit();
  return id;
}
