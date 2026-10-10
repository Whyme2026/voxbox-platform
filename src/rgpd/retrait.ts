// Retrait d'accord d'un visiteur, à sa demande (lien de retrait) ou à la demande de la marque (Parlorama).
// Retrait total : vidéos, miniatures, réponses et Parlomix où la personne apparaît sont supprimés ; il ne reste
// qu'une trace anonyme de la session et de la date du retrait. Retrait de diffusion : les vidéos restent pour
// l'usage interne, mais plus aucun montage où elle figure n'est diffusable.

import type { D1Database, Env } from "../types.ts";
import type { Identite } from "../auth/identite.ts";
import { conflit, maintenant } from "../http.ts";
import { ligneJournal } from "../journal.ts";

export interface SessionARetirer { id: string; campagne_id: string; client_id: string; consent_diffusion: number; retiree_le: string | null }

/** Session et client à partir de son identifiant ou de son code de retrait. */
export async function sessionPour(db: D1Database, colonne: "id" | "code_retrait", valeur: string) {
  return db.prepare(
    `SELECT s.id, s.campagne_id, s.consent_diffusion, s.retiree_le, c.client_id
       FROM sessions s JOIN campagnes c ON c.id = s.campagne_id WHERE s.${colonne} = ?`,
  ).bind(valeur).first<SessionARetirer>();
}

export async function retirerAccord(env: Env, qui: Identite | string, s: SessionARetirer, origine: "visiteur" | "parlorama") {
  if (s.retiree_le) throw conflit("L'accord a déjà été retiré");
  const { results: videos } = await env.DB.prepare("SELECT cle_source, cle_16_9, cle_9_16, cle_miniature FROM reponses WHERE session_id = ?").bind(s.id)
    .all<{ cle_source: string | null; cle_16_9: string | null; cle_9_16: string | null; cle_miniature: string | null }>();
  const { results: montages } = await env.DB.prepare("SELECT id, cle, cle_miniature FROM parlomix WHERE campagne_id = ? AND sessions LIKE ?")
    .bind(s.campagne_id, `%"${s.id}"%`).all<{ id: string; cle: string | null; cle_miniature: string | null }>();
  // Fichiers d'abord : si le stockage échoue, rien n'est marqué comme supprimé et l'opération peut être refaite.
  const cles = [
    ...videos.flatMap((v) => [v.cle_source, v.cle_16_9, v.cle_9_16, v.cle_miniature]),
    ...montages.flatMap((m) => [m.cle, m.cle_miniature]),
  ].filter((c): c is string => Boolean(c));
  if (cles.length) await env.MEDIA.delete(cles);
  const now = maintenant();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reponses WHERE session_id = ?").bind(s.id),
    ...montages.map((m) => env.DB.prepare("DELETE FROM parlomix WHERE id = ?").bind(m.id)),
    env.DB.prepare("UPDATE sessions SET retiree_le = ?, prenom = '(retiré)', nom = NULL, email = NULL, recontact = 0, consent_diffusion = 0 WHERE id = ?").bind(now, s.id),
    ligneJournal(env.DB, qui, {
      action: "session.retrait", cibleType: "session", cibleId: s.id, clientId: s.client_id,
      details: { campagne_id: s.campagne_id, origine, videos_supprimees: videos.length, parlomix_supprimes: montages.length },
    }),
  ]);
  return { retiree_le: now, videos_supprimees: videos.length, parlomix_supprimes: montages.length };
}

export async function retirerDiffusion(env: Env, qui: Identite | string, s: SessionARetirer, origine: "visiteur" | "parlorama") {
  if (s.retiree_le) throw conflit("L'accord a déjà été retiré");
  if (!s.consent_diffusion) throw conflit("La diffusion publique n'avait pas été acceptée");
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET consent_diffusion = 0 WHERE id = ?").bind(s.id),
    env.DB.prepare("UPDATE parlomix SET diffusable = 0 WHERE campagne_id = ? AND sessions LIKE ?").bind(s.campagne_id, `%"${s.id}"%`),
    ligneJournal(env.DB, qui, { action: "session.diffusion_retiree", cibleType: "session", cibleId: s.id, clientId: s.client_id, details: { campagne_id: s.campagne_id, origine } }),
  ]);
}
