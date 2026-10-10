// Parlomix : montages fabriqués dans Parlorama à partir des réponses d'une campagne.
// Le navigateur exécute le plan de montage puis envoie le film ; ici on vérifie le plan, on garde la trace de
// qui a monté quoi, et on ne sert plus un montage dès qu'une personne qui y figure a retiré son accord.

import type { Routeur } from "../routeur.ts";
import type { D1Database } from "../types.ts";
import { estWhyme, identifier, type Identite } from "../auth/identite.ts";
import { exiger, peut } from "../auth/droits.ts";
import { HttpError, conflit, interdit, introuvable, invalide, json, lireJson, maintenant, nouvelId, texte } from "../http.ts";
import { ligneJournal, journaliser } from "../journal.ts";
import { lireMiniature, servirMiniature, servirVideo } from "../media.ts";
import { chargerCampagne } from "./campagnes-commun.ts";

export const PARLOMIX_EXTRAITS_MAX = 20;
export const PARLOMIX_TAILLE_MAX = 95 * 1024 * 1024; // sous la limite d'envoi de Cloudflare (100 Mo)

interface LigneParlomix {
  id: string; campagne_id: string; type: string; session_id: string | null; etape_id: string | null; cabine_id: string | null;
  format: string; titre: string; sessions: string; nb_extraits: number; diffusable: number; statut: string;
  cle: string | null; cle_miniature: string | null; type_mime: string | null; octets: number | null; duree_ms: number | null; cree_par: string; cree_le: string;
}

/** Sessions de la liste qui ne peuvent plus être montrées (accord retiré ou données purgées). */
async function sessionsIndisponibles(db: D1Database, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const r = await db.prepare(
    `SELECT COUNT(*) AS n FROM sessions WHERE id IN (${ids.map(() => "?").join(",")}) AND (retiree_le IS NOT NULL OR purgee_le IS NOT NULL)`,
  ).bind(...ids).first<{ n: number }>();
  return r?.n ?? 0;
}

async function chargerParlomix(db: D1Database, id: Identite, parlomixId: string) {
  const p = await db.prepare("SELECT * FROM parlomix WHERE id = ?").bind(parlomixId).first<LigneParlomix>();
  if (!p) throw introuvable("Parlomix introuvable");
  const c = await chargerCampagne(db, id, p.campagne_id); // cloisonnement par client
  return { p, c };
}

