// API des tablettes (cabine). Authentification par jeton d'appairage, jamais par Cloudflare Access.
// Une tablette ne voit que la campagne qui lui est affectée, et seulement si elle est active.

import type { Routeur } from "../routeur.ts";
import type { D1Database } from "../types.ts";
import { authentifierCabine, codeAleatoire, empreinteJeton, nouveauJeton, type CabineAuthentifiee } from "../auth/cabine.ts";
import { conflit, HttpError, introuvable, invalide, json, lireJson, maintenant, nouvelId, texte } from "../http.ts";
import { ligneJournal } from "../journal.ts";
import { choix as etapesChoix, diffusionProposee, questions, type Parcours } from "../parcours/schema.ts";
import { lireMiniature } from "../media.ts";
import { doitEtreTranscrite, transcrireReponse } from "../analyse/transcription.ts";
import { classerReponse } from "../analyse/classement.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TAILLE_MAX_VIDEO = 60 * 1024 * 1024;
export const CODE_RETRAIT = /^[A-HJ-NP-Z2-9]{10}$/;

interface CampagneActive {
  id: string;
  client_id: string;
  nom: string;
  conservation_jours: number;
  parcours_version_id: string;
  consentement_version_id: string;
  parcours: Parcours;
}

async function campagneActive(db: D1Database, cab: CabineAuthentifiee): Promise<CampagneActive | null> {
  if (!cab.campagne_id) return null;
  const c = await db.prepare(
    `SELECT c.id, c.client_id, c.nom, c.conservation_jours, c.parcours_version_id, c.consentement_version_id, p.config
       FROM campagnes c JOIN parcours_versions p ON p.id = c.parcours_version_id
      WHERE c.id = ? AND c.statut = 'active' AND c.consentement_version_id IS NOT NULL`,
  ).bind(cab.campagne_id).first<Omit<CampagneActive, "parcours"> & { config: string }>();
  if (!c) return null;
  const { config, ...reste } = c;
  return { ...reste, parcours: JSON.parse(config) as Parcours };
}

function ajouterJours(iso: string, jours: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + jours);
  return d.toISOString();
}

