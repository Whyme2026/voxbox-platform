// Lecture des réponses : sessions d'une campagne et vidéos. Ouvert aux comptes WhyMe et aux comptes du client
// propriétaire de la campagne (droit « reponses.lire ») ; chaque visionnage d'une vidéo est journalisé.
// On restitue ce que les gens disent : aucune note, aucun profil n'est calculé sur une personne.

import type { Routeur } from "../routeur.ts";
import type { D1Database } from "../types.ts";
import { identifier, type Identite } from "../auth/identite.ts";
import { exiger, verifierAppartenance } from "../auth/droits.ts";
import { HttpError, conflit, introuvable, json, maintenant } from "../http.ts";
import { journaliser, ligneJournal } from "../journal.ts";
import { servirVideo } from "../media.ts";
import { chargerCampagne } from "./campagnes-commun.ts";

interface LigneSession {
  id: string; prenom: string; cree_le: string; consent_diffusion: number; recontact: number;
  retiree_le: string | null; parcours_version_id: string; cabine_id: string | null; cabine_nom: string | null;
}
interface LigneReponse { id: string; session_id: string; etape_id: string; duree_ms: number | null; son_present: number | null; statut: string; cree_le: string }

/** Une cellule CSV (séparateur « ; », guillemets doublés). */
function cellule(v: unknown): string {
  const t = v === null || v === undefined ? "" : String(v);
  return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Session d'une campagne accessible à cette identité (404 sinon, même pour un autre client). */
async function chargerSession(db: D1Database, id: Identite, sessionId: string) {
  const s = await db.prepare(
    `SELECT s.id, s.campagne_id, s.consent_diffusion, s.retiree_le, c.client_id
       FROM sessions s JOIN campagnes c ON c.id = s.campagne_id WHERE s.id = ?`,
  ).bind(sessionId).first<{ id: string; campagne_id: string; consent_diffusion: number; retiree_le: string | null; client_id: string }>();
  if (!s) throw introuvable("Visiteur introuvable");
  verifierAppartenance(id, s.client_id);
  return s;
}

export function routesReponses(r: Routeur): void {
  // Retrait d'accord d'un visiteur (demande reçue par la marque ou par WhyMe) : ses vidéos, ses réponses et
  // les Parlomix où il apparaît sont supprimés ; il ne reste qu'une trace anonyme de la session et du retrait.
  r.post("/api/espace/sessions/:id/retrait", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "visiteurs.gerer");
    const s = await chargerSession(ctx.env.DB, id, ctx.params.id!);
    if (s.retiree_le) throw conflit("L'accord de ce visiteur a déjà été retiré");
    const { results: videos } = await ctx.env.DB.prepare("SELECT cle_source, cle_16_9, cle_9_16 FROM reponses WHERE session_id = ?").bind(s.id)
      .all<{ cle_source: string | null; cle_16_9: string | null; cle_9_16: string | null }>();
    const { results: montages } = await ctx.env.DB.prepare("SELECT id, cle FROM parlomix WHERE campagne_id = ? AND sessions LIKE ?")
      .bind(s.campagne_id, `%"${s.id}"%`).all<{ id: string; cle: string | null }>();
    // Fichiers d'abord : si le stockage échoue, rien n'est marqué comme supprimé et l'opération peut être refaite.
    const cles = [...videos.flatMap((v) => [v.cle_source, v.cle_16_9, v.cle_9_16]), ...montages.map((m) => m.cle)].filter((c): c is string => Boolean(c));
    if (cles.length) await ctx.env.MEDIA.delete(cles);
    const now = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("DELETE FROM reponses WHERE session_id = ?").bind(s.id),
      ...montages.map((m) => ctx.env.DB.prepare("DELETE FROM parlomix WHERE id = ?").bind(m.id)),
      ctx.env.DB.prepare("UPDATE sessions SET retiree_le = ?, prenom = '(retiré)', nom = NULL, email = NULL, recontact = 0, consent_diffusion = 0 WHERE id = ?").bind(now, s.id),
      ligneJournal(ctx.env.DB, id, {
        action: "session.retrait", cibleType: "session", cibleId: s.id, clientId: s.client_id,
        details: { campagne_id: s.campagne_id, videos_supprimees: videos.length, parlomix_supprimes: montages.length },
      }),
    ]);
    return json({ session: { id: s.id, retiree_le: now, videos_supprimees: videos.length, parlomix_supprimes: montages.length } });
  });

  // Retrait du seul accord de diffusion publique (les réponses restent pour l'usage interne).
  r.post("/api/espace/sessions/:id/diffusion-retiree", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "visiteurs.gerer");
    const s = await chargerSession(ctx.env.DB, id, ctx.params.id!);
    if (s.retiree_le) throw conflit("L'accord de ce visiteur a déjà été retiré");
    if (!s.consent_diffusion) throw conflit("Ce visiteur n'avait pas accepté la diffusion publique");
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE sessions SET consent_diffusion = 0 WHERE id = ?").bind(s.id),
      // Les Parlomix où il apparaît ne sont plus diffusables.
      ctx.env.DB.prepare("UPDATE parlomix SET diffusable = 0 WHERE campagne_id = ? AND sessions LIKE ?").bind(s.campagne_id, `%"${s.id}"%`),
      ligneJournal(ctx.env.DB, id, { action: "session.diffusion_retiree", cibleType: "session", cibleId: s.id, clientId: s.client_id, details: { campagne_id: s.campagne_id } }),
    ]);
    return json({ session: { id: s.id, consent_diffusion: false } });
  });

  // Export des visiteurs d'une campagne (tableur). L'e-mail n'y figure que si la personne accepte d'être recontactée.
  r.get("/api/espace/campagnes/:id/export.csv", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    const { results } = await ctx.env.DB.prepare(
      `SELECT s.cree_le, s.prenom, s.nom, s.email, s.recontact, s.consent_diffusion, s.retiree_le, cb.nom AS cabine,
              (SELECT COUNT(*) FROM reponses r WHERE r.session_id = s.id AND r.cle_source IS NOT NULL) AS reponses
         FROM sessions s LEFT JOIN cabines cb ON cb.id = s.cabine_id
        WHERE s.campagne_id = ? AND s.purgee_le IS NULL ORDER BY s.cree_le`,
    ).bind(c.id).all<{ cree_le: string; prenom: string; nom: string | null; email: string | null; recontact: number; consent_diffusion: number; retiree_le: string | null; cabine: string | null; reponses: number }>();
    await journaliser(ctx.env.DB, id, { action: "campagne.export", cibleType: "campagne", cibleId: c.id, clientId: c.client_id, details: { lignes: results.length } });
    const lignes = [
      ["Date (UTC)", "Prénom", "Nom", "E-mail (recontact accepté)", "Recontact", "Diffusion publique", "Cabine", "Réponses vidéo", "Accord retiré"],
      ...results.map((x) => [
        x.cree_le.replace("T", " ").slice(0, 16), x.prenom, x.nom ?? "", x.recontact ? (x.email ?? "") : "",
        x.recontact ? "oui" : "non", x.consent_diffusion ? "oui" : "non", x.cabine ?? "", x.reponses, x.retiree_le ? "oui" : "",
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
    const ext = rep.cle_source.endsWith(".mp4") ? "mp4" : "webm";
    return servirVideo(ctx.request, ctx.env, rep.cle_source, {
      type: ext === "mp4" ? "video/mp4" : "video/webm",
      nom: `${rep.etape_id}.${ext}`,
      journaliser: () => journaliser(ctx.env.DB, id, {
        action: "reponse.visionnage", cibleType: "reponse", cibleId: rep.id, clientId: rep.client_id,
        details: { campagne_id: rep.campagne_id, session_id: rep.session_id, etape: rep.etape_id },
      }),
    });
  });
}
