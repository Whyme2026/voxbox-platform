// Lecture des réponses : sessions d'une campagne et vidéos. Ouvert aux comptes WhyMe et aux comptes du client
// propriétaire de la campagne (droit « reponses.lire ») ; chaque visionnage d'une vidéo est journalisé.
// On restitue ce que les gens disent : aucune note, aucun profil n'est calculé sur une personne.

import type { Routeur } from "../routeur.ts";
import type { D1Database } from "../types.ts";
import { identifier, type Identite } from "../auth/identite.ts";
import { exiger, verifierAppartenance } from "../auth/droits.ts";
import { HttpError, introuvable, invalide, json } from "../http.ts";
import { journaliser } from "../journal.ts";
import { retirerAccord, retirerDiffusion, sessionPour } from "../rgpd/retrait.ts";
import { lireMiniature, servirMiniature, servirVideo } from "../media.ts";
import { chargerCampagne } from "./campagnes-commun.ts";
import { volumeCampagne } from "../volumes.ts";

interface LigneSession {
  id: string; prenom: string; cree_le: string; consent_diffusion: number; recontact: number;
  retiree_le: string | null; parcours_version_id: string; cabine_id: string | null; cabine_nom: string | null;
}
interface LigneReponse { id: string; session_id: string; etape_id: string; duree_ms: number | null; son_present: number | null; statut: string; cree_le: string; miniature: number }