export function routesCabine(r: Routeur): void {
  // Appairage : code à usage unique contre un jeton secret conservé par la tablette.
  r.post("/api/cabine/appairer", async (ctx) => {
    const d = await lireJson(ctx.request);
    const code = texte(d, "code", { requis: true, max: 12 })!.toUpperCase().replace(/\s+/g, "");
    const cab = await ctx.env.DB.prepare("SELECT id, nom FROM cabines WHERE code_appairage = ?").bind(code).first<{ id: string; nom: string }>();
    if (!cab) throw new HttpError(404, "code_inconnu", "Code d'appairage inconnu ou déjà utilisé");
    const jeton = nouveauJeton();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE cabines SET jeton_hash = ?, code_appairage = NULL, vu_le = ? WHERE id = ? AND code_appairage = ?")
        .bind(await empreinteJeton(jeton), maintenant(), cab.id, code),
      ligneJournal(ctx.env.DB, `cabine:${cab.nom}`, { action: "cabine.appairage", cibleType: "cabine", cibleId: cab.id }),
    ]);
    return json({ jeton, cabine: { id: cab.id, nom: cab.nom } }, 201);
  });

  // Configuration à jouer : parcours, textes, habillage. campagne = null si rien n'est actif.
  r.get("/api/cabine/config", async (ctx) => {
    const cab = await authentifierCabine(ctx.request, ctx.env.DB);
    const c = await campagneActive(ctx.env.DB, cab);
    if (!c) return json({ cabine: { id: cab.id, nom: cab.nom }, campagne: null });
    const client = await ctx.env.DB.prepare("SELECT nom, logo_url, couleurs FROM clients WHERE id = ?").bind(c.client_id)
      .first<{ nom: string; logo_url: string | null; couleurs: string }>();
    const consent = await ctx.env.DB.prepare("SELECT id, texte_interne, texte_diffusion FROM consentement_versions WHERE id = ?")
      .bind(c.consentement_version_id).first<{ id: string; texte_interne: string; texte_diffusion: string }>();
    const diffusion = diffusionProposee(c.parcours);
    return json({
      cabine: { id: cab.id, nom: cab.nom },
      campagne: { id: c.id, nom: c.nom, parcours_version_id: c.parcours_version_id },
      client: client ? { nom: client.nom, logo_url: client.logo_url, couleurs: JSON.parse(client.couleurs) as unknown } : null,
      parcours: c.parcours,
      consentement: consent
        ? { id: consent.id, texte_interne: consent.texte_interne, texte_diffusion: diffusion ? consent.texte_diffusion : null }
        : null,
    });
  });

  // Nouvelle session : un visiteur qui a donné son accord.
  // La tablette fournit l'identifiant (UUID) : elle peut créer la session hors ligne et l'envoyer plus tard ;
  // un renvoi de la même session est sans effet (idempotent).
  r.post("/api/cabine/sessions", async (ctx) => {
    const cab = await authentifierCabine(ctx.request, ctx.env.DB);
    const c = await campagneActive(ctx.env.DB, cab);
    if (!c) throw conflit("Aucune campagne active sur cette cabine");
    const d = await lireJson(ctx.request);

    const idFourni = typeof d.id === "string" ? d.id.toLowerCase() : undefined;
    if (idFourni !== undefined && !UUID.test(idFourni)) throw invalide("id : UUID attendu");
    if (idFourni) {
      const existe = await ctx.env.DB.prepare("SELECT id, cabine_id, code_retrait, purge_prevue_le FROM sessions WHERE id = ?").bind(idFourni)
        .first<{ id: string; cabine_id: string | null; code_retrait: string; purge_prevue_le: string }>();
      if (existe) {
        if (existe.cabine_id !== cab.id) throw conflit("Identifiant de session déjà utilisé");
        return json({ session: { id: existe.id, code_retrait: existe.code_retrait, purge_prevue_le: existe.purge_prevue_le } });
      }
    }

    // Versions jouées par la tablette : elles doivent appartenir à la campagne (une tablette restée hors ligne
    // peut avoir joué une version précédente ; on garde la trace exacte de ce que le visiteur a vu).
    const pv = await ctx.env.DB.prepare("SELECT config FROM parcours_versions WHERE id = ? AND campagne_id = ?")
      .bind(String(d.parcours_version_id ?? ""), c.id).first<{ config: string }>();
    const cv = await ctx.env.DB.prepare("SELECT 1 FROM consentement_versions WHERE id = ? AND campagne_id = ?")
      .bind(String(d.consentement_version_id ?? ""), c.id).first();
    if (!pv || !cv) throw new HttpError(409, "version_perimee", "Version inconnue pour cette campagne : la cabine doit recharger sa configuration");
    const parcoursJoue = JSON.parse(pv.config) as Parcours;

    if (d.consent_interne !== true) throw invalide("L'accord pour l'usage interne est obligatoire");
    if (d.consent_diffusion !== undefined && typeof d.consent_diffusion !== "boolean") throw invalide("consent_diffusion : vrai ou faux");
    const diffusion = d.consent_diffusion === true;
    if (diffusion && !diffusionProposee(parcoursJoue)) throw invalide("Cette campagne ne propose pas la diffusion publique");

    const prenom = texte(d, "prenom", { requis: true, max: 40 })!;
    const nom = texte(d, "nom", { max: 60 }) ?? null;
    const email = texte(d, "email", { max: 160 })?.toLowerCase() ?? null;
    if (email && !EMAIL.test(email)) throw invalide("email : adresse invalide");
    const recontact = email && d.recontact === true ? 1 : 0; // la case n'a de sens que si l'e-mail est saisi

    const now = typeof d.cree_le === "string" && !Number.isNaN(Date.parse(d.cree_le)) && Date.parse(d.cree_le) <= Date.now() + 60_000
      ? new Date(d.cree_le).toISOString() // heure réelle du passage, même si l'envoi arrive plus tard
      : maintenant();
    // Code de retrait : choisi par la tablette (elle l'affiche en QR code sur l'écran de fin, même hors ligne),
    // sinon par le serveur. 32^10 combinaisons : une collision est impossible en pratique.
    const codeFourni = typeof d.code_retrait === "string" && CODE_RETRAIT.test(d.code_retrait) ? d.code_retrait : null;
    const pris = codeFourni ? await ctx.env.DB.prepare("SELECT 1 FROM sessions WHERE code_retrait = ?").bind(codeFourni).first() : null;
    const s = {
      id: idFourni ?? nouvelId(),
      code_retrait: codeFourni && !pris ? codeFourni : codeAleatoire(10),
      purge_prevue_le: ajouterJours(now, c.conservation_jours),
    };
    await ctx.env.DB.prepare(
      `INSERT INTO sessions (id, campagne_id, cabine_id, canal, prenom, nom, email, recontact, consent_interne, consent_diffusion,
                             consentement_version_id, parcours_version_id, code_retrait, cree_le, purge_prevue_le)
       VALUES (?, ?, ?, 'cabine', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      s.id, c.id, cab.id, prenom, nom, email, recontact, diffusion ? 1 : 0,
      String(d.consentement_version_id), String(d.parcours_version_id), s.code_retrait, now, s.purge_prevue_le,
    ).run();
    return json({ session: s }, 201);
  });

  // Réception d'une réponse vidéo (WebM). Idempotent : un nouvel envoi remplace le précédent.
  r.ajouter("PUT", "/api/cabine/sessions/:session/reponses/:etape", async (ctx) => {
    const cab = await authentifierCabine(ctx.request, ctx.env.DB);
    const s = await ctx.env.DB.prepare(
      `SELECT s.id, s.campagne_id, s.cabine_id, s.retiree_le, s.purgee_le, p.config
         FROM sessions s JOIN parcours_versions p ON p.id = s.parcours_version_id WHERE s.id = ?`,
    ).bind(ctx.params.session).first<{ id: string; campagne_id: string; cabine_id: string | null; retiree_le: string | null; purgee_le: string | null; config: string }>();
    if (!s || s.cabine_id !== cab.id) throw introuvable("Session introuvable");
    if (s.retiree_le) throw new HttpError(410, "retiree", "Le visiteur a retiré son accord");
    // Durée de conservation écoulée (tablette restée longtemps hors ligne) : on ne recrée rien.
    if (s.purgee_le) throw new HttpError(410, "purgee", "La durée de conservation de ce passage est écoulée");
    const etape = ctx.params.etape!;
    if (!questions(JSON.parse(s.config) as Parcours).some((q) => q.id === etape)) throw invalide("Cette étape n'est pas une question du parcours");

    const type = (ctx.request.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (type !== "video/webm" && type !== "video/mp4") throw new HttpError(415, "format", "Vidéo WebM ou MP4 attendue");
    const longueur = Number(ctx.request.headers.get("content-length") ?? "0");
    if (longueur > TAILLE_MAX_VIDEO) throw new HttpError(413, "trop_lourd", "Vidéo trop lourde");
    const corps = await ctx.request.arrayBuffer();
    if (corps.byteLength === 0) throw invalide("Vidéo vide");
    if (corps.byteLength > TAILLE_MAX_VIDEO) throw new HttpError(413, "trop_lourd", "Vidéo trop lourde");

    const dureeMs = Math.max(0, Math.min(Number(ctx.request.headers.get("x-duree-ms") ?? 0) || 0, 600_000));
    const sonTablette = ctx.request.headers.get("x-son-present");
    const sonPresent = sonTablette === "1" ? 1 : sonTablette === "0" ? 0 : null;
    const extension = type === "video/mp4" ? "mp4" : "webm";
    const cle = `campagnes/${s.campagne_id}/sessions/${s.id}/${etape}.${extension}`;

    await ctx.env.MEDIA.put(cle, corps, { httpMetadata: { contentType: type } });
    const now = maintenant();
    // Option Analyse : la réponse est mise « à faire » (sauf si la tablette n'a entendu aucune voix). Un nouvel envoi
    // de la même réponse remplace la vidéo, donc aussi sa transcription.
    const aTranscrire = sonPresent !== 0 && await doitEtreTranscrite(ctx.env, s.id);
    const etatTranscription = aTranscrire ? "a_faire" : null;
    await ctx.env.DB.prepare(
      `INSERT INTO reponses (id, session_id, etape_id, cle_source, octets_source, duree_ms, son_present, statut, transcription_etat, cree_le, maj_le)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'recue', ?, ?, ?)
       ON CONFLICT (session_id, etape_id) DO UPDATE SET
         cle_source = excluded.cle_source, octets_source = excluded.octets_source, duree_ms = excluded.duree_ms, son_present = excluded.son_present,
         statut = 'recue', erreur = NULL, maj_le = excluded.maj_le,
         transcription = NULL, transcription_segments = NULL, transcription_langue = NULL, transcription_erreur = NULL,
         transcription_essais = 0, transcription_le = NULL, transcription_etat = excluded.transcription_etat,
         analyse_etat = NULL, analyse_essais = 0, analyse_erreur = NULL, analyse_grille = NULL, autre_sujet = NULL,
         alerte = 0, alerte_motif = NULL, alerte_vue_le = NULL, alerte_vue_par = NULL`,
    ).bind(nouvelId(), s.id, etape, cle, corps.byteLength, dureeMs, sonPresent, etatTranscription, now, now).run();
    // Un nouvel envoi remplace la vidéo : l'ancien classement ne vaut plus.
    await ctx.env.DB.prepare("DELETE FROM reponse_themes WHERE reponse_id IN (SELECT id FROM reponses WHERE session_id = ? AND etape_id = ?)").bind(s.id, etape).run();
    if (aTranscrire && ctx.execution && ctx.env.MISTRAL_API_KEY) {
      // Après la réponse à la tablette : elle n'attend pas la transcription. En cas d'échec, la reprise planifiée prend le relais.
      const rep = await ctx.env.DB.prepare("SELECT id FROM reponses WHERE session_id = ? AND etape_id = ?").bind(s.id, etape).first<{ id: string }>();
      // Transcription puis classement (lot 2) dans la foulée : le direct et les alertes en dépendent.
      if (rep) ctx.execution.waitUntil(transcrireReponse(ctx.env, rep.id)
        .then((issue) => (issue === "faite" ? classerReponse(ctx.env, rep.id) : null))
        .catch((e) => console.error("Transcription ou classement", e)));
    }
    return json({ reponse: { session_id: s.id, etape_id: etape, octets: corps.byteLength, son_present: sonPresent, transcription: etatTranscription } }, 201);
  });

  // Choix du visiteur à une étape « choix » (qualification, aiguillage). Idempotent : un nouvel envoi remplace le précédent.
  r.ajouter("PUT", "/api/cabine/sessions/:session/choix/:etape", async (ctx) => {
    const cab = await authentifierCabine(ctx.request, ctx.env.DB);
    const s = await ctx.env.DB.prepare(
      `SELECT s.id, s.cabine_id, s.retiree_le, s.purgee_le, p.config
         FROM sessions s JOIN parcours_versions p ON p.id = s.parcours_version_id WHERE s.id = ?`,
    ).bind(ctx.params.session).first<{ id: string; cabine_id: string | null; retiree_le: string | null; purgee_le: string | null; config: string }>();
    if (!s || s.cabine_id !== cab.id) throw introuvable("Session introuvable");
    if (s.retiree_le) throw new HttpError(410, "retiree", "Le visiteur a retiré son accord");
    if (s.purgee_le) throw new HttpError(410, "purgee", "La durée de conservation de ce passage est écoulée");
    const etape = etapesChoix(JSON.parse(s.config) as Parcours).find((e) => e.id === ctx.params.etape);
    if (!etape) throw invalide("Cette étape n'est pas un choix du parcours");
    const d = await lireJson(ctx.request);
    const option = typeof d.option_id === "string" ? etape.options.find((o) => o.id === d.option_id) : undefined;
    if (!option) throw invalide("option_id : option inconnue pour cette étape");
    const quand = typeof d.cree_le === "string" && !Number.isNaN(Date.parse(d.cree_le)) && Date.parse(d.cree_le) <= Date.now() + 60_000
      ? new Date(d.cree_le).toISOString() : maintenant();
    await ctx.env.DB.prepare(
      `INSERT INTO choix (session_id, etape_id, option_id, cree_le) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, etape_id) DO UPDATE SET option_id = excluded.option_id, cree_le = excluded.cree_le`,
    ).bind(s.id, etape.id, option.id, quand).run();
    return json({ choix: { session_id: s.id, etape_id: etape.id, option_id: option.id } }, 201);
  });

  // Miniature d'une réponse (image prise pendant l'enregistrement, floutée si la vidéo l'est). Envoyée après la vidéo.
  r.ajouter("PUT", "/api/cabine/sessions/:session/reponses/:etape/miniature", async (ctx) => {
    const cab = await authentifierCabine(ctx.request, ctx.env.DB);
    const rep = await ctx.env.DB.prepare(
      `SELECT r.id, s.campagne_id, s.cabine_id, s.retiree_le, s.purgee_le FROM reponses r JOIN sessions s ON s.id = r.session_id
        WHERE r.session_id = ? AND r.etape_id = ?`,
    ).bind(ctx.params.session, ctx.params.etape).first<{ id: string; campagne_id: string; cabine_id: string | null; retiree_le: string | null; purgee_le: string | null }>();
    if (!rep || rep.cabine_id !== cab.id) throw introuvable("Réponse introuvable");
    if (rep.retiree_le || rep.purgee_le) throw new HttpError(410, "retiree", "Le visiteur a retiré son accord ou la durée de conservation est écoulée");
    const corps = await lireMiniature(ctx.request);
    const cle = `campagnes/${rep.campagne_id}/sessions/${ctx.params.session}/${ctx.params.etape}.jpg`;
    await ctx.env.MEDIA.put(cle, corps, { httpMetadata: { contentType: "image/jpeg" } });
    await ctx.env.DB.prepare("UPDATE reponses SET cle_miniature = ?, octets_miniature = ? WHERE id = ?").bind(cle, corps.byteLength, rep.id).run();
    return json({ miniature: true }, 201);
  });

  // Logo d'un client, public (ce n'est pas une donnée personnelle) : affiché par la cabine et dans les Parlomix.
  r.get("/api/cabine/logo/:fichier", async (ctx) => {
    const m = /^([0-9a-f-]{36})\.(png|jpg|webp)$/.exec(ctx.params.fichier ?? "");
    if (!m) throw introuvable("Logo introuvable");
    const client = await ctx.env.DB.prepare("SELECT logo_url FROM clients WHERE id = ?").bind(m[1]).first<{ logo_url: string | null }>();
    if (!client?.logo_url?.startsWith(`/api/cabine/logo/${m[1]}.${m[2]}`)) throw introuvable("Logo introuvable");
    const objet = await ctx.env.MEDIA.get(`clients/${m[1]}/logo.${m[2]}`);
    if (!objet?.body) throw introuvable("Logo introuvable");
    return new Response(objet.body, {
      headers: {
        "content-type": m[2] === "png" ? "image/png" : m[2] === "jpg" ? "image/jpeg" : "image/webp",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=300",
      },
    });
  });

  // Signal de vie de la tablette, toutes les minutes environ.
  r.post("/api/cabine/signal", async (ctx) => {
    const cab = await authentifierCabine(ctx.request, ctx.env.DB);
    const d = await lireJson(ctx.request);
    const signal = {
      reseau: typeof d.reseau === "string" ? d.reseau.slice(0, 20) : null,
      batterie: typeof d.batterie === "number" ? Math.round(Math.max(0, Math.min(1, d.batterie)) * 100) : null,
      en_charge: typeof d.en_charge === "boolean" ? d.en_charge : null,
      file: typeof d.file === "number" ? Math.max(0, Math.floor(d.file)) : null,
      micro: typeof d.micro === "boolean" ? d.micro : null,
      version: typeof d.version === "string" ? d.version.slice(0, 20) : null,
    };
    await ctx.env.DB.prepare("UPDATE cabines SET dernier_signal = ?, vu_le = ? WHERE id = ?")
      .bind(JSON.stringify(signal), maintenant(), cab.id).run();
    return json({ ok: true });
  });
}
