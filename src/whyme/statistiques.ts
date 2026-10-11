// Statistiques agrégées d'une campagne Why me, pour le client qui l'a commandée (et pour l'équipe RH).
// Uniquement des comptes : aucune identité, vidéo ni CV. Le candidat postule chez les entreprises, pas chez le client.

import type { D1Database } from "../types.ts";
import { campagneParId } from "./commun.ts";

export interface StatistiquesCampagne {
  id: string;
  nom: string;
  evenement: string;
  statut: string;
  /** Interviews commencées (identification faite), terminées (toutes les réponses), vidéos prêtes et transmises. */
  commencees: number;
  terminees: number;
  transmises: number;
  avecCv: number;
  pagesPubliques: number;
  candidatures: number;
  parEntreprise: { nom: string; candidatures: number }[];
  parFamille: { nom: string; candidats: number }[];
  parJour: { jour: string; commencees: number; terminees: number }[];
}

export async function statistiquesCampagne(db: D1Database, campagneId: string): Promise<StatistiquesCampagne> {
  const camp = await campagneParId(db, campagneId);
  const t = await db.prepare(
    `SELECT COUNT(*) AS commencees,
            SUM(CASE WHEN statut IN ('termine', 'montage', 'erreur', 'pret') THEN 1 ELSE 0 END) AS terminees,
            SUM(CASE WHEN statut = 'pret' THEN 1 ELSE 0 END) AS transmises,
            SUM(CASE WHEN cv_cle IS NOT NULL OR cv_nom IS NOT NULL THEN 1 ELSE 0 END) AS avec_cv,
            SUM(CASE WHEN consent_public = 1 THEN 1 ELSE 0 END) AS pages_publiques
       FROM wm_candidats WHERE campagne_id = ?`,
  ).bind(campagneId).first<{ commencees: number; terminees: number | null; transmises: number | null; avec_cv: number | null; pages_publiques: number | null }>();
  const entreprises = await db.prepare(
    `SELECT e.nom, COUNT(ca.candidat_id) AS candidatures
       FROM wm_campagne_entreprises ce JOIN wm_entreprises e ON e.id = ce.entreprise_id
       LEFT JOIN wm_candidatures ca ON ca.entreprise_id = e.id AND ca.transmise_le IS NOT NULL
            AND ca.candidat_id IN (SELECT id FROM wm_candidats WHERE campagne_id = ?)
      WHERE ce.campagne_id = ? GROUP BY e.id ORDER BY candidatures DESC, e.nom`,
  ).bind(campagneId, campagneId).all<{ nom: string; candidatures: number }>();
  const familles = await db.prepare(
    "SELECT famille, COUNT(*) AS n FROM wm_candidats WHERE campagne_id = ? AND famille IS NOT NULL GROUP BY famille",
  ).bind(campagneId).all<{ famille: string; n: number }>();
  const jours = await db.prepare(
    `SELECT substr(cree_le, 1, 10) AS jour, COUNT(*) AS commencees,
            SUM(CASE WHEN statut IN ('termine', 'montage', 'erreur', 'pret') THEN 1 ELSE 0 END) AS terminees
       FROM wm_candidats WHERE campagne_id = ? GROUP BY jour ORDER BY jour`,
  ).bind(campagneId).all<{ jour: string; commencees: number; terminees: number }>();
  const nomsFamilles = new Map(camp.config.familles.map((f) => [f.id, f.nom]));
  const parEntreprise = entreprises.results.map((e) => ({ nom: e.nom, candidatures: Number(e.candidatures) }));
  return {
    id: camp.id,
    nom: camp.nom,
    evenement: camp.config.evenement,
    statut: camp.statut,
    commencees: Number(t?.commencees ?? 0),
    terminees: Number(t?.terminees ?? 0),
    transmises: Number(t?.transmises ?? 0),
    avecCv: Number(t?.avec_cv ?? 0),
    pagesPubliques: Number(t?.pages_publiques ?? 0),
    candidatures: parEntreprise.reduce((n, e) => n + e.candidatures, 0),
    parEntreprise,
    parFamille: camp.config.familles.map((f) => ({ nom: f.nom, candidats: Number(familles.results.find((x) => x.famille === f.id)?.n ?? 0) }))
      .concat(familles.results.filter((x) => !nomsFamilles.has(x.famille)).map((x) => ({ nom: x.famille, candidats: Number(x.n) }))),
    parJour: jours.results.map((j) => ({ jour: j.jour, commencees: Number(j.commencees), terminees: Number(j.terminees ?? 0) })),
  };
}

export async function statistiquesClient(db: D1Database, clientId: string): Promise<StatistiquesCampagne[]> {
  const ids = await db.prepare("SELECT id FROM wm_campagnes WHERE client_id = ? AND statut <> 'brouillon' ORDER BY cree_le DESC")
    .bind(clientId).all<{ id: string }>();
  const res: StatistiquesCampagne[] = [];
  for (const { id } of ids.results) res.push(await statistiquesCampagne(db, id));
  return res;
}
