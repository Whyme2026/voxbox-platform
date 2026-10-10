// Lecture des réponses : sessions d'une campagne et vidéos. Ouvert aux comptes WhyMe et aux comptes du client
// propriétaire de la campagne (droit « reponses.lire ») ; chaque visionnage d'une vidéo est journalisé.
// On restitue ce que les gens disent : aucune note, aucun profil n'est calculé sur une personne.

import type { Routeur } from "../routeur.ts";
import { identifier } from "../auth/identite.ts";
import { exiger, verifierAppartenance } from "../auth/droits.ts";
import { HttpError, introuvable, json } from "../http.ts";
import { journaliser } from "../journal.ts";
import { chargerCampagne } from "./campagnes-commun.ts";

interface LigneSession {
  id: string; prenom: string; cree_le: string; consent_diffusion: number; recontact: number;
  retiree_le: string | null; parcours_version_id: string; cabine_id: string | null; cabine_nom: string | null;
}
interface LigneReponse { id: string; session_id: string; etape_id: string; duree_ms: number | null; son_present: number | null; statut: string; cree_le: string }

export function routesReponses(r: Routeur): void {
  // Sessions d'une campagne (les plus récentes d'abord) avec leurs réponses, et le libellé de chaque question.
  r.get("/api/espace/campagnes/:id/sessions", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    const limite = Math.min(Math.max(Number(ctx.url.searchParams.get("limite") ?? 100) || 100, 1), 300);

    const { results: sessions } = await ctx.env.DB.prepare(
      `SELECT s.id, s.prenom, s.cree_le, s.consent_diffusion, s.recontact, s.retiree_le, s.parcours_version_id, s.cabine_id, cb.nom AS cabine_nom
         FROM sessions s LEFT JOIN cabines cb ON cb.id = s.cabine_id
        WHERE s.campagne_id = ? AND s.purgee_le IS NULL
        ORDER BY s.cree_le DESC LIMIT ${limite}`,
    ).bind(c.id).all<LigneSession>();
    const { results: reponses } = await ctx.env.DB.prepare(
      `SELECT r.id, r.session_id, r.etape_id, r.duree_ms, r.son_present, r.statut, r.cree_le
         FROM reponses r JOIN sessions s ON s.id = r.session_id
        WHERE s.campagne_id = ? AND s.purgee_le IS NULL AND r.cle_source IS NOT NULL`,
    ).bind(c.id).all<LigneReponse>();

    // Libellés des questions, toutes versions du parcours confondues (une session garde la version qu'elle a jouée).
    const { results: versions } = await ctx.env.DB.prepare("SELECT config FROM parcours_versions WHERE campagne_id = ? ORDER BY numero")
      .bind(c.id).all<{ config: string }>();
    const libelles: Record<string, { titre: string; texte: string }> = {};
    const ordre: string[] = [];
    for (const v of versions) {
      for (const e of (JSON.parse(v.config) as { etapes: { id: string; type: string; titreCourt?: string; texte?: string }[] }).etapes) {
        if (e.type !== "question") continue;
        if (!ordre.includes(e.id)) ordre.push(e.id);
        libelles[e.id] = { titre: e.titreCourt ?? e.texte ?? e.id, texte: e.texte ?? "" };
      }
    }

    const parSession = new Map<string, LigneReponse[]>();
    for (const rep of reponses) parSession.set(rep.session_id, [...(parSession.get(rep.session_id) ?? []), rep]);
    const rang = (etape: string) => { const i = ordre.indexOf(etape); return i < 0 ? 999 : i; };

    const total = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE campagne_id = ? AND purgee_le IS NULL").bind(c.id).first<{ n: number }>();
    return json({
      total: total?.n ?? 0,
      questions: ordre.map((q) => ({ id: q, ...libelles[q]! })),
      sessions: sessions.map((s) => ({
        ...s,
        consent_diffusion: Boolean(s.consent_diffusion),
        recontact: Boolean(s.recontact),
        // Accord retiré : la session reste visible pour la traçabilité, mais plus aucune vidéo n'est servie.
        reponses: s.retiree_le ? [] : (parSession.get(s.id) ?? []).sort((a, b) => rang(a.etape_id) - rang(b.etape_id))
          .map(({ session_id: _, ...rep }) => ({ ...rep, son_present: rep.son_present === null ? null : Boolean(rep.son_present) })),
      })),
    });
  });

  // Vidéo d'une réponse. Le visionnage est tracé dans le journal (qui, quoi, quand).
  r.get("/api/espace/reponses/:id/video", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const rep = await ctx.env.DB.prepare(
      `SELECT r.id, r.etape_id, r.cle_source, s.id AS session_id, s.retiree_le, s.purgee_le, c.client_id, c.id AS campagne_id
         FROM reponses r JOIN sessions s ON s.id = r.session_id JOIN campagnes c ON c.id = s.campagne_id
        WHERE r.id = ?`,
    ).bind(ctx.params.id).first<{
      id: string; etape_id: string; cle_source: string | null; session_id: string; retiree_le: string | null;
      purgee_le: string | null; client_id: string; campagne_id: string;
    }>();
    if (!rep) throw introuvable("Réponse introuvable");
    verifierAppartenance(id, rep.client_id);
    if (rep.retiree_le || rep.purgee_le) throw new HttpError(410, "retiree", "Cette réponse n'est plus disponible");
    if (!rep.cle_source) throw introuvable("Vidéo pas encore reçue");
    const objet = await ctx.env.MEDIA.get(rep.cle_source);
    if (!objet?.body) throw introuvable("Vidéo introuvable dans le stockage");
    await journaliser(ctx.env.DB, id, {
      action: "reponse.visionnage", cibleType: "reponse", cibleId: rep.id, clientId: rep.client_id,
      details: { campagne_id: rep.campagne_id, session_id: rep.session_id, etape: rep.etape_id },
    });
    return new Response(objet.body, {
      headers: {
        "content-type": objet.httpMetadata?.contentType ?? (rep.cle_source.endsWith(".mp4") ? "video/mp4" : "video/webm"),
        "content-length": String(objet.size),
        "cache-control": "private, no-store",
        "content-disposition": `inline; filename="${rep.etape_id}.${rep.cle_source.endsWith(".mp4") ? "mp4" : "webm"}"`,
      },
    });
  });
}
