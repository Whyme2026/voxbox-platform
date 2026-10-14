// Accès du visiteur à ses vidéos, depuis le QR code affiché à l'extérieur de la cabine.
// 1. Il saisit l'e-mail donné à l'identification : s'il correspond à des réponses, un lien valable une heure lui est
//    envoyé (la réponse est la même dans tous les cas : on ne révèle pas qui est passé dans la cabine).
// 2. Le lien ouvre /retrait/#acces=<jeton> : ses passages, ses vidéos, et pour chacun « retirer la diffusion » ou
//    « supprimer mes réponses » (mêmes effets que depuis Parlorama).
// Le jeton circule dans l'en-tête x-acces, jamais dans une adresse (pas de trace dans les journaux du serveur).
// ⚠ /retrait et /api/acces doivent être exclus de Cloudflare Access, comme la cabine.

import type { Routeur } from "../routeur.ts";
import type { Env } from "../types.ts";
import { HttpError, introuvable, invalide, json, lireJson, maintenant, nouvelId, texte } from "../http.ts";
import { envoyerCourriel } from "../courriel.ts";
import { journaliser, ligneJournal } from "../journal.ts";
import { servirVideo } from "../media.ts";
import { retirerAccord, retirerDiffusion, sessionPour } from "../rgpd/retrait.ts";

const VISITEUR = "visiteur (accès par e-mail)";
/** Adresse pour demander la suppression, quand le visiteur n'a pas d'e-mail (fin.contact par défaut). */
export const CONTACT_PAR_DEFAUT = "contact@parlobox.com";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DUREE_LIEN_MIN = 60;
export const DEMANDES_PAR_HEURE = 3;
const MESSAGE = "Si cette adresse correspond à des vidéos, un lien vient d'y être envoyé. Pensez à regarder vos courriers indésirables.";

async function empreinte(jeton: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jeton));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function nouveauJeton(): string {
  const octets = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...octets)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** E-mail du visiteur à partir du jeton de l'en-tête x-acces ; 401 si absent, inconnu ou expiré. */
async function emailDuJeton(request: Request, env: Env): Promise<string> {
  const jeton = request.headers.get("x-acces") ?? "";
  if (!/^[\w-]{40,}$/.test(jeton)) throw new HttpError(401, "lien_invalide", "Ce lien n'est pas valable. Demandez-en un nouveau.");
  const ligne = await env.DB.prepare("SELECT email, expire_le FROM acces_visiteur WHERE jeton_empreinte = ?")
    .bind(await empreinte(jeton)).first<{ email: string; expire_le: string }>();
  if (!ligne || ligne.expire_le <= maintenant()) throw new HttpError(401, "lien_expire", "Ce lien a expiré. Demandez-en un nouveau.");
  return ligne.email;
}

/** Session du visiteur, seulement si elle porte son e-mail et n'a pas été retirée. */
async function sessionDuVisiteur(env: Env, email: string, id: string) {
  const s = await env.DB.prepare("SELECT id FROM sessions WHERE id = ? AND email = ? AND retiree_le IS NULL").bind(id, email).first<{ id: string }>();
  if (!s) throw introuvable("Passage introuvable");
  const complete = await sessionPour(env.DB, "id", s.id);
  if (!complete) throw introuvable("Passage introuvable");
  return complete;
}

