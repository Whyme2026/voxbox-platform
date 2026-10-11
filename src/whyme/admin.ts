// Paramétrage de Why me par WhyMe (Parlorama, /admin/whyme.html, protégé par Cloudflare Access) :
// entreprises recruteuses et leurs logos, comptes recruteurs, campagnes (configuration JSON, entreprises, statut),
// suivi des interviews (montage, e-mail), boîte des e-mails de test. Réservé aux comptes WhyMe.

import type { Routeur, Contexte } from "../routeur.ts";
import type { Identite } from "../auth/identite.ts";
import { estWhyme, identifier } from "../auth/identite.ts";
import { exiger, type Action } from "../auth/droits.ts";
import { conflit, HttpError, interdit, introuvable, invalide, json, lireJson, maintenant, nouvelId, texte } from "../http.ts";
import { codeAleatoire } from "../auth/cabine.ts";
import { journaliser, ligneJournal } from "../journal.ts";
import { servirVideo } from "../media.ts";
import { slugifier } from "../routes/admin.ts";
import { empreinteTextes, genererTextes, validerConfig } from "./config.ts";
import { campagneParId, candidatParId, entreprisesDeCampagne, supprimerCandidat } from "./commun.ts";
import { declencherMontage, planMontage } from "./montage.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGOS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

async function whyme(ctx: Contexte, action: Action): Promise<Identite> {
  const id = await identifier(ctx.request, ctx.env);
  if (!estWhyme(id)) throw interdit();
  exiger(id, action);
  return id;
}

/** Entreprises proposées : identifiants existants, sans doublon. */
async function lireEntreprises(ctx: Contexte, v: unknown): Promise<string[]> {
  if (!Array.isArray(v) || !v.length) throw invalide("Au moins une entreprise");
  const ids = [...new Set(v)];
  for (const e of ids) {
    if (typeof e !== "string" || !(await ctx.env.DB.prepare("SELECT 1 FROM wm_entreprises WHERE id = ?").bind(e).first())) throw invalide("Entreprise inconnue");
  }
  return ids as string[];
}

