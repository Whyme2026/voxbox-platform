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
import { journaliser } from "../journal.ts";
import { servirVideo } from "../media.ts";
import { retirerAccord, retirerDiffusion, sessionPour } from "../rgpd/retrait.ts";

const VISITEUR = "visiteur (accès par e-mail)";
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
  const texteBrut = `${bonjour}\n\nVoici votre lien pour retrouver vos vidéos Parlopop et, si vous le souhaitez, retirer votre accord ou les supprimer :\n${lien}\n\nCe lien est valable ${DUREE_LIEN_MIN} minutes. Si vous n'avez rien demandé, ignorez simplement ce message.\n\nParlopop by whyme`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#23263F;max-width:520px">
<p>${bonjour.replace(/[<>&]/g, "")}</p>
<p>Voici votre lien pour retrouver vos vidéos Parlopop et, si vous le souhaitez, retirer votre accord ou les supprimer :</p>
<p><a href="${lien}" style="display:inline-block;padding:12px 22px;border-radius:22px 22px 6px 22px;background:#3F4C8F;color:#FFFFFF;text-decoration:none;font-weight:600">Voir mes vidéos</a></p>
<p style="color:#5D6280;font-size:14px">Ce lien est valable ${DUREE_LIEN_MIN} minutes. Si vous n'avez rien demandé, ignorez simplement ce message.</p>
<p style="color:#5D6280;font-size:14px">Parlopop by whyme</p></div>`;
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
    // Ménage : rien n'est gardé plus d'un jour.
    await ctx.env.DB.prepare("DELETE FROM acces_visiteur WHERE cree_le < ?").bind(ilYaUnJour).run();
    const recentes = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM acces_visiteur WHERE email = ? AND cree_le >= ?").bind(email, ilYaUneHeure).first<{ n: number }>();
    if ((recentes?.n ?? 0) >= DEMANDES_PAR_HEURE) return json({ message: MESSAGE });
    const s = await ctx.env.DB.prepare("SELECT prenom FROM sessions WHERE email = ? AND retiree_le IS NULL ORDER BY cree_le DESC LIMIT 1").bind(email).first<{ prenom: string }>();
    const jeton = nouveauJeton();
    const expire = new Date(Date.now() + DUREE_LIEN_MIN * 60_000).toISOString();
    // La demande est comptée même sans passage correspondant (limite de fréquence identique pour tous).
    await ctx.env.DB.prepare("INSERT INTO acces_visiteur (id, email, jeton_empreinte, cree_le, expire_le, envoye) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(nouvelId(), email, await empreinte(jeton), now, expire, s ? 1 : 0).run();
    if (s) {
      const lien = `${ctx.url.origin}/retrait/#acces=${jeton}`;
      await envoyerCourriel(ctx.env, { a: email, sujet: "Vos vidéos Parlopop", ...messageLien(s.prenom, lien) });
    }
    return json({ message: MESSAGE });
  });

  r.get("/api/acces/moi", async (ctx) => {
    const email = await emailDuJeton(ctx.request, ctx.env);
    const { results: sessions } = await ctx.env.DB.prepare(
      `SELECT s.id, s.prenom, s.cree_le, s.consent_diffusion, s.parcours_version_id, ca.nom AS campagne, cl.nom AS marque, cl.contact_rgpd
         FROM sessions s JOIN campagnes ca ON ca.id = s.campagne_id JOIN clients cl ON cl.id = ca.client_id
        WHERE s.email = ? AND s.retiree_le IS NULL ORDER BY s.cree_le DESC LIMIT 50`,
    ).bind(email).all<{ id: string; prenom: string; cree_le: string; consent_diffusion: number; parcours_version_id: string; campagne: string; marque: string; contact_rgpd: string }>();
    // Titres des questions, par version de parcours.
    const titres = new Map<string, Record<string, string>>();
    const passages = [];
    for (const s of sessions) {
      if (!titres.has(s.parcours_version_id)) {
        const v = await ctx.env.DB.prepare("SELECT config FROM parcours_versions WHERE id = ?").bind(s.parcours_version_id).first<{ config: string }>();
        const etapes = (v ? (JSON.parse(v.config) as { etapes?: { id: string; type: string; titreCourt?: string; texte?: string }[] }).etapes : []) ?? [];
        titres.set(s.parcours_version_id, Object.fromEntries(etapes.filter((e) => e.type === "question").map((e) => [e.id, e.titreCourt ?? e.texte ?? e.id])));
      }
      const t = titres.get(s.parcours_version_id)!;
      const { results: reponses } = await ctx.env.DB.prepare(
        "SELECT id, etape_id, duree_ms FROM reponses WHERE session_id = ? AND cle_source IS NOT NULL ORDER BY cree_le",
      ).bind(s.id).all<{ id: string; etape_id: string; duree_ms: number | null }>();
      passages.push({
        id: s.id, prenom: s.prenom, date: s.cree_le, marque: s.marque, campagne: s.campagne, contact_rgpd: s.contact_rgpd,
        diffusion: Boolean(s.consent_diffusion),
        reponses: reponses.map((x) => ({ id: x.id, question: t[x.etape_id] ?? x.etape_id, duree_ms: x.duree_ms })),
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
      nom: `parlopop-${rep.etape_id}.${rep.cle_source.endsWith(".mp4") ? "mp4" : "webm"}`,
      journaliser: () => journaliser(ctx.env.DB, VISITEUR, { action: "reponse.visionnage", cibleType: "reponse", cibleId: rep.id, clientId: rep.client_id, details: { session_id: rep.session_id, par: "le visiteur" } }),
    });
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