function messageLien(prenom: string, lien: string) {
  const bonjour = prenom ? `Bonjour ${prenom},` : "Bonjour,";
  const texteBrut = `${bonjour}\n\nVoici votre lien pour retrouver vos vidéos Parlobox et, si vous le souhaitez, retirer votre accord ou les supprimer :\n${lien}\n\nCe lien est valable ${DUREE_LIEN_MIN} minutes. Si vous n'avez rien demandé, ignorez simplement ce message.\n\nParlobox by whyme`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#23263F;max-width:520px">
<p>${bonjour.replace(/[<>&]/g, "")}</p>
<p>Voici votre lien pour retrouver vos vidéos Parlobox et, si vous le souhaitez, retirer votre accord ou les supprimer :</p>
<p><a href="${lien}" style="display:inline-block;padding:12px 22px;border-radius:22px 22px 6px 22px;background:#3F4C8F;color:#FFFFFF;text-decoration:none;font-weight:600">Voir mes vidéos</a></p>
<p style="color:#5D6280;font-size:14px">Ce lien est valable ${DUREE_LIEN_MIN} minutes. Si vous n'avez rien demandé, ignorez simplement ce message.</p>
<p style="color:#5D6280;font-size:14px">Parlobox by whyme</p></div>`;
  return { texte: texteBrut, html };
}

export function routesAcces(r: Routeur): void {
  r.post("/api/acces/demande", async (ctx) => {
    const d = await lireJson(ctx.request);
    const email = texte(d, "email", { requis: true, max: 160 })!.trim().toLowerCase();
    if (!EMAIL.test(email)) throw invalide("Adresse e-mail invalide");
    const now = maintenant();
    const ilYaUnJour = new Date(Date.now() - 24 * 3600_000).toISOString();
    const ilYaUneHeure = new Date(Date.now() - 3600_000).toISOString();
    // Ménage : une demande n'est pas gardée plus d'un jour ; un lien envoyé avec les vidéos, jusqu'à son expiration.
    await ctx.env.DB.prepare("DELETE FROM acces_visiteur WHERE (motif = 'demande' AND cree_le < ?) OR expire_le < ?").bind(ilYaUnJour, now).run();
    const recentes = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM acces_visiteur WHERE email = ? AND cree_le >= ? AND motif = 'demande'").bind(email, ilYaUneHeure).first<{ n: number }>();
    if ((recentes?.n ?? 0) >= DEMANDES_PAR_HEURE) return json({ message: MESSAGE });
    const s = await ctx.env.DB.prepare("SELECT prenom FROM sessions WHERE email = ? AND retiree_le IS NULL ORDER BY cree_le DESC LIMIT 1").bind(email).first<{ prenom: string }>();
    const jeton = nouveauJeton();
    const expire = new Date(Date.now() + DUREE_LIEN_MIN * 60_000).toISOString();
    // La demande est comptée même sans passage correspondant (limite de fréquence identique pour tous).
    await ctx.env.DB.prepare("INSERT INTO acces_visiteur (id, email, jeton_empreinte, cree_le, expire_le, envoye) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(nouvelId(), email, await empreinte(jeton), now, expire, s ? 1 : 0).run();
    if (s) {
      const lien = `${ctx.url.origin}/retrait/#acces=${jeton}`;
      await envoyerCourriel(ctx.env, { a: email, sujet: "Vos vidéos Parlobox", ...messageLien(s.prenom, lien) });
    }
    return json({ message: MESSAGE });
  });

  r.get("/api/acces/moi", async (ctx) => {
    const email = await emailDuJeton(ctx.request, ctx.env);
    const { results: sessions } = await ctx.env.DB.prepare(
      `SELECT s.id, s.prenom, s.cree_le, s.consent_diffusion, s.parcours_version_id, ca.nom AS campagne, cl.nom AS marque, cl.contact_rgpd,
              cl.logo_url, cl.couleurs
         FROM sessions s JOIN campagnes ca ON ca.id = s.campagne_id JOIN clients cl ON cl.id = ca.client_id
        WHERE s.email = ? AND s.retiree_le IS NULL ORDER BY s.cree_le DESC LIMIT 50`,
    ).bind(email).all<{ id: string; prenom: string; cree_le: string; consent_diffusion: number; parcours_version_id: string; campagne: string; marque: string; contact_rgpd: string; logo_url: string | null; couleurs: string | null }>();
    // Parcours joué par chaque passage (questions et allure), lu une fois par version.
    type EtapeLue = { id: string; type: string; titreCourt?: string; texte?: string; fond?: string; visuel?: string; options?: { id: string; visuel?: string }[] };
    const versions = new Map<string, { etapes: EtapeLue[]; habillage?: unknown; ambiance?: string; tutoiement?: boolean }>();
    const passages = [];
    for (const s of sessions) {
      if (!versions.has(s.parcours_version_id)) {
        const v = await ctx.env.DB.prepare("SELECT config FROM parcours_versions WHERE id = ?").bind(s.parcours_version_id).first<{ config: string }>();
        versions.set(s.parcours_version_id, v ? JSON.parse(v.config) : { etapes: [] });
      }
      const pv = versions.get(s.parcours_version_id)!;
      const questions = (pv.etapes ?? []).filter((e) => e.type === "question");
      const { results: reponses } = await ctx.env.DB.prepare(
        "SELECT id, etape_id, duree_ms FROM reponses WHERE session_id = ? AND cle_source IS NOT NULL ORDER BY cree_le",
      ).bind(s.id).all<{ id: string; etape_id: string; duree_ms: number | null }>();
      const { results: choix } = await ctx.env.DB.prepare("SELECT etape_id, option_id FROM choix WHERE session_id = ?").bind(s.id).all<{ etape_id: string; option_id: string }>();
      const rang = (etape: string) => { const i = questions.findIndex((q) => q.id === etape); return i < 0 ? 999 : i; };
      passages.push({
        id: s.id, prenom: s.prenom, date: s.cree_le, marque: s.marque, campagne: s.campagne, contact_rgpd: s.contact_rgpd,
        diffusion: Boolean(s.consent_diffusion),
        reponses: reponses.sort((a, b) => rang(a.etape_id) - rang(b.etape_id)).map((x) => {
          const q = questions.find((e) => e.id === x.etape_id);
          return { id: x.id, etape_id: x.etape_id, question: q?.titreCourt ?? q?.texte ?? x.etape_id, texte: q?.texte ?? "", duree_ms: x.duree_ms };
        }),
        // De quoi fabriquer son Parlomix dans son navigateur (14/10/2026) : l'allure de la campagne, rien de personnel en plus.
        parlomix: {
          habillage: pv.habillage ?? null, ambiance: pv.ambiance ?? "conversation", tutoiement: pv.tutoiement === true,
          client: { nom: s.marque, logo_url: s.logo_url, couleurs: s.couleurs ? JSON.parse(s.couleurs) as unknown : {} },
          questions: questions.map((q) => ({ id: q.id, titre: q.titreCourt ?? q.texte ?? q.id, texte: q.texte ?? "", ...(q.fond ? { fond: q.fond } : {}), ...(q.visuel ? { visuel: q.visuel } : {}) })),
          etapes_choix: (pv.etapes ?? []).filter((e) => e.type === "choix").map((e) => ({ id: e.id, options: (e.options ?? []).map((o) => ({ id: o.id, ...(o.visuel ? { visuel: o.visuel } : {}) })) })),
          choix: Object.fromEntries(choix.map((c) => [c.etape_id, c.option_id])),
        },
      });
    }
    return json({ email, passages });
  });

  r.get("/api/acces/reponses/:id/video", async (ctx) => {
    const email = await emailDuJeton(ctx.request, ctx.env);
    const rep = await ctx.env.DB.prepare(
      `SELECT r.id, r.cle_source, r.etape_id, s.id AS session_id, c.client_id FROM reponses r
         JOIN sessions s ON s.id = r.session_id JOIN campagnes c ON c.id = s.campagne_id
        WHERE r.id = ? AND s.email = ? AND s.retiree_le IS NULL`,
    ).bind(ctx.params.id, email).first<{ id: string; cle_source: string | null; etape_id: string; session_id: string; client_id: string }>();
    if (!rep?.cle_source) throw introuvable("Vidéo introuvable");
    return servirVideo(ctx.request, ctx.env, rep.cle_source, {
      type: rep.cle_source.endsWith(".mp4") ? "video/mp4" : "video/webm",
      nom: `parlobox-${rep.etape_id}.${rep.cle_source.endsWith(".mp4") ? "mp4" : "webm"}`,
      journaliser: () => journaliser(ctx.env.DB, VISITEUR, { action: "reponse.visionnage", cibleType: "reponse", cibleId: rep.id, clientId: rep.client_id, details: { session_id: rep.session_id, par: "le visiteur" } }),
    });
  });

  // Parlomix fabriqué par le visiteur dans son navigateur (rien n'est envoyé ni gardé) : seulement tracé.
  r.post("/api/acces/sessions/:id/parlomix", async (ctx) => {
    const email = await emailDuJeton(ctx.request, ctx.env);
    const s = await sessionDuVisiteur(ctx.env, email, ctx.params.id ?? "");
    await journaliser(ctx.env.DB, VISITEUR, { action: "parlomix.visiteur", cibleType: "session", cibleId: s.id, clientId: s.client_id });
    return json({ ok: true });
  });

  r.post("/api/acces/sessions/:id", async (ctx) => {
    const email = await emailDuJeton(ctx.request, ctx.env);
    const d = await lireJson(ctx.request);
    if (d.portee !== "tout" && d.portee !== "diffusion") throw invalide("portee : « tout » ou « diffusion »");
    const s = await sessionDuVisiteur(ctx.env, email, ctx.params.id ?? "");
    if (d.portee === "diffusion") {
      await retirerDiffusion(ctx.env, VISITEUR, s, "visiteur");
      return json({ retrait: "diffusion" });
    }
    await retirerAccord(ctx.env, VISITEUR, s, "visiteur");
    return json({ retrait: "tout" });
  });
}