export function routesParlomix(r: Routeur): void {
  // Déclaration d'un nouveau Parlomix : le plan est vérifié avant que le film ne soit envoyé.
  r.post("/api/espace/campagnes/:id/parlomix", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    const d = await lireJson(ctx.request);
    const type = d.type;
    if (type !== "personne" && type !== "question") throw invalide("type : « personne » ou « question »");
    const format = d.format;
    if (format !== "16:9" && format !== "9:16") throw invalide("format : « 16:9 » ou « 9:16 »");
    const titre = texte(d, "titre", { requis: true, max: 120 })!;
    const plan = d.plan as { sequences?: unknown; sessions?: unknown } | undefined;
    if (!plan || !Array.isArray(plan.sequences) || !Array.isArray(plan.sessions)) throw invalide("plan : plan de montage attendu");
    if (JSON.stringify(plan).length > 100_000) throw invalide("plan trop volumineux");

    const extraits = (plan.sequences as { type?: string; reponseId?: unknown }[]).filter((s) => s?.type === "clip");
    if (!extraits.length) throw invalide("plan : aucune réponse à monter");
    if (extraits.length > PARLOMIX_EXTRAITS_MAX) throw invalide(`plan : ${PARLOMIX_EXTRAITS_MAX} réponses au plus par Parlomix`);
    const idsReponses = extraits.map((e) => String(e.reponseId ?? ""));

    // Chaque réponse montée appartient à cette campagne et à une personne qui n'a pas retiré son accord.
    const { results: reponses } = await ctx.env.DB.prepare(
      `SELECT r.id, r.etape_id, s.id AS session_id, s.cabine_id, s.consent_diffusion, s.retiree_le, s.purgee_le
         FROM reponses r JOIN sessions s ON s.id = r.session_id
        WHERE s.campagne_id = ? AND r.id IN (${idsReponses.map(() => "?").join(",")})`,
    ).bind(c.id, ...idsReponses).all<{ id: string; etape_id: string; session_id: string; cabine_id: string | null; consent_diffusion: number; retiree_le: string | null; purgee_le: string | null }>();
    if (reponses.length !== new Set(idsReponses).size) throw invalide("plan : réponse inconnue dans cette campagne");
    if (reponses.some((x) => x.retiree_le || x.purgee_le)) throw new HttpError(410, "retiree", "Une personne de ce montage a retiré son accord");
    const sessions = [...new Set(reponses.map((x) => x.session_id))];

    let sessionId: string | null = null;
    let etapeId: string | null = null;
    let cabineId: string | null = null;
    if (type === "personne") {
      sessionId = texte(d, "session_id", { requis: true, max: 64 })!;
      if (sessions.length !== 1 || sessions[0] !== sessionId) throw invalide("plan : un Parlomix par personne ne monte que ses réponses");
    } else {
      etapeId = texte(d, "etape_id", { requis: true, max: 40 })!;
      if (reponses.some((x) => x.etape_id !== etapeId)) throw invalide("plan : toutes les réponses doivent porter sur la même question");
      cabineId = texte(d, "cabine_id", { max: 64 }) ?? null;
      if (cabineId && reponses.some((x) => x.cabine_id !== cabineId)) throw invalide("plan : réponses venant d'une autre cabine");
    }

    const p = {
      id: nouvelId(), campagne_id: c.id, type, session_id: sessionId, etape_id: etapeId, cabine_id: cabineId, format, titre,
      sessions, nb_extraits: extraits.length, diffusable: reponses.every((x) => x.consent_diffusion === 1),
    };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO parlomix (id, campagne_id, type, session_id, etape_id, cabine_id, format, titre, sessions, nb_extraits, diffusable, plan, cree_par, cree_le)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(p.id, p.campagne_id, p.type, p.session_id, p.etape_id, p.cabine_id, p.format, p.titre, JSON.stringify(p.sessions),
        p.nb_extraits, p.diffusable ? 1 : 0, JSON.stringify(plan), id.email, maintenant()),
      ligneJournal(ctx.env.DB, id, {
        action: "parlomix.creation", cibleType: "parlomix", cibleId: p.id, clientId: c.client_id,
        details: { campagne_id: c.id, type, format, extraits: p.nb_extraits },
      }),
    ]);
    return json({ parlomix: p }, 201);
  });

  // Envoi du film fabriqué dans Parlorama, par la personne qui l'a lancé.
  r.ajouter("PUT", "/api/espace/parlomix/:id/fichier", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const { p, c } = await chargerParlomix(ctx.env.DB, id, ctx.params.id!);
    if (p.cree_par !== id.email) throw interdit("Seule la personne qui a lancé ce montage peut envoyer le film");
    if (p.statut !== "attendu") throw conflit("Ce Parlomix a déjà reçu son film");
    const type = (ctx.request.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (type !== "video/mp4" && type !== "video/webm") throw new HttpError(415, "format", "Vidéo MP4 ou WebM attendue");
    if (Number(ctx.request.headers.get("content-length") ?? 0) > PARLOMIX_TAILLE_MAX) throw new HttpError(413, "trop_lourd", "Film trop lourd");
    const corps = await ctx.request.arrayBuffer();
    if (!corps.byteLength) throw invalide("Film vide");
    if (corps.byteLength > PARLOMIX_TAILLE_MAX) throw new HttpError(413, "trop_lourd", "Film trop lourd");
    if (await sessionsIndisponibles(ctx.env.DB, JSON.parse(p.sessions) as string[])) throw new HttpError(410, "retiree", "Une personne de ce montage a retiré son accord");
    const cle = `campagnes/${c.id}/parlomix/${p.id}.${type === "video/mp4" ? "mp4" : "webm"}`;
    await ctx.env.MEDIA.put(cle, corps, { httpMetadata: { contentType: type } });
    const duree = Math.max(0, Math.min(Number(ctx.request.headers.get("x-duree-ms") ?? 0) || 0, 3_600_000));
    await ctx.env.DB.prepare("UPDATE parlomix SET statut = 'pret', cle = ?, type_mime = ?, octets = ?, duree_ms = ?, pret_le = ? WHERE id = ? AND statut = 'attendu'")
      .bind(cle, type, corps.byteLength, duree, maintenant(), p.id).run();
    return json({ parlomix: { id: p.id, statut: "pret", octets: corps.byteLength } });
  });

  // Suppression d'un Parlomix (raté, obsolète) : par la personne qui l'a créé, ou par WhyMe.
  r.ajouter("DELETE", "/api/espace/parlomix/:id", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const { p, c } = await chargerParlomix(ctx.env.DB, id, ctx.params.id!);
    if (p.cree_par !== id.email && !(estWhyme(id) && peut(id, "campagnes.gerer"))) throw interdit("Seule la personne qui a créé ce Parlomix, ou WhyMe, peut le supprimer");
    const fichiers = [p.cle, p.cle_miniature].filter((x): x is string => Boolean(x));
    if (fichiers.length) await ctx.env.MEDIA.delete(fichiers);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("DELETE FROM parlomix WHERE id = ?").bind(p.id),
      ligneJournal(ctx.env.DB, id, { action: "parlomix.suppression", cibleType: "parlomix", cibleId: p.id, clientId: c.client_id, details: { campagne_id: c.id, titre: p.titre } }),
    ]);
    return json({ parlomix: { id: p.id, supprime: true } });
  });

  // Miniature d'un Parlomix (carte d'ouverture), envoyée par Parlorama avec le film.
  r.ajouter("PUT", "/api/espace/parlomix/:id/miniature", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const { p, c } = await chargerParlomix(ctx.env.DB, id, ctx.params.id!);
    if (p.cree_par !== id.email) throw interdit("Seule la personne qui a lancé ce montage peut envoyer sa miniature");
    const corps = await lireMiniature(ctx.request);
    const cle = `campagnes/${c.id}/parlomix/${p.id}.jpg`;
    await ctx.env.MEDIA.put(cle, corps, { httpMetadata: { contentType: "image/jpeg" } });
    await ctx.env.DB.prepare("UPDATE parlomix SET cle_miniature = ?, octets_miniature = ? WHERE id = ?").bind(cle, corps.byteLength, p.id).run();
    return json({ miniature: true }, 201);
  });
  r.get("/api/espace/parlomix/:id/miniature", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const { p } = await chargerParlomix(ctx.env.DB, id, ctx.params.id!);
    if (await sessionsIndisponibles(ctx.env.DB, JSON.parse(p.sessions) as string[])) throw new HttpError(410, "retiree", "Plus disponible");
    return servirMiniature(ctx.env, p.cle_miniature);
  });

  // Parlomix prêts d'une campagne, les plus récents d'abord.
  r.get("/api/espace/campagnes/:id/parlomix", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    const { results } = await ctx.env.DB.prepare(
      `SELECT p.id, p.type, p.session_id, p.etape_id, p.cabine_id, cb.nom AS cabine_nom, p.format, p.titre, p.sessions, p.nb_extraits,
              p.diffusable, p.type_mime, p.octets, p.duree_ms, p.cree_par, p.cree_le, p.cle_miniature IS NOT NULL AS miniature
         FROM parlomix p LEFT JOIN cabines cb ON cb.id = p.cabine_id
        WHERE p.campagne_id = ? AND p.statut = 'pret' ORDER BY p.cree_le DESC LIMIT 200`,
    ).bind(c.id).all<LigneParlomix & { cabine_nom: string | null }>();
    const liste = [];
    for (const { sessions, ...p } of results) {
      liste.push({ ...p, miniature: Boolean((p as unknown as { miniature: number }).miniature), diffusable: Boolean(p.diffusable), disponible: (await sessionsIndisponibles(ctx.env.DB, JSON.parse(sessions) as string[])) === 0 });
    }
    return json({ parlomix: liste });
  });

  // Le film. Chaque visionnage est journalisé ; plus rien n'est servi si une personne montée a retiré son accord.
  r.get("/api/espace/parlomix/:id/video", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const { p, c } = await chargerParlomix(ctx.env.DB, id, ctx.params.id!);
    if (p.statut !== "pret" || !p.cle) throw introuvable("Film pas encore envoyé");
    if (await sessionsIndisponibles(ctx.env.DB, JSON.parse(p.sessions) as string[])) {
      throw new HttpError(410, "retiree", "Une personne de ce montage a retiré son accord : il n'est plus disponible");
    }
    const ext = p.type_mime === "video/mp4" ? "mp4" : "webm";
    return servirVideo(ctx.request, ctx.env, p.cle, {
      type: p.type_mime ?? "video/webm",
      nom: `parlomix-${p.titre}-${p.format.replace(":", "x")}.${ext}`,
      journaliser: () => journaliser(ctx.env.DB, id, { action: "parlomix.visionnage", cibleType: "parlomix", cibleId: p.id, clientId: c.client_id, details: { campagne_id: c.id } }),
    });
  });
}
