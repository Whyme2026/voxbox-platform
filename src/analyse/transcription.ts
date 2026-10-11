// Option Analyse, lot 1 : transcription des réponses vidéo.
//
// Règles (décisions du 11/10/2026) :
// - rien n'est envoyé hors de Cloudflare pour une campagne sans l'option ;
// - une réponse n'est transcrite que si le visiteur a accepté une version des textes qui mentionne l'analyse
//   (consentement_versions.analyse = 1) : pas de rétroactivité ;
// - traitement à la réception de chaque réponse (le direct et les alertes en dépendent), reprise planifiée sinon ;
// - sans clé MISTRAL_API_KEY, rien ne part : les réponses restent « à faire » ;
// - chaque envoi réussi est journalisé ; la transcription vit dans la ligne de la réponse, et disparaît donc avec elle
//   (retrait d'accord, suppression de campagne).

import type { Env } from "../types.ts";
import { maintenant } from "../http.ts";
import { ligneJournal } from "../journal.ts";
import { ErreurTranscription, transcrire, type Fetch } from "./mistral.ts";

export const ESSAIS_MAX = 3;
/** Une transcription « en cours » depuis plus longtemps est considérée comme interrompue et reprise. */
export const DELAI_BLOCAGE_MS = 10 * 60_000;
export const QUI = "systeme:transcription";

