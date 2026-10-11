// Outils partagés par les routes Why me : campagne active, authentification du téléphone du candidat,
// suppression des données d'un candidat (à sa demande ou à échéance).

import type { D1Database, Env } from "../types.ts";
import { HttpError, introuvable, maintenant } from "../http.ts";
import { empreinteJeton } from "../auth/cabine.ts";
import { ligneJournal } from "../journal.ts";
import { genererTextes, validerConfig, type ConfigWhyme } from "./config.ts";

export const CANDIDAT = "candidat (téléphone)";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const JETON = /^[A-Za-z0-9_-]{32,64}$/;

export interface CampagneWhyme {
  id: string;
  code: string;
  nom: string;
  statut: "brouillon" | "active" | "close";
  config: ConfigWhyme;
  textes_empreinte: string;
}

export interface EntrepriseWhyme { id: string; nom: string; slug: string; logo_cle: string | null }

export async function campagneParCode(db: D1Database, code: string, activeSeulement = true): Promise<CampagneWhyme> {
  const c = await db.prepare("SELECT id, code, nom, statut, config, textes_empreinte FROM wm_campagnes WHERE code = ?")
    .bind(code).first<Omit<CampagneWhyme, "config"> & { config: string }>();
  if (!c || (activeSeulement && c.statut !== "active")) throw new HttpError(404, "campagne_fermee", "Cette interview n'est pas ouverte en ce moment.");
  return { ...c, config: validerConfig(JSON.parse(c.config)) };
}

export async function campagneParId(db: D1Database, id: string): Promise<CampagneWhyme> {
  const c = await db.prepare("SELECT id, code, nom, statut, config, textes_empreinte FROM wm_campagnes WHERE id = ?")
    .bind(id).first<Omit<CampagneWhyme, "config"> & { config: string }>();
  if (!c) throw introuvable("Campagne introuvable");
  return { ...c, config: validerConfig(JSON.parse(c.config)) };
}

export async function entreprisesDeCampagne(db: D1Database, campagneId: string): Promise<EntrepriseWhyme[]> {
  const r = await db.prepare(
    `SELECT e.id, e.nom, e.slug, e.logo_cle FROM wm_campagne_entreprises ce JOIN wm_entreprises e ON e.id = ce.entreprise_id
      WHERE ce.campagne_id = ? ORDER BY ce.ordre, e.nom`,
  ).bind(campagneId).all<EntrepriseWhyme>();
  return r.results;
}

export { genererTextes };

export interface CandidatRow {
  id: string;
  campagne_id: string;
  prenom: string;
  nom: string;
  email: string;
  age: number | null;
  famille: string | null;
  consent_public: number;
  statut: "en_cours" | "termine" | "montage" | "pret" | "erreur";
  cv_cle: string | null;
  cv_nom: string | null;
  cv_type: string | null;
  montage_cle: string | null;
  miniature_cle: string | null;
  code_public: string | null;
  origine: string;
  public_jusqu: string | null;
  acces_recruteurs_jusqu: string | null;
  video_supprimee_le: string | null;
  supprime_le: string | null;
  derniere_action_le: string;
  montage_essais: number;
}

const COLONNES = `id, campagne_id, prenom, nom, email, age, famille, consent_public, statut, cv_cle, cv_nom, cv_type, montage_cle,
  miniature_cle, code_public, origine, public_jusqu, acces_recruteurs_jusqu, video_supprimee_le, supprime_le, derniere_action_le, montage_essais`;

export async function candidatParId(db: D1Database, id: string): Promise<CandidatRow | null> {
  return db.prepare(`SELECT ${COLONNES} FROM wm_candidats WHERE id = ?`).bind(id).first<CandidatRow>();
}

/** Le téléphone du candidat : jeton dans l'en-tête x-jeton (jamais dans l'adresse). */
export async function candidatAuthentifie(request: Request, env: Env, id: string): Promise<CandidatRow> {
  const jeton = request.headers.get("x-jeton") ?? "";
  if (!UUID.test(id) || !JETON.test(jeton)) throw new HttpError(401, "jeton_invalide", "Session d'interview inconnue");
  const c = await env.DB.prepare(`SELECT ${COLONNES} FROM wm_candidats WHERE id = ? AND jeton_empreinte = ?`)
    .bind(id, await empreinteJeton(jeton)).first<CandidatRow>();
  if (!c || c.supprime_le) throw new HttpError(401, "jeton_invalide", "Cette interview n'est plus accessible depuis ce téléphone. Reprends-la avec le lien reçu par e-mail.");
  return c;
}

/** Comparaison en temps constant (secret du service de montage). */
export function egalConstant(a: string, b: string): boolean {
  if (a.length !== b.length || !a.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Supprime la vidéo montée (le candidat la désactive, décision du 11/10/2026) : page publique et espace recruteur. */
export async function supprimerVideo(env: Env, c: CandidatRow, qui: string, motif: string): Promise<void> {
  const cles = [c.montage_cle, c.miniature_cle].filter((k): k is string => Boolean(k));
  if (cles.length) await env.MEDIA.delete(cles);
  await env.DB.batch([
    env.DB.prepare("UPDATE wm_candidats SET montage_cle = NULL, miniature_cle = NULL, video_supprimee_le = ? WHERE id = ?").bind(maintenant(), c.id),
    ligneJournal(env.DB, qui, { action: "whyme.video.suppression", cibleType: "wm_candidat", cibleId: c.id, details: { motif } }),
  ]);
}

/**
 * Efface toutes les données d'un candidat : vidéos, rushes, CV, identité. Les candidatures sont marquées retirées
 * et la fiche anonymisée (on garde la trace qu'une interview a eu lieu, sans rien qui identifie la personne).
 */
export async function supprimerCandidat(env: Env, c: CandidatRow, qui: string, motif: string): Promise<void> {
  const prises = await env.DB.prepare("SELECT cle FROM wm_prises WHERE candidat_id = ?").bind(c.id).all<{ cle: string }>();
  const cles = [c.montage_cle, c.miniature_cle, c.cv_cle, ...prises.results.map((p) => p.cle)].filter((k): k is string => Boolean(k));
  if (cles.length) await env.MEDIA.delete(cles);
  const t = maintenant();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM wm_prises WHERE candidat_id = ?").bind(c.id),
    env.DB.prepare("UPDATE wm_candidatures SET retiree_le = COALESCE(retiree_le, ?) WHERE candidat_id = ?").bind(t, c.id),
    env.DB.prepare(
      `UPDATE wm_candidats SET prenom = '—', nom = '', email = '', age = NULL, famille = NULL, cv_cle = NULL, cv_nom = NULL,
         cv_type = NULL, cv_taille = NULL, montage_cle = NULL, miniature_cle = NULL, video_supprimee_le = COALESCE(video_supprimee_le, ?),
         supprime_le = ? WHERE id = ?`,
    ).bind(t, t, c.id),
    ligneJournal(env.DB, qui, { action: "whyme.candidat.suppression", cibleType: "wm_candidat", cibleId: c.id, details: { motif } }),
  ]);
}