export function routesWhymeAdmin(r: Routeur): void {
  // ------------------------------------------------------------------ entreprises
  r.get("/api/admin/whyme/entreprises", async (ctx) => {
    await whyme(ctx, "campagnes.lire");
    const e = await ctx.env.DB.prepare(
      `SELECT e.id, e.nom, e.slug, e.logo_cle IS NOT NULL AS a_logo,
              (SELECT COUNT(*) FROM wm_recruteurs r WHERE r.entreprise_id = e.id AND r.actif = 1) AS recruteurs
         FROM wm_entreprises e ORDER BY e.nom`,
    ).all<Record<string, unknown>>();
    return json({ entreprises: e.results.map((x) => ({ ...x, logo: x.a_logo ? `/api/whyme/entreprises/${x.id}/logo` : null })) });
  });

  r.post("/api/admin/whyme/entreprises", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const d = await lireJson(ctx.request);
    const nom = texte(d, "nom", { requis: true, max: 80 })!;
    const slug = slugifier(nom);
    if (await ctx.env.DB.prepare("SELECT 1 FROM wm_entreprises WHERE slug = ?").bind(slug).first()) throw conflit("Cette entreprise existe déjà");
    const e = { id: nouvelId(), nom, slug };
    const t = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO wm_entreprises (id, slug, nom, cree_le, maj_le) VALUES (?, ?, ?, ?, ?)").bind(e.id, slug, nom, t, t),
      ligneJournal(ctx.env.DB, id, { action: "whyme.entreprise.creation", cibleType: "wm_entreprise", cibleId: e.id, details: { nom } }),
    ]);
    return json({ entreprise: e }, 201);
  });

  r.patch("/api/admin/whyme/entreprises/:id", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const d = await lireJson(ctx.request);
    const nom = texte(d, "nom", { requis: true, max: 80 })!;
    const res = await ctx.env.DB.prepare("UPDATE wm_entreprises SET nom = ?, maj_le = ? WHERE id = ?").bind(nom, maintenant(), ctx.params.id!).run();
    if (!res.meta.changes) throw introuvable("Entreprise introuvable");
    await journaliser(ctx.env.DB, id, { action: "whyme.entreprise.modification", cibleType: "wm_entreprise", cibleId: ctx.params.id!, details: { nom } });
    return json({ ok: true });
  });

  r.ajouter("PUT", "/api/admin/whyme/entreprises/:id/logo", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const e = await ctx.env.DB.prepare("SELECT id, logo_cle FROM wm_entreprises WHERE id = ?").bind(ctx.params.id!).first<{ id: string; logo_cle: string | null }>();
    if (!e) throw introuvable("Entreprise introuvable");
    const type = (ctx.request.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const ext = LOGOS[type];
    if (!ext) throw new HttpError(415, "format", "Logo PNG, JPEG ou WebP attendu (le SVG n'est pas accepté)");
    const corps = await ctx.request.arrayBuffer();
    if (!corps.byteLength) throw invalide("Logo vide");
    if (corps.byteLength > 1024 * 1024) throw new HttpError(413, "trop_lourd", "Logo trop lourd (1 Mo au plus)");
    const cle = `whyme/entreprises/${e.id}/logo.${ext}`;
    if (e.logo_cle && e.logo_cle !== cle) await ctx.env.MEDIA.delete(e.logo_cle);
    await ctx.env.MEDIA.put(cle, corps, { httpMetadata: { contentType: type } });
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE wm_entreprises SET logo_cle = ?, maj_le = ? WHERE id = ?").bind(cle, maintenant(), e.id),
      ligneJournal(ctx.env.DB, id, { action: "whyme.entreprise.logo", cibleType: "wm_entreprise", cibleId: e.id }),
    ]);
    return json({ logo: `/api/whyme/entreprises/${e.id}/logo` });
  });

  // ------------------------------------------------------------------ recruteurs
  r.get("/api/admin/whyme/recruteurs", async (ctx) => {
    await whyme(ctx, "utilisateurs.gerer");
    const res = await ctx.env.DB.prepare(
      `SELECT r.id, r.email, r.entreprise_id, e.nom AS entreprise, r.actif, r.cree_le FROM wm_recruteurs r
         JOIN wm_entreprises e ON e.id = r.entreprise_id ORDER BY e.nom, r.email`,
    ).all();
    return json({ recruteurs: res.results });
  });

  r.post("/api/admin/whyme/recruteurs", async (ctx) => {
    const id = await whyme(ctx, "utilisateurs.gerer");
    const d = await lireJson(ctx.request);
    const email = texte(d, "email", { requis: true, max: 200 })!.toLowerCase();
    if (!EMAIL.test(email)) throw invalide("Adresse e-mail invalide");
    const entreprise = texte(d, "entreprise_id", { requis: true, max: 40 })!;
    if (!(await ctx.env.DB.prepare("SELECT 1 FROM wm_entreprises WHERE id = ?").bind(entreprise).first())) throw invalide("Entreprise inconnue");
    if (await ctx.env.DB.prepare("SELECT 1 FROM wm_recruteurs WHERE email = ?").bind(email).first()) throw conflit("Ce recruteur existe déjà");
    const rec = { id: nouvelId(), email, entreprise_id: entreprise };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO wm_recruteurs (id, email, entreprise_id, cree_le) VALUES (?, ?, ?, ?)").bind(rec.id, email, entreprise, maintenant()),
      ligneJournal(ctx.env.DB, id, { action: "whyme.recruteur.creation", cibleType: "wm_recruteur", cibleId: rec.id, details: { email, entreprise } }),
    ]);
    return json({ recruteur: rec }, 201);
  });

  r.patch("/api/admin/whyme/recruteurs/:id", async (ctx) => {
    const id = await whyme(ctx, "utilisateurs.gerer");
    const d = await lireJson(ctx.request);
    if (typeof d.actif !== "boolean") throw invalide("actif : booléen attendu");
    const res = await ctx.env.DB.prepare("UPDATE wm_recruteurs SET actif = ? WHERE id = ?").bind(d.actif ? 1 : 0, ctx.params.id!).run();
    if (!res.meta.changes) throw introuvable("Recruteur introuvable");
    if (!d.actif) await ctx.env.DB.prepare("DELETE FROM wm_jetons_recruteur WHERE recruteur_id = ?").bind(ctx.params.id!).run();
    await journaliser(ctx.env.DB, id, { action: d.actif ? "whyme.recruteur.reactivation" : "whyme.recruteur.desactivation", cibleType: "wm_recruteur", cibleId: ctx.params.id! });
    return json({ ok: true });
  });

  // ------------------------------------------------------------------ campagnes
  r.get("/api/admin/whyme/campagnes", async (ctx) => {
    await whyme(ctx, "campagnes.lire");
    const res = await ctx.env.DB.prepare(
      `SELECT w.id, w.code, w.nom, w.statut, w.config, w.cree_le,
              (SELECT COUNT(*) FROM wm_candidats c WHERE c.campagne_id = w.id AND c.supprime_le IS NULL) AS candidats,
              (SELECT COUNT(*) FROM wm_candidats c WHERE c.campagne_id = w.id AND c.statut = 'pret') AS prets
         FROM wm_campagnes w ORDER BY w.cree_le DESC`,
    ).all<Record<string, any>>();
    const campagnes = [];
    for (const c of res.results) {
      campagnes.push({ ...c, config: JSON.parse(c.config), entreprises: (await entreprisesDeCampagne(ctx.env.DB, c.id)).map((e) => ({ id: e.id, nom: e.nom })) });
    }
    return json({ campagnes });
  });

  r.post("/api/admin/whyme/campagnes", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const d = await lireJson(ctx.request);
    const nom = texte(d, "nom", { requis: true, max: 80 })!;
    const config = validerConfig(d.config);
    const entreprises = await lireEntreprises(ctx, d.entreprises);
    const textes = genererTextes(config);
    const c = { id: nouvelId(), code: slugifier(texte(d, "code", { max: 30 }) ?? `${slugifier(config.evenement).slice(0, 20)}-${codeAleatoire(4).toLowerCase()}`) };
    if (await ctx.env.DB.prepare("SELECT 1 FROM wm_campagnes WHERE code = ?").bind(c.code).first()) throw conflit("Ce code de campagne est déjà pris");
    const t = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO wm_campagnes (id, code, nom, config, textes, textes_empreinte, cree_par, cree_le, maj_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(c.id, c.code, nom, JSON.stringify(config), JSON.stringify(textes), await empreinteTextes(textes), id.email, t, t),
      ...entreprises.map((e, i) => ctx.env.DB.prepare("INSERT INTO wm_campagne_entreprises (campagne_id, entreprise_id, ordre) VALUES (?, ?, ?)").bind(c.id, e, i)),
      ligneJournal(ctx.env.DB, id, { action: "whyme.campagne.creation", cibleType: "wm_campagne", cibleId: c.id, details: { nom, code: c.code } }),
    ]);
    return json({ campagne: { ...c, nom, statut: "brouillon" } }, 201);
  });

  // Modification : seulement en brouillon (une campagne active ne change pas sous les pieds d'un candidat).
  r.patch("/api/admin/whyme/campagnes/:id", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const c = await campagneParId(ctx.env.DB, ctx.params.id!);
    const d = await lireJson(ctx.request);
    const nom = texte(d, "nom", { max: 80 }) ?? c.nom;
    if (c.statut !== "brouillon" && (d.config !== undefined || d.entreprises !== undefined)) {
      throw conflit("Questionnaire et entreprises ne changent plus une fois la campagne ouverte");
    }
    const config = d.config === undefined ? c.config : validerConfig(d.config);
    const textes = genererTextes(config);
    const lots = [
      ctx.env.DB.prepare("UPDATE wm_campagnes SET nom = ?, config = ?, textes = ?, textes_empreinte = ?, maj_le = ? WHERE id = ?")
        .bind(nom, JSON.stringify(config), JSON.stringify(textes), await empreinteTextes(textes), maintenant(), c.id),
      ligneJournal(ctx.env.DB, id, { action: "whyme.campagne.modification", cibleType: "wm_campagne", cibleId: c.id }),
    ];
    if (d.entreprises !== undefined) {
      const entreprises = await lireEntreprises(ctx, d.entreprises);
      lots.push(ctx.env.DB.prepare("DELETE FROM wm_campagne_entreprises WHERE campagne_id = ?").bind(c.id));
      entreprises.forEach((e, i) => lots.push(ctx.env.DB.prepare("INSERT INTO wm_campagne_entreprises (campagne_id, entreprise_id, ordre) VALUES (?, ?, ?)").bind(c.id, e, i)));
    }
    await ctx.env.DB.batch(lots);
    return json({ ok: true });
  });

  r.post("/api/admin/whyme/campagnes/:id/statut", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const c = await campagneParId(ctx.env.DB, ctx.params.id!);
    const d = await lireJson(ctx.request);
    const statut = d.statut;
    const permis: Record<string, string[]> = { brouillon: ["active"], active: ["close", "brouillon"], close: ["active"] };
    if (typeof statut !== "string" || !permis[c.statut]?.includes(statut)) throw conflit(`Passage de « ${c.statut} » à « ${String(statut)} » impossible`);
    if (statut === "active" && !(await entreprisesDeCampagne(ctx.env.DB, c.id)).length) throw conflit("Ajoutez au moins une entreprise");
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE wm_campagnes SET statut = ?, maj_le = ? WHERE id = ?").bind(statut, maintenant(), c.id),
      ligneJournal(ctx.env.DB, id, { action: "whyme.campagne.statut", cibleType: "wm_campagne", cibleId: c.id, details: { de: c.statut, vers: statut } }),
    ]);
    return json({ statut });
  });

  // ------------------------------------------------------------------ suivi des interviews
  r.get("/api/admin/whyme/campagnes/:id/candidats", async (ctx) => {
    await whyme(ctx, "reponses.lire");
    const c = await campagneParId(ctx.env.DB, ctx.params.id!);
    const res = await ctx.env.DB.prepare(
      `SELECT c.id, c.prenom, c.nom, c.statut, c.erreur, c.consent_public, c.cv_cle IS NOT NULL AS a_cv, c.montage_cle IS NOT NULL AS a_video,
              c.montage_essais, c.cree_le, c.termine_le, c.pret_le, c.courriel_envoye_le, c.video_supprimee_le, c.supprime_le, c.code_public,
              (SELECT COUNT(*) FROM wm_prises p WHERE p.candidat_id = c.id) AS prises,
              (SELECT GROUP_CONCAT(e.nom, ', ') FROM wm_candidatures ca JOIN wm_entreprises e ON e.id = ca.entreprise_id
                 WHERE ca.candidat_id = c.id AND ca.retiree_le IS NULL) AS entreprises
         FROM wm_candidats c WHERE c.campagne_id = ? ORDER BY c.cree_le DESC LIMIT 1000`,
    ).bind(c.id).all();
    return json({ candidats: res.results, questions: c.config.questions.length });
  });

  r.post("/api/admin/whyme/candidats/:id/montage", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const c = await candidatParId(ctx.env.DB, ctx.params.id!);
    if (!c || c.supprime_le) throw introuvable("Interview introuvable");
    if (!["termine", "montage", "erreur"].includes(c.statut)) throw conflit("Rien à monter pour cette interview");
    if (!ctx.env.MONTAGE_URL || !ctx.env.MONTAGE_CLE) throw new HttpError(503, "montage_absent", "Le service de montage n'est pas encore configuré");
    await journaliser(ctx.env.DB, id, { action: "whyme.montage.relance", cibleType: "wm_candidat", cibleId: c.id });
    return json({ demande: await declencherMontage(ctx.env, c.id) });
  });

  // Plan de montage (diagnostic) : ce que le service recevra.
  r.get("/api/admin/whyme/candidats/:id/plan", async (ctx) => {
    await whyme(ctx, "reponses.lire");
    return json(await planMontage(ctx.env, ctx.params.id!));
  });

  r.get("/api/admin/whyme/candidats/:id/video", async (ctx) => {
    const id = await whyme(ctx, "reponses.lire");
    const c = await candidatParId(ctx.env.DB, ctx.params.id!);
    if (!c?.montage_cle) throw introuvable("Pas de vidéo montée");
    return servirVideo(ctx.request, ctx.env, c.montage_cle, {
      type: "video/mp4", nom: `whyme-${c.prenom}.mp4`,
      journaliser: () => journaliser(ctx.env.DB, id, { action: "whyme.video.lecture", cibleType: "wm_candidat", cibleId: c.id }),
    });
  });

  r.post("/api/admin/whyme/candidats/:id/supprimer", async (ctx) => {
    const id = await whyme(ctx, "visiteurs.gerer");
    const c = await candidatParId(ctx.env.DB, ctx.params.id!);
    if (!c || c.supprime_le) throw introuvable("Interview introuvable");
    await supprimerCandidat(ctx.env, c, id.email, "demande transmise à WhyMe");
    return json({ ok: true });
  });

  // E-mails de Why me (gardés 7 jours) : en test sans clé Brevo, c'est ici qu'on les lit.
  r.get("/api/admin/whyme/courriels", async (ctx) => {
    const id = await whyme(ctx, "journal.lire");
    const res = await ctx.env.DB.prepare("SELECT id, a, sujet, texte, html, sorte, envoye, cree_le FROM wm_courriels ORDER BY cree_le DESC LIMIT 50").all();
    await journaliser(ctx.env.DB, id, { action: "whyme.courriels.lecture" });
    return json({ courriels: res.results, brevo: Boolean(ctx.env.BREVO_CLE), montage: Boolean(ctx.env.MONTAGE_URL && ctx.env.MONTAGE_CLE) });
  });
}
