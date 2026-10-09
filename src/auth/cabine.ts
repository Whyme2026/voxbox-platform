// Authentification des tablettes. Une cabine est appairée une fois avec un code court affiché dans
// l'espace WhyMe ; elle reçoit alors un jeton secret qu'elle garde. Seule l'empreinte du jeton est stockée.

import type { D1Database } from "../types.ts";
import { nonAutorise } from "../http.ts";

export interface CabineAuthentifiee {
  id: string;
  nom: string;
  campagne_id: string | null;
}

function b64url(octets: Uint8Array): string {
  let s = "";
  for (const o of octets) s += String.fromCharCode(o);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function nouveauJeton(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function empreinteJeton(jeton: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jeton));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Code aléatoire lisible (sans O/0 ni I/1). */
export function codeAleatoire(longueur: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const octets = crypto.getRandomValues(new Uint8Array(longueur));
  return [...octets].map((o) => alphabet[o % alphabet.length]).join("");
}

export async function authentifierCabine(request: Request, db: D1Database): Promise<CabineAuthentifiee> {
  const entete = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]{32,64})$/.exec(entete);
  if (!m) throw nonAutorise("Cabine non appairée");
  const cab = await db.prepare("SELECT id, nom, campagne_id FROM cabines WHERE jeton_hash = ?")
    .bind(await empreinteJeton(m[1]!))
    .first<CabineAuthentifiee>();
  if (!cab) throw nonAutorise("Jeton de cabine inconnu ou révoqué");
  return cab;
}
