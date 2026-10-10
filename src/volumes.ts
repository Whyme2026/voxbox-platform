// Volume de stockage d'une campagne : vidéos des réponses, miniatures et Parlomix (stockage R2, UE).
// La taille de chaque fichier est notée à l'envoi ; les fichiers envoyés avant la migration 0006 sont mesurés
// après coup (métadonnées du stockage, sans lire le contenu), par lots, au moment où l'on consulte le volume.

import type { Env } from "./types.ts";

/** Nombre maximal de fichiers mesurés après coup par consultation (le reste le sera à la suivante). */
export const MESURES_PAR_APPEL = 150;

interface AMesurer { table: "reponses" | "parlomix"; id: string; cle: string; colonne: "octets_source" | "octets_miniature" | "octets" }

/** Mesure les fichiers d'une campagne dont la taille est inconnue ; renvoie le nombre de fichiers encore inconnus. */
export async function mesurerManquants(env: Env, campagneId: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT 'reponses' AS tbl, r.id, r.cle_source AS cle, 'octets_source' AS colonne
       FROM reponses r JOIN sessions s ON s.id = r.session_id WHERE s.campagne_id = ?1 AND r.cle_source IS NOT NULL AND r.octets_source IS NULL
     UNION ALL
     SELECT 'reponses', r.id, r.cle_miniature, 'octets_miniature'
       FROM reponses r JOIN sessions s ON s.id = r.session_id WHERE s.campagne_id = ?1 AND r.cle_miniature IS NOT NULL AND r.octets_miniature IS NULL
     UNION ALL
     SELECT 'parlomix', p.id, p.cle, 'octets' FROM parlomix p WHERE p.campagne_id = ?1 AND p.cle IS NOT NULL AND p.octets IS NULL
     UNION ALL
     SELECT 'parlomix', p.id, p.cle_miniature, 'octets_miniature' FROM parlomix p WHERE p.campagne_id = ?1 AND p.cle_miniature IS NOT NULL AND p.octets_miniature IS NULL`,
  ).bind(campagneId).all<{ tbl: AMesurer["table"]; id: string; cle: string; colonne: AMesurer["colonne"] }>();
  const lot = results.slice(0, MESURES_PAR_APPEL);
  if (lot.length) {
    const tailles = await Promise.all(lot.map(async (x) => ({ ...x, octets: (await env.MEDIA.head(x.cle))?.size ?? 0 })));
    // Colonnes et tables viennent de la requête ci-dessus (valeurs fixes), jamais de la demande.
    await env.DB.batch(tailles.map((x) => env.DB.prepare(`UPDATE ${x.tbl} SET ${x.colonne} = ? WHERE id = ?`).bind(x.octets, x.id)));
  }
  return results.length - lot.length;
}

export interface VolumeCampagne {
  octets: number;
  videos: { nombre: number; octets: number; dureeMs: number };
  miniatures: { octets: number };
  parlomix: { nombre: number; octets: number };
  /** Fichiers pas encore mesurés (le total est alors un minimum). */
  nonMesures: number;
}

export async function volumeCampagne(env: Env, campagneId: string): Promise<VolumeCampagne> {
  const nonMesures = await mesurerManquants(env, campagneId);
  const v = await env.DB.prepare(
    `SELECT COUNT(r.cle_source) AS nombre, COALESCE(SUM(r.octets_source), 0) AS octets, COALESCE(SUM(CASE WHEN r.cle_source IS NOT NULL THEN r.duree_ms END), 0) AS duree,
            COALESCE(SUM(r.octets_miniature), 0) AS miniatures
       FROM reponses r JOIN sessions s ON s.id = r.session_id WHERE s.campagne_id = ?`,
  ).bind(campagneId).first<{ nombre: number; octets: number; duree: number; miniatures: number }>();
  const p = await env.DB.prepare(
    `SELECT COUNT(cle) AS nombre, COALESCE(SUM(octets), 0) AS octets, COALESCE(SUM(octets_miniature), 0) AS miniatures
       FROM parlomix WHERE campagne_id = ?`,
  ).bind(campagneId).first<{ nombre: number; octets: number; miniatures: number }>();
  const videos = { nombre: v?.nombre ?? 0, octets: v?.octets ?? 0, dureeMs: v?.duree ?? 0 };
  const miniatures = { octets: (v?.miniatures ?? 0) + (p?.miniatures ?? 0) };
  const parlomix = { nombre: p?.nombre ?? 0, octets: p?.octets ?? 0 };
  return { octets: videos.octets + miniatures.octets + parlomix.octets, videos, miniatures, parlomix, nonMesures };
}
