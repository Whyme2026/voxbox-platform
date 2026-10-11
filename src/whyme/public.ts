// Pages publiques de Why me : vidéo du candidat (/v/<code>, QR code du sticker), logos des entreprises,
// et « Tu gardes la main » (lien de l'e-mail : supprimer sa vidéo, ou toutes ses données).
// ⚠ Publiques : /v, /whyme et /api/whyme doivent être exclus de Cloudflare Access.

import type { Routeur } from "../routeur.ts";
import type { Env } from "../types.ts";
import { HttpError, introuvable, invalide, json, lireJson, maintenant } from "../http.ts";
import { empreinteJeton } from "../auth/cabine.ts";
import { journaliser } from "../journal.ts";
import { servirMiniature, servirVideo } from "../media.ts";
import { campagneParId, candidatParId, JETON, supprimerCandidat, supprimerVideo, type CandidatRow } from "./commun.ts";
import { stickerPng } from "./sticker.ts";

const CODE = /^[A-HJ-NP-Z2-9]{10}$/;
const PUBLIC = "public (page vidéo)";
const CANDIDAT_EMAIL = "candidat (lien de l'e-mail)";

/** Vidéo publique encore visible : consentement donné, ni supprimée ni échue. */
async function videoPublique(env: Env, code: string): Promise<CandidatRow> {
  if (!CODE.test(code)) throw introuvable("Vidéo introuvable");
  const id = await env.DB.prepare("SELECT id FROM wm_candidats WHERE code_public = ?").bind(code).first<{ id: string }>();
  const c = id ? await candidatParId(env.DB, id.id) : null;
  if (!c || !c.consent_public || c.supprime_le || c.video_supprimee_le || !c.montage_cle || !c.public_jusqu || c.public_jusqu <= maintenant()) {
    throw new HttpError(404, "video_indisponible", "Cette vidéo n'est plus disponible.");
  }
  return c;
}

async function candidatDeGestion(request: Request, env: Env): Promise<CandidatRow> {
  const jeton = request.headers.get("x-gestion") ?? "";
  if (!JETON.test(jeton)) throw new HttpError(401, "lien_invalide", "Ce lien n'est pas valable.");
  const ligne = await env.DB.prepare("SELECT id FROM wm_candidats WHERE gestion_empreinte = ?").bind(await empreinteJeton(jeton)).first<{ id: string }>();
  const c = ligne ? await candidatParId(env.DB, ligne.id) : null;
  if (!c || c.supprime_le) throw new HttpError(401, "lien_invalide", "Ce lien n'est plus valable : tes données ont déjà été supprimées.");
  return c;
}

export function routesWhymePublic(r: Routeur): void {
  r.get("/api/whyme/videos/:code", async (ctx) => {
    const c = await videoPublique(ctx.env, ctx.params.code!);
    const camp = await campagneParId(ctx.env.DB, c.campagne_id);
    return json({ prenom: c.prenom, evenement: camp.config.evenement, aMiniature: Boolean(c.miniature_cle) });
  });

  // Lecture en continu ; pas de téléchargement proposé (le candidat ne télécharge pas sa vidéo, décision du 11/10/2026).
  r.get("/api/whyme/videos/:code/flux", async (ctx) => {
    const c = await videoPublique(ctx.env, ctx.params.code!);
    ctx.url.searchParams.delete("telecharger");
    const requete = new Request(ctx.url.toString(), ctx.request);
    return servirVideo(requete, ctx.env, c.montage_cle!, {
      type: "video/mp4", nom: `whyme-${c.prenom}.mp4`,
      journaliser: () => journaliser(ctx.env.DB, PUBLIC, { action: "whyme.video_publique.lecture", cibleType: "wm_candidat", cibleId: c.id }),
    });
  });

  r.get("/api/whyme/videos/:code/miniature", async (ctx) => {
    const c = await videoPublique(ctx.env, ctx.params.code!);
    return servirMiniature(ctx.env, c.miniature_cle);
  });

  // Sticker : PNG du QR code vers la page vidéo. Servi tant que la vidéo est en ligne.
  r.get("/api/whyme/videos/:code/sticker.png", async (ctx) => {
    const c = await videoPublique(ctx.env, ctx.params.code!);
    const png = await stickerPng(`${ctx.url.origin}/v/${c.code_public}`);
    return new Response(png, {
      headers: {
        "content-type": "image/png", "cache-control": "public, max-age=86400",
        "content-disposition": `inline; filename="whyme-qr-${c.code_public}.png"`, "x-content-type-options": "nosniff",
      },
    });
  });

  r.get("/api/whyme/entreprises/:id/logo", async (ctx) => {
    const e = await ctx.env.DB.prepare("SELECT logo_cle FROM wm_entreprises WHERE id = ?").bind(ctx.params.id!).first<{ logo_cle: string | null }>();
    const objet = e?.logo_cle ? await ctx.env.MEDIA.get(e.logo_cle) : null;
    if (!objet?.body) throw introuvable("Pas de logo");
    return new Response(objet.body, {
      headers: { "content-type": objet.httpMetadata?.contentType ?? "image/png", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" },
    });
  });

  // « Tu gardes la main » : état, puis suppression de la vidéo ou de toutes les données.
  r.post("/api/whyme/gestion", async (ctx) => {
    const c = await candidatDeGestion(ctx.request, ctx.env);
    const d = await lireJson(ctx.request);
    const action = d.action;
    if (action === "etat") {
      const camp = await campagneParId(ctx.env.DB, c.campagne_id);
      const entreprises = await ctx.env.DB.prepare(
        `SELECT e.nom FROM wm_candidatures ca JOIN wm_entreprises e ON e.id = ca.entreprise_id
          WHERE ca.candidat_id = ? AND ca.retiree_le IS NULL ORDER BY e.nom`,
      ).bind(c.id).all<{ nom: string }>();
      return json({
        prenom: c.prenom, evenement: camp.config.evenement, entreprises: entreprises.results.map((e) => e.nom),
        video: Boolean(c.montage_cle) && !c.video_supprimee_le, pagePublique: c.code_public && !c.video_supprimee_le ? `/v/${c.code_public}` : null,
        aCv: Boolean(c.cv_cle),
      });
    }
    if (action === "supprimer_video") {
      if (!c.video_supprimee_le) await supprimerVideo(ctx.env, c, CANDIDAT_EMAIL, "demande du candidat");
      return json({ ok: true });
    }
    if (action === "supprimer_tout") {
      await supprimerCandidat(ctx.env, c, CANDIDAT_EMAIL, "demande du candidat");
      return json({ ok: true });
    }
    throw invalide("Action inconnue");
  });
}