/** La réponse doit-elle être transcrite ? Option de la campagne ET textes acceptés par le visiteur. */
export async function doitEtreTranscrite(env: Env, sessionId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT c.option_analyse, v.analyse FROM sessions s
       JOIN campagnes c ON c.id = s.campagne_id
       JOIN consentement_versions v ON v.id = s.consentement_version_id
      WHERE s.id = ? AND s.retiree_le IS NULL AND s.purgee_le IS NULL`,
  ).bind(sessionId).first<{ option_analyse: number; analyse: number }>();
  return r?.option_analyse === 1 && r.analyse === 1;
}

interface AFaire {
  id: string; cle_source: string | null; son_present: number | null; etape_id: string; transcription_essais: number;
  session_id: string; campagne_id: string; client_id: string; option_analyse: number; analyse: number;
  retiree_le: string | null; purgee_le: string | null; vocabulaire: string; duree_ms: number | null; grille_themes: string;
}

export type Issue = "faite" | "reessai" | "echec" | "ignoree" | "sans_cle";

/**
 * Transcrit une réponse « à faire ». Sûr en cas d'appels concurrents (réception et reprise planifiée) :
 * la réponse est d'abord réservée (a_faire → en_cours) ; un seul appel gagne.
 */
export async function transcrireReponse(env: Env, reponseId: string, opts: { fetch?: Fetch } = {}): Promise<Issue> {
  if (!env.MISTRAL_API_KEY) return "sans_cle";
  const reserve = await env.DB.prepare(
    `UPDATE reponses SET transcription_etat = 'en_cours', transcription_essais = transcription_essais + 1, transcription_le = ?
      WHERE id = ? AND transcription_etat = 'a_faire'`,
  ).bind(maintenant(), reponseId).run();
  if (!reserve.meta.changes) return "ignoree";

  const r = await env.DB.prepare(
    `SELECT r.id, r.cle_source, r.son_present, r.etape_id, r.transcription_essais, r.duree_ms, s.id AS session_id, s.retiree_le, s.purgee_le,
            c.id AS campagne_id, c.client_id, c.option_analyse, c.vocabulaire, c.grille_themes, v.analyse
       FROM reponses r JOIN sessions s ON s.id = r.session_id JOIN campagnes c ON c.id = s.campagne_id
       JOIN consentement_versions v ON v.id = s.consentement_version_id
      WHERE r.id = ?`,
  ).bind(reponseId).first<AFaire>();
  if (!r) return "ignoree";

  // Nouvelle vérification au moment d'envoyer : accord retiré, option retirée, fichier absent → on n'envoie rien.
  if (r.retiree_le || r.purgee_le || r.option_analyse !== 1 || r.analyse !== 1 || !r.cle_source || r.son_present === 0) {
    await env.DB.prepare("UPDATE reponses SET transcription_etat = NULL WHERE id = ? AND transcription_etat = 'en_cours'").bind(r.id).run();
    return "ignoree";
  }

  try {
    const objet = await env.MEDIA.get(r.cle_source);
    if (!objet?.body) throw new ErreurTranscription("Vidéo introuvable dans le stockage", true);
    const audio = await new Response(objet.body).arrayBuffer();
    const extension = r.cle_source.endsWith(".mp4") ? "mp4" : "webm";
    const resultat = await transcrire({
      cle: env.MISTRAL_API_KEY,
      audio,
      type: objet.httpMetadata?.contentType ?? `video/${extension}`,
      nomFichier: `reponse.${extension}`,
      vocabulaire: JSON.parse(r.vocabulaire) as string[],
      fetch: opts.fetch,
    });
    await env.DB.batch([
      // Si la réponse a été supprimée entre-temps (retrait d'accord), la mise à jour ne touche rien.
      env.DB.prepare(
        // Lot 2 : si la campagne a une grille de thèmes, la réponse passe aussitôt « à classer ».
        `UPDATE reponses SET transcription = ?, transcription_segments = ?, transcription_langue = ?, transcription_etat = 'faite',
                transcription_le = ?, transcription_erreur = NULL, analyse_etat = ?, analyse_essais = 0
          WHERE id = ? AND transcription_etat = 'en_cours'`,
      ).bind(resultat.texte, JSON.stringify(resultat.segments), resultat.langue, maintenant(),
        (JSON.parse(r.grille_themes) as unknown[]).length ? "a_faire" : null, r.id),
      ligneJournal(env.DB, QUI, {
        action: "reponse.transcription", cibleType: "reponse", cibleId: r.id, clientId: r.client_id,
        details: { campagne_id: r.campagne_id, session_id: r.session_id, etape: r.etape_id, service: "mistral", duree_ms: r.duree_ms, caracteres: resultat.texte.length },
      }),
    ]);
    return "faite";
  } catch (e) {
    const definitive = e instanceof ErreurTranscription && e.definitive;
    const abandon = definitive || r.transcription_essais >= ESSAIS_MAX;
    const message = (e as Error).message.slice(0, 500);
    console.error("Transcription", r.id, message);
    await env.DB.batch([
      env.DB.prepare("UPDATE reponses SET transcription_etat = ?, transcription_erreur = ? WHERE id = ? AND transcription_etat = 'en_cours'")
        .bind(abandon ? "echec" : "a_faire", message, r.id),
      ...(abandon ? [ligneJournal(env.DB, QUI, {
        action: "reponse.transcription_echec", cibleType: "reponse", cibleId: r.id, clientId: r.client_id,
        details: { campagne_id: r.campagne_id, essais: r.transcription_essais, erreur: message.slice(0, 200) },
      })] : []),
    ]);
    return abandon ? "echec" : "reessai";
  }
}

/**
 * Reprise planifiée (toutes les 5 minutes) : réponses restées « à faire » (envoi raté, clé ajoutée après coup)
 * ou bloquées « en cours » (Worker interrompu). Traitées une par une, dans l'ordre d'arrivée.
 */
export async function reprendreTranscriptions(env: Env, opts: { limite?: number; fetch?: Fetch } = {}) {
  if (!env.MISTRAL_API_KEY) return { traitees: 0 };
  const limite = opts.limite ?? 20;
  const seuil = new Date(Date.now() - DELAI_BLOCAGE_MS).toISOString();
  await env.DB.prepare("UPDATE reponses SET transcription_etat = 'a_faire' WHERE transcription_etat = 'en_cours' AND transcription_le < ?")
    .bind(seuil).run();
  const { results } = await env.DB.prepare(
    `SELECT id FROM reponses WHERE transcription_etat = 'a_faire' ORDER BY cree_le LIMIT ${Math.max(1, Math.min(limite, 100))}`,
  ).all<{ id: string }>();
  const bilan: Record<Issue, number> = { faite: 0, reessai: 0, echec: 0, ignoree: 0, sans_cle: 0 };
  for (const { id } of results) bilan[await transcrireReponse(env, id, { fetch: opts.fetch })]++;
  return { traitees: results.length, ...bilan };
}