// ------------------------------------------------------------------ e-mail « tes vidéos » (écran « recevoir »)

/** Lien envoyé avec les vidéos : valable 30 jours (ensuite, le QR code extérieur ou l'adresse de contact). */
export const DUREE_LIEN_VIDEO_JOURS = 30;
/** Délai avant l'envoi : le temps que le visiteur termine et que la tablette envoie ses vidéos. */
export const DELAI_ENVOI_VIDEO_MIN = 10;
const ENVOIS_PAR_PASSAGE = 25;

const echapper = (t: string) => t.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/**
 * E-mail envoyé au visiteur qui a demandé sa vidéo (14/10/2026) : un seul lien, qui ouvre la page où il fabrique
 * lui-même son Parlomix, dans son navigateur (rien n'est monté d'avance pour tout le monde). La même page permet de
 * changer d'avis (diffusion, suppression).
 */
export function messageVideos(o: { prenom: string; marque: string; lien: string; tutoiement: boolean; diffusion: boolean; contact: string }) {
  const tu = o.tutoiement;
  const bonjour = o.prenom ? `${tu ? "Salut" : "Bonjour"} ${o.prenom},` : "Bonjour,";
  const intro = tu
    ? `Merci d'avoir joué le jeu de la cabine Parlobox ${o.marque} ! Ton Parlomix t'attend : tes réponses montées en un petit film, à garder ou à partager.`
    : `Merci d'avoir répondu dans la cabine Parlobox ${o.marque} ! Votre Parlomix vous attend : vos réponses montées en un petit film, à garder ou à partager.`;
  const bouton = tu ? "Créer mon Parlomix" : "Créer mon Parlomix";
  const comment = tu
    ? "Un clic sur le lien, et ton film se fabrique sous tes yeux, en une minute environ."
    : "Un clic sur le lien, et votre film se fabrique sous vos yeux, en une minute environ.";
  const avis = tu
    ? `Tu changes d'avis ? Depuis ce même lien, tu peux ${o.diffusion ? "retirer ton accord pour les réseaux sociaux, ou " : ""}supprimer tes vidéos, à tout moment.`
    : `Vous changez d'avis ? Depuis ce même lien, vous pouvez ${o.diffusion ? "retirer votre accord pour les réseaux sociaux, ou " : ""}supprimer vos vidéos, à tout moment.`;
  const duree = tu
    ? `Le lien est valable ${DUREE_LIEN_VIDEO_JOURS} jours. Ensuite, écris à ${o.contact} pour toute demande.`
    : `Le lien est valable ${DUREE_LIEN_VIDEO_JOURS} jours. Ensuite, écrivez à ${o.contact} pour toute demande.`;
  const texte = `${bonjour}\n\n${intro}\n\n${bouton} : ${o.lien}\n${comment}\n\n${avis}\n${duree}\n\nParlobox by whyme`;
  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:16px;line-height:1.5;color:#303136;max-width:520px">
<p style="font-size:20px;font-weight:700;color:#242841;margin:0 0 12px">${echapper(bonjour)}</p>
<p>${echapper(intro)}</p>
<p><a href="${echapper(o.lien)}" style="display:inline-block;padding:13px 24px;border-radius:24px 24px 6px 24px;background:#C4007A;color:#FFFFFF;text-decoration:none;font-weight:700">${bouton}</a></p>
<p style="color:#6B6D75;font-size:14px">${echapper(comment)}</p>
<p>${echapper(avis)}</p>
<p style="color:#6B6D75;font-size:14px">${echapper(duree)}</p>
<p style="color:#6B6D75;font-size:14px">parlobox <span style="font-size:12px">by</span> <b>why<span style="color:#C4007A">me</span></b></p></div>`;
  return { texte, html };
}

/**
 * Tâche planifiée : envoie leur lien aux visiteurs qui ont laissé leur e-mail sur l'écran « recevoir », une fois
 * leurs vidéos reçues (10 minutes après le passage). Sans service d'e-mail configuré, rien ne part et rien n'est
 * marqué : l'envoi se fera dès que Brevo sera branché. Un passage sans vidéo au bout d'un jour est abandonné.
 */
export async function envoyerVideosAuxVisiteurs(env: Env): Promise<{ envoyes: number; abandonnes: number; erreurs: number }> {
  const bilan = { envoyes: 0, abandonnes: 0, erreurs: 0 };
  if (!env.BREVO_CLE && env.AUTH_MODE !== "dev") return bilan;
  const avant = new Date(Date.now() - DELAI_ENVOI_VIDEO_MIN * 60_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.prenom, s.email, s.cree_le, s.consent_diffusion, s.envoi_video_origine, s.parcours_version_id, cl.nom AS marque, ca.client_id,
            (SELECT COUNT(*) FROM reponses r WHERE r.session_id = s.id AND r.cle_source IS NOT NULL) AS videos
       FROM sessions s JOIN campagnes ca ON ca.id = s.campagne_id JOIN clients cl ON cl.id = ca.client_id
      WHERE s.envoi_video = 1 AND s.envoi_video_le IS NULL AND s.email IS NOT NULL AND s.retiree_le IS NULL AND s.purgee_le IS NULL
        AND s.cree_le <= ? ORDER BY s.cree_le LIMIT ?`,
  ).bind(avant, ENVOIS_PAR_PASSAGE).all<{ id: string; prenom: string; email: string; cree_le: string; consent_diffusion: number; envoi_video_origine: string | null; parcours_version_id: string; marque: string; client_id: string; videos: number }>();
  const unJour = new Date(Date.now() - 24 * 3600_000).toISOString();
  for (const s of results) {
    const now = maintenant();
    if (!s.videos) {
      // Les vidéos peuvent arriver tard (tablette restée hors ligne) ; au bout d'un jour, on n'attend plus.
      if (s.cree_le < unJour) {
        await env.DB.prepare("UPDATE sessions SET envoi_video_le = ? WHERE id = ?").bind(now, s.id).run();
        bilan.abandonnes++;
      }
      continue;
    }
    try {
      const v = await env.DB.prepare("SELECT config FROM parcours_versions WHERE id = ?").bind(s.parcours_version_id).first<{ config: string }>();
      const parcours = v ? JSON.parse(v.config) as { tutoiement?: boolean; etapes?: { type: string; contact?: string }[] } : {};
      const contact = parcours.etapes?.find((e) => e.type === "fin")?.contact ?? CONTACT_PAR_DEFAUT;
      const jeton = nouveauJeton();
      const expire = new Date(Date.now() + DUREE_LIEN_VIDEO_JOURS * 24 * 3600_000).toISOString();
      // Le jeton est noté avant l'envoi : un e-mail parti donne toujours un lien valable.
      await env.DB.prepare("INSERT INTO acces_visiteur (id, email, jeton_empreinte, cree_le, expire_le, envoye, motif) VALUES (?, ?, ?, ?, ?, 1, 'video')")
        .bind(nouvelId(), s.email, await empreinte(jeton), now, expire).run();
      // #parlomix= : la page s'ouvre sur la fabrication du Parlomix (et garde la gestion de ses vidéos en dessous).
      const lien = `${s.envoi_video_origine ?? ""}/retrait/#parlomix=${jeton}`;
      await envoyerCourriel(env, {
        a: s.email,
        sujet: parcours.tutoiement ? `${s.prenom}, ton Parlomix t'attend` : "Votre Parlomix vous attend",
        ...messageVideos({ prenom: s.prenom, marque: s.marque, lien, tutoiement: parcours.tutoiement === true, diffusion: Boolean(s.consent_diffusion), contact }),
      });
      await env.DB.batch([
        env.DB.prepare("UPDATE sessions SET envoi_video_le = ? WHERE id = ?").bind(now, s.id),
        ligneJournal(env.DB, "plateforme", { action: "session.envoi_videos", cibleType: "session", cibleId: s.id, clientId: s.client_id }),
      ]);
      bilan.envoyes++;
    } catch (e) {
      console.warn("Parlobox, envoi des vidéos au visiteur", s.id, String(e));
      bilan.erreurs++;
    }
  }
  return bilan;
}
