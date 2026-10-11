// Purge à échéance (Parlobox) : les textes acceptés par le visiteur promettent la suppression de ses vidéos au bout
// de la durée de conservation de la campagne (sessions.purge_prevue_le, fixée à la création de la session).
// À l'échéance, tout ce qui se rattache à la session est effacé (vidéos, miniatures, Parlomix où elle figure,
// réponses, transcriptions, thèmes classés, choix) ; il ne reste qu'une trace anonyme (date, campagne, cabine) et une
// ligne de journal sans prénom. Lancée par la tâche planifiée toutes les 5 minutes, par paquets, reprise sans risque.
// Why me a sa propre purge (src/whyme/taches.ts).

import type { D1Database, Env } from "../types.ts";
import { maintenant } from "../http.ts";
import { ligneJournal } from "../journal.ts";
import { effacementSession } from "./retrait.ts";

export const QUI = "purge automatique";
/** Sessions traitées par passage : borne la durée d'une exécution planifiée. */
export const PAQUET = 40;

export interface BilanPurge { sessions: number; videos: number; parlomix: number; erreurs: number }

export async function purgerEchues(env: Env, opts: { maintenant?: string; limite?: number } = {}): Promise<BilanPurge> {
  const t = opts.maintenant ?? maintenant();
  const bilan: BilanPurge = { sessions: 0, videos: 0, parlomix: 0, erreurs: 0 };
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.campagne_id, s.retiree_le, c.client_id FROM sessions s JOIN campagnes c ON c.id = s.campagne_id
      WHERE s.purgee_le IS NULL AND s.purge_prevue_le <= ? ORDER BY s.purge_prevue_le LIMIT ${Math.max(1, Math.min(opts.limite ?? PAQUET, 200))}`,
  ).bind(t).all<{ id: string; campagne_id: string; retiree_le: string | null; client_id: string }>();
  for (const s of results) {
    try {
      const e = await effacementSession(env, s);
      await env.DB.batch([
        ...e.ecritures,
        env.DB.prepare(
          `UPDATE sessions SET purgee_le = ?, prenom = '(supprimé)', nom = NULL, email = NULL, recontact = 0, consent_diffusion = 0
            WHERE id = ? AND purgee_le IS NULL`,
        ).bind(t, s.id),
        ligneJournal(env.DB, QUI, {
          action: "session.purge", cibleType: "session", cibleId: s.id, clientId: s.client_id,
          details: { campagne_id: s.campagne_id, videos_supprimees: e.videos, parlomix_supprimes: e.montages, deja_retiree: Boolean(s.retiree_le) },
        }),
      ]);
      bilan.sessions++;
      bilan.videos += e.videos;
      bilan.parlomix += e.montages;
    } catch (err) {
      // Une session en échec (stockage indisponible) sera reprise au passage suivant ; les autres continuent.
      console.error("Purge", s.id, (err as Error).message);
      bilan.erreurs++;
    }
  }
  // Demandes d'accès par e-mail de plus d'un jour (déjà effacées à chaque nouvelle demande ; ici, même sans demande).
  await env.DB.prepare("DELETE FROM acces_visiteur WHERE cree_le < ?").bind(new Date(Date.parse(t) - 86_400_000).toISOString()).run();
  return bilan;
}

/** Prochaine échéance d'une campagne : date de la prochaine purge et nombre de visiteurs concernés dans les 30 jours. */
export async function prochainePurge(db: D1Database, campagneId: string, t = maintenant()) {
  const dans30 = new Date(Date.parse(t) + 30 * 86_400_000).toISOString();
  const r = await db.prepare(
    `SELECT MIN(purge_prevue_le) AS prochaine, SUM(purge_prevue_le <= ?) AS sous_30_jours, COUNT(*) AS restantes
       FROM sessions WHERE campagne_id = ? AND purgee_le IS NULL`,
  ).bind(dans30, campagneId).first<{ prochaine: string | null; sous_30_jours: number | null; restantes: number }>();
  const purgees = await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE campagne_id = ? AND purgee_le IS NOT NULL").bind(campagneId).first<{ n: number }>();
  return { prochaine: r?.prochaine ?? null, sous_30_jours: r?.sous_30_jours ?? 0, restantes: r?.restantes ?? 0, purgees: purgees?.n ?? 0 };
}
