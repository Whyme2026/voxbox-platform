// Tâches planifiées de Why me (déclencheur cron du Worker, toutes les 5 minutes) :
// - relance des montages en attente ou bloqués (3 essais au plus) ;
// - e-mail de reprise pour une interview interrompue depuis 15 minutes (une fois) ;
// - purges : interview jamais terminée (30 jours), CV à la fin de l'accès recruteurs (12 mois), toutes les données
//   quand ni les recruteurs ni la page publique n'y ont plus droit ; e-mails gardés (7 jours) ; jetons échus.

import type { Env } from "../types.ts";
import { maintenant } from "../http.ts";
import { empreinteJeton, nouveauJeton } from "../auth/cabine.ts";
import { journaliser } from "../journal.ts";
import { campagneParId, candidatParId, supprimerCandidat } from "./commun.ts";
import { courrielReprise, envoyerWhyme } from "./courriels.ts";
import { styleParId } from "./styles.ts";
import { declencherMontage, ESSAIS_MAX, montageConfigure } from "./montage.ts";

const PURGE = "purge automatique";
const ilYa = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export interface BilanTaches { montages: number; reprises: number; purges: number }

export async function tachesWhyme(env: Env): Promise<BilanTaches> {
  const bilan: BilanTaches = { montages: 0, reprises: 0, purges: 0 };
  const t = maintenant();

  // Montages : jamais demandés (service absent au moment de la fin), ou demandés il y a plus de 15 minutes sans résultat.
  if (montageConfigure(env)) {
    const enAttente = await env.DB.prepare(
      `SELECT id FROM wm_candidats WHERE supprime_le IS NULL AND montage_essais < ?
         AND (statut = 'termine' OR (statut IN ('montage', 'erreur') AND montage_demande_le < ?)) LIMIT 20`,
    ).bind(ESSAIS_MAX, ilYa(15)).all<{ id: string }>();
    for (const c of enAttente.results) if (await declencherMontage(env, c.id)) bilan.montages++;
  }

  // Reprise : interview commencée, sans action depuis 15 minutes, jamais relancée. Le lien porte un nouveau jeton
  // (l'ancien téléphone devra passer par l'e-mail, ce qui est voulu : c'est la même personne, sur son téléphone).
  const interrompues = await env.DB.prepare(
    `SELECT c.id, c.prenom, c.email, c.origine, c.campagne_id, w.code FROM wm_candidats c JOIN wm_campagnes w ON w.id = c.campagne_id
      WHERE c.statut = 'en_cours' AND c.supprime_le IS NULL AND c.reprise_envoyee_le IS NULL AND c.derniere_action_le < ?
        AND c.derniere_action_le > ? AND w.statut = 'active' LIMIT 20`,
  ).bind(ilYa(15), ilYa(24 * 60)).all<{ id: string; prenom: string; email: string; origine: string; campagne_id: string; code: string }>();
  for (const c of interrompues.results) {
    const jeton = nouveauJeton();
    const camp = await campagneParId(env.DB, c.campagne_id);
    await env.DB.prepare("UPDATE wm_candidats SET jeton_empreinte = ?, reprise_envoyee_le = ? WHERE id = ?").bind(await empreinteJeton(jeton), t, c.id).run();
    await envoyerWhyme(env, c.email, "reprise", courrielReprise(c.prenom, camp.config.evenement, `${c.origine}/i/${c.code}#reprise=${c.id}.${jeton}`,
      { vous: camp.config.tutoiement === false, accent: styleParId(camp.config.style).couleurs.accent }));
    bilan.reprises++;
  }

  // Purges.
  const aPurger = await env.DB.prepare(
    `SELECT id FROM wm_candidats WHERE supprime_le IS NULL AND (
        (statut <> 'pret' AND cree_le < ?)
        OR (statut = 'pret' AND acces_recruteurs_jusqu <= ? AND (public_jusqu IS NULL OR public_jusqu <= ? OR video_supprimee_le IS NOT NULL))
     ) LIMIT 50`,
  ).bind(ilYa(30 * 24 * 60), t, t).all<{ id: string }>();
  for (const { id } of aPurger.results) {
    const c = await candidatParId(env.DB, id);
    if (c) { await supprimerCandidat(env, c, PURGE, "échéance de conservation"); bilan.purges++; }
  }
  // CV : plus personne n'y a droit après l'accès des recruteurs (la page publique ne le montre pas).
  const cvs = await env.DB.prepare(
    "SELECT id, cv_cle FROM wm_candidats WHERE cv_cle IS NOT NULL AND statut = 'pret' AND acces_recruteurs_jusqu <= ? LIMIT 50",
  ).bind(t).all<{ id: string; cv_cle: string }>();
  for (const c of cvs.results) {
    await env.MEDIA.delete(c.cv_cle);
    await env.DB.prepare("UPDATE wm_candidats SET cv_cle = NULL, cv_nom = NULL, cv_type = NULL, cv_taille = NULL WHERE id = ?").bind(c.id).run();
    await journaliser(env.DB, PURGE, { action: "whyme.cv.suppression", cibleType: "wm_candidat", cibleId: c.id, details: { motif: "fin de l'accès des recruteurs" } });
    bilan.purges++;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM wm_courriels WHERE cree_le < ?").bind(ilYa(7 * 24 * 60)),
    env.DB.prepare("DELETE FROM wm_jetons_recruteur WHERE expire_le < ?").bind(ilYa(24 * 60)),
    env.DB.prepare("DELETE FROM wm_jetons_contact WHERE expire_le < ?").bind(ilYa(24 * 60)),
  ]);
  return bilan;
}