/** Une cellule CSV (séparateur « ; », guillemets doublés). */
function cellule(v: unknown): string {
  const t = v === null || v === undefined ? "" : String(v);
  return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

interface EtapeLue {
  id: string; type: string; titreCourt?: string; titre?: string; texte?: string; fond?: string; visuel?: string;
  options?: { id: string; libelle: string; visuel?: string }[];
}

/**
 * Libellés des questions et des choix, toutes versions du parcours confondues (une session garde la version qu'elle a
 * jouée ; la plus récente donne le libellé). Avec l'habillage de la version la plus récente, pour les Parlomix.
 */
async function libellesParcours(db: D1Database, campagneId: string) {
  const { results: versions } = await db.prepare("SELECT config FROM parcours_versions WHERE campagne_id = ? ORDER BY numero")
    .bind(campagneId).all<{ config: string }>();
  const questions = new Map<string, { id: string; titre: string; texte: string; fond?: string; visuel?: string }>();
  const choix = new Map<string, { id: string; titre: string; options: { id: string; libelle: string; visuel?: string }[] }>();
  let habillage: unknown = null;
  for (const v of versions) {
    const p = JSON.parse(v.config) as { habillage?: unknown; etapes: EtapeLue[] };
    habillage = p.habillage ?? null;
    for (const e of p.etapes) {
      if (e.type === "question") {
        questions.delete(e.id);
        questions.set(e.id, { id: e.id, titre: e.titreCourt ?? e.texte ?? e.id, texte: e.texte ?? "", fond: e.fond, visuel: e.visuel });
      } else if (e.type === "choix") {
        const anciennes = choix.get(e.id)?.options ?? [];
        const options = [...(e.options ?? []).map((o) => ({ id: o.id, libelle: o.libelle, ...(o.visuel ? { visuel: o.visuel } : {}) })), ...anciennes.filter((a) => !e.options?.some((o) => o.id === a.id))];
        choix.delete(e.id);
        choix.set(e.id, { id: e.id, titre: (e.titre ?? e.id).replace(/,?[  ]?\{prenom\}/g, ""), options });
      }
    }
  }
  return { questions: [...questions.values()], choix: [...choix.values()], habillage };
}

/** Choix des visiteurs d'une campagne, par session : { session → { étape → option } }. */
async function choixDesSessions(db: D1Database, campagneId: string) {
  const { results } = await db.prepare(
    `SELECT x.session_id, x.etape_id, x.option_id FROM choix x JOIN sessions s ON s.id = x.session_id
      WHERE s.campagne_id = ? AND s.purgee_le IS NULL AND s.retiree_le IS NULL`,
  ).bind(campagneId).all<{ session_id: string; etape_id: string; option_id: string }>();
  const parSession = new Map<string, Record<string, string>>();
  for (const x of results) parSession.set(x.session_id, { ...(parSession.get(x.session_id) ?? {}), [x.etape_id]: x.option_id });
  return parSession;
}

/** Session d'une campagne accessible à cette identité (404 sinon, même pour un autre client). */
async function chargerSession(db: D1Database, id: Identite, sessionId: string) {
  const s = await sessionPour(db, "id", sessionId);
  if (!s) throw introuvable("Visiteur introuvable");
  verifierAppartenance(id, s.client_id);
  return s;
}

export function routesReponses(r: Routeur): void {
  // Volume de stockage de la campagne (vidéos, miniatures, Parlomix). Aucune donnée personnelle.
  r.get("/api/espace/campagnes/:id/volume", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    return json({ volume: await volumeCampagne(ctx.env, c.id) });
  });

  // Retrait d'accord demandé à la marque ou à WhyMe (voir rgpd/retrait.ts).
  r.post("/api/espace/sessions/:id/retrait", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "visiteurs.gerer");
    const s = await chargerSession(ctx.env.DB, id, ctx.params.id!);
    const res = await retirerAccord(ctx.env, id, s, "parlorama");
    return json({ session: { id: s.id, ...res } });
  });

  // Retrait du seul accord de diffusion publique (les réponses restent pour l'usage interne).
  r.post("/api/espace/sessions/:id/diffusion-retiree", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "visiteurs.gerer");
    const s = await chargerSession(ctx.env.DB, id, ctx.params.id!);
    await retirerDiffusion(ctx.env, id, s, "parlorama");
    return json({ session: { id: s.id, consent_diffusion: false } });
  });

  // Export des visiteurs d'une campagne (tableur). L'e-mail n'y figure que si la personne accepte d'être recontactée.
  r.get("/api/espace/campagnes/:id/export.csv", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    const { results } = await ctx.env.DB.prepare(
      `SELECT s.id, s.cree_le, s.prenom, s.nom, s.email, s.recontact, s.consent_diffusion, s.retiree_le, cb.nom AS cabine,
              (SELECT COUNT(*) FROM reponses r WHERE r.session_id = s.id AND r.cle_source IS NOT NULL) AS reponses
         FROM sessions s LEFT JOIN cabines cb ON cb.id = s.cabine_id
        WHERE s.campagne_id = ? AND s.purgee_le IS NULL ORDER BY s.cree_le`,
    ).bind(c.id).all<{ id: string; cree_le: string; prenom: string; nom: string | null; email: string | null; recontact: number; consent_diffusion: number; retiree_le: string | null; cabine: string | null; reponses: number }>();
    await journaliser(ctx.env.DB, id, { action: "campagne.export", cibleType: "campagne", cibleId: c.id, clientId: c.client_id, details: { lignes: results.length } });
    // Une colonne par étape « choix » (qualification, aiguillage) : le libellé de l'option choisie.
    const { choix } = await libellesParcours(ctx.env.DB, c.id);
    const choixParSession = await choixDesSessions(ctx.env.DB, c.id);
    const libelle = (etape: string, option: string | undefined) => choix.find((x) => x.id === etape)?.options.find((o) => o.id === option)?.libelle ?? option ?? "";
    const lignes = [
      ["Date (UTC)", "Prénom", "Nom", "E-mail (recontact accepté)", "Recontact", "Diffusion publique", "Cabine", "Réponses vidéo", "Accord retiré", ...choix.map((x) => x.titre)],
      ...results.map((x) => [
        x.cree_le.replace("T", " ").slice(0, 16), x.prenom, x.nom ?? "", x.recontact ? (x.email ?? "") : "",
        x.recontact ? "oui" : "non", x.consent_diffusion ? "oui" : "non", x.cabine ?? "", x.reponses, x.retiree_le ? "oui" : "",
        ...choix.map((e) => libelle(e.id, choixParSession.get(x.id)?.[e.id])),
      ]),
    ];
    const csv = "\uFEFF" + lignes.map((l) => l.map(cellule).join(";")).join("\r\n") + "\r\n";
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8", "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="visiteurs-${c.slug}.csv"`,
      },
    });
  });

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
      `SELECT r.id, r.session_id, r.etape_id, r.duree_ms, r.son_present, r.statut, r.cree_le, r.cle_miniature IS NOT NULL AS miniature
         FROM reponses r JOIN sessions s ON s.id = r.session_id
        WHERE s.campagne_id = ? AND s.purgee_le IS NULL AND r.cle_source IS NOT NULL`,
    ).bind(c.id).all<LigneReponse>();

    const { questions, choix, habillage } = await libellesParcours(ctx.env.DB, c.id);
    const ordre = questions.map((q) => q.id);
    const choixParSession = await choixDesSessions(ctx.env.DB, c.id);

    const parSession = new Map<string, LigneReponse[]>();
    for (const rep of reponses) parSession.set(rep.session_id, [...(parSession.get(rep.session_id) ?? []), rep]);
    const rang = (etape: string) => { const i = ordre.indexOf(etape); return i < 0 ? 999 : i; };

    const total = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE campagne_id = ? AND purgee_le IS NULL").bind(c.id).first<{ n: number }>();
    return json({
      total: total?.n ?? 0,
      questions,
      choix,
      habillage,
      sessions: sessions.map((s) => ({
        ...s,
        choix: choixParSession.get(s.id) ?? {},
        consent_diffusion: Boolean(s.consent_diffusion),
        recontact: Boolean(s.recontact),
        // Accord retiré : la session reste visible pour la traçabilité, mais plus aucune vidéo n'est servie.
        reponses: s.retiree_le ? [] : (parSession.get(s.id) ?? []).sort((a, b) => rang(a.etape_id) - rang(b.etape_id))
          .map(({ session_id: _, ...rep }) => ({ ...rep, miniature: Boolean(rep.miniature), son_present: rep.son_present === null ? null : Boolean(rep.son_present) })),
      })),
    });
  });

  // Miniature d'une réponse (pas de ligne de journal : c'est une vignette de liste, servie au même périmètre).
  async function reponseAccessible(ctx: Parameters<Parameters<Routeur["get"]>[1]>[0]) {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const rep = await ctx.env.DB.prepare(
      `SELECT r.id, r.cle_miniature, s.campagne_id, s.id AS session_id, r.etape_id, s.retiree_le, c.client_id
         FROM reponses r JOIN sessions s ON s.id = r.session_id JOIN campagnes c ON c.id = s.campagne_id WHERE r.id = ?`,
    ).bind(ctx.params.id).first<{ id: string; cle_miniature: string | null; campagne_id: string; session_id: string; etape_id: string; retiree_le: string | null; client_id: string }>();
    if (!rep) throw introuvable("Réponse introuvable");
    verifierAppartenance(id, rep.client_id);
    if (rep.retiree_le) throw new HttpError(410, "retiree", "Cette réponse n'est plus disponible");
    return rep;
  }
  r.get("/api/espace/reponses/:id/miniature", async (ctx) => servirMiniature(ctx.env, (await reponseAccessible(ctx)).cle_miniature));
  // Miniature fabriquée par Parlorama pour une réponse enregistrée avant les miniatures. Jamais remplacée.
  r.ajouter("PUT", "/api/espace/reponses/:id/miniature", async (ctx) => {
    const rep = await reponseAccessible(ctx);
    if (rep.cle_miniature) return json({ miniature: true });
    const corps = await lireMiniature(ctx.request);
    const cle = `campagnes/${rep.campagne_id}/sessions/${rep.session_id}/${rep.etape_id}.jpg`;
    await ctx.env.MEDIA.put(cle, corps, { httpMetadata: { contentType: "image/jpeg" } });
    await ctx.env.DB.prepare("UPDATE reponses SET cle_miniature = ?, octets_miniature = ? WHERE id = ? AND cle_miniature IS NULL").bind(cle, corps.byteLength, rep.id).run();
    return json({ miniature: true }, 201);
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
    const ext = rep.cle_source.endsWith(".mp4") ? "mp4" : "webm";
    return servirVideo(ctx.request, ctx.env, rep.cle_source, {
      type: ext === "mp4" ? "video/mp4" : "video/webm",
      nom: `${rep.etape_id}.${ext}`,
      journaliser: () => journaliser(ctx.env.DB, id, {
        // Parlorama télécharge une fois les anciennes vidéos pour en tirer une miniature : tracé à part.
        action: ctx.url.searchParams.get("pour") === "miniature" ? "reponse.miniature" : "reponse.visionnage",
        cibleType: "reponse", cibleId: rep.id, clientId: rep.client_id,
        details: { campagne_id: rep.campagne_id, session_id: rep.session_id, etape: rep.etape_id },
      }),
    });
  });
}
