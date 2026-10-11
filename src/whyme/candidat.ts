// API du téléphone du candidat (Why me). Publique : jamais Cloudflare Access (⚠ règle « bypass » sur /api/whyme).
// Le téléphone crée l'identifiant de l'interview et son jeton secret (seule l'empreinte est gardée) : un envoi
// répété après une coupure ne crée pas de doublon, et la reprise se fait là où le candidat en était.

import type { Routeur } from "../routeur.ts";
import { conflit, HttpError, invalide, json, lireJson, maintenant, texte } from "../http.ts";
import { empreinteJeton, nouveauJeton } from "../auth/cabine.ts";
import { ligneJournal } from "../journal.ts";
import { genererTextes } from "./config.ts";
import { CANDIDAT, JETON, UUID, campagneParCode, campagneParId, candidatAuthentifie, entreprisesDeCampagne } from "./commun.ts";
import { declencherMontage } from "./montage.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const TAILLE_MAX_PRISE = 60 * 1024 * 1024;
export const TAILLE_MAX_CV = 5 * 1024 * 1024;
export const TYPES_CV: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
};

function typeVideo(entete: string | null): { type: string; ext: string } {
  const t = (entete ?? "").split(";")[0]!.trim().toLowerCase();
  if (t === "video/webm") return { type: "video/webm", ext: "webm" };
  if (t === "video/mp4" || t === "video/quicktime") return { type: "video/mp4", ext: "mp4" };
  throw new HttpError(415, "format", "Vidéo WebM ou MP4 attendue");
}

export function routesWhymeCandidat(r: Routeur): void {
  // Ce que le téléphone affiche : questionnaire, entreprises, textes de consentement (et leur empreinte).
  r.get("/api/whyme/campagnes/:code", async (ctx) => {
    const c = await campagneParCode(ctx.env.DB, ctx.params.code!);
    const entreprises = await entreprisesDeCampagne(ctx.env.DB, c.id);
    const cfg = c.config;
    return json({
      campagne: {
        code: c.code, evenement: cfg.evenement, organisateur: cfg.organisateur ?? null, accueil: cfg.accueil,
        familles: cfg.familles, questionEssai: cfg.questionEssai,
        questions: cfg.questions.map((q) => ({ id: q.id, texte: q.texte, dureeSec: q.dureeSec, lectureSec: q.lectureSec })),
        ageAffiche: cfg.ageAffiche, ageMinimum: cfg.ageMinimum, validationAutoSec: cfg.validationAutoSec,
      },
      entreprises: entreprises.map((e) => ({ id: e.id, nom: e.nom, logo: e.logo_cle ? `/api/whyme/entreprises/${e.id}/logo` : null })),
      textes: genererTextes(cfg),
      empreinte: c.textes_empreinte,
    });
  });

  // Création de l'interview, après l'identification, les choix et les consentements.
  r.post("/api/whyme/campagnes/:code/candidats", async (ctx) => {
    const c = await campagneParCode(ctx.env.DB, ctx.params.code!);
    const d = await lireJson(ctx.request);
    const id = texte(d, "id", { requis: true, max: 36 })!;
    const jeton = texte(d, "jeton", { requis: true, max: 64 })!;
    if (!UUID.test(id) || !JETON.test(jeton)) throw invalide("Identifiant ou jeton invalide");
    const empreinte = await empreinteJeton(jeton);

    const existant = await ctx.env.DB.prepare("SELECT campagne_id, jeton_empreinte FROM wm_candidats WHERE id = ?")
      .bind(id).first<{ campagne_id: string; jeton_empreinte: string }>();
    if (existant) {
      // Envoi répété après une coupure : même téléphone, même interview.
      if (existant.campagne_id === c.id && existant.jeton_empreinte === empreinte) return json({ id, deja: true });
      throw conflit("Identifiant déjà utilisé");
    }

    if (d.consent_candidature !== true) throw invalide("Ton accord pour transmettre ta candidature est nécessaire");
    if (texte(d, "empreinte", { requis: true, max: 64 }) !== c.textes_empreinte) {
      throw new HttpError(409, "textes_changes", "Les conditions ont été mises à jour : recharge la page.");
    }
    const prenom = texte(d, "prenom", { requis: true, max: 60 })!;
    const nom = texte(d, "nom", { requis: true, max: 80 })!;
    const email = texte(d, "email", { requis: true, max: 200 })!.toLowerCase();
    if (!EMAIL.test(email)) throw invalide("Adresse e-mail invalide");
    const age = d.age;
    if (typeof age !== "number" || !Number.isInteger(age) || age < 10 || age > 99) throw invalide("Âge invalide");
    if (age < c.config.ageMinimum) {
      throw new HttpError(403, "age_minimum", `Cette interview est ouverte à partir de ${c.config.ageMinimum} ans.`);
    }
    let famille: string | null = null;
    if (c.config.familles.length) {
      famille = texte(d, "famille", { requis: true, max: 40 })!;
      if (!c.config.familles.some((f) => f.id === famille)) throw invalide("Famille de postes inconnue");
    }
    const proposees = new Set((await entreprisesDeCampagne(ctx.env.DB, c.id)).map((e) => e.id));
    const choisies = Array.isArray(d.entreprises) ? [...new Set(d.entreprises)] : [];
    if (!choisies.length) throw invalide("Choisis au moins une entreprise");
    if (choisies.some((e) => typeof e !== "string" || !proposees.has(e))) throw invalide("Entreprise inconnue pour cette campagne");

    const t = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO wm_candidats (id, campagne_id, jeton_empreinte, gestion_empreinte, prenom, nom, email, age, famille,
           consent_candidature, consent_public, textes_empreinte, origine, derniere_action_le, cree_le)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(id, c.id, empreinte, await empreinteJeton(nouveauJeton()), prenom, nom, email, age, famille,
        d.consent_public === true ? 1 : 0, c.textes_empreinte, ctx.url.origin, t, t),
      ...(choisies as string[]).map((e) => ctx.env.DB.prepare("INSERT INTO wm_candidatures (candidat_id, entreprise_id) VALUES (?, ?)").bind(id, e)),
      ligneJournal(ctx.env.DB, CANDIDAT, {
        action: "whyme.candidat.creation", cibleType: "wm_candidat", cibleId: id,
        details: { campagne: c.code, entreprises: choisies.length, diffusion: d.consent_public === true },
      }),
    ]);
    return json({ id }, 201);
  });

  // Où en est l'interview (reprise après une coupure).
  r.get("/api/whyme/candidats/:id", async (ctx) => {
    const cand = await candidatAuthentifie(ctx.request, ctx.env, ctx.params.id!);
    const camp = await campagneParId(ctx.env.DB, cand.campagne_id);
    const prises = await ctx.env.DB.prepare("SELECT question_id, reprise FROM wm_prises WHERE candidat_id = ?")
      .bind(cand.id).all<{ question_id: string; reprise: number }>();
    return json({
      id: cand.id, code: camp.code, prenom: cand.prenom, statut: cand.statut, aCv: Boolean(cand.cv_cle),
      prises: prises.results.map((p) => ({ question: p.question_id, reprise: Boolean(p.reprise) })),
    });
  });

  // CV (facultatif) : PDF ou Word, 5 Mo au plus, tant que l'interview n'est pas terminée.
  r.ajouter("PUT", "/api/whyme/candidats/:id/cv", async (ctx) => {
    const cand = await candidatAuthentifie(ctx.request, ctx.env, ctx.params.id!);
    if (cand.statut !== "en_cours") throw conflit("Interview déjà terminée");
    const type = (ctx.request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = TYPES_CV[type];
    if (!ext) throw new HttpError(415, "format", "CV au format PDF ou Word attendu");
    const corps = await ctx.request.arrayBuffer();
    if (!corps.byteLength) throw invalide("CV vide");
    if (corps.byteLength > TAILLE_MAX_CV) throw new HttpError(413, "trop_lourd", "CV trop lourd (5 Mo au plus)");
    const nomFichier = decodeURIComponent(ctx.request.headers.get("x-nom-fichier") ?? "").replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 120) || `cv.${ext}`;
    const cle = `whyme/${cand.campagne_id}/${cand.id}/cv.${ext}`;
    if (cand.cv_cle && cand.cv_cle !== cle) await ctx.env.MEDIA.delete(cand.cv_cle);
    await ctx.env.MEDIA.put(cle, corps, { httpMetadata: { contentType: type } });
    await ctx.env.DB.prepare("UPDATE wm_candidats SET cv_cle = ?, cv_nom = ?, cv_type = ?, cv_taille = ?, derniere_action_le = ? WHERE id = ?")
      .bind(cle, nomFichier, type, corps.byteLength, maintenant(), cand.id).run();
    return json({ ok: true });
  });

  // Prise gardée pour une question. Une reprise remplace la précédente (une seule par question).
  r.ajouter("PUT", "/api/whyme/candidats/:id/prises/:question", async (ctx) => {
    const cand = await candidatAuthentifie(ctx.request, ctx.env, ctx.params.id!);
    if (cand.statut !== "en_cours") throw conflit("Interview déjà terminée");
    const camp = await campagneParId(ctx.env.DB, cand.campagne_id);
    const question = ctx.params.question!;
    if (!camp.config.questions.some((q) => q.id === question)) throw invalide("Question inconnue");
    const { type, ext } = typeVideo(ctx.request.headers.get("content-type"));
    const corps = await ctx.request.arrayBuffer();
    if (!corps.byteLength) throw invalide("Vidéo vide");
    if (corps.byteLength > TAILLE_MAX_PRISE) throw new HttpError(413, "trop_lourd", "Vidéo trop lourde");
    const duree = Number(ctx.request.headers.get("x-duree-ms") ?? 0);
    const son = ctx.request.headers.get("x-son-present") === "1" ? 1 : 0;
    const reprise = ctx.request.headers.get("x-reprise") === "1" ? 1 : 0;

    const avant = await ctx.env.DB.prepare("SELECT cle, reprise FROM wm_prises WHERE candidat_id = ? AND question_id = ?")
      .bind(cand.id, question).first<{ cle: string; reprise: number }>();
    if (avant?.reprise && reprise) {
      // Même prise renvoyée (coupure pendant l'envoi) : acceptée ; une troisième prise, non.
      if (!ctx.request.headers.get("x-prise-id") || !avant.cle.includes(ctx.request.headers.get("x-prise-id")!)) {
        throw conflit("Une seule reprise par question");
      }
    }
    const priseId = (ctx.request.headers.get("x-prise-id") ?? crypto.randomUUID()).replace(/[^a-z0-9-]/gi, "").slice(0, 36);
    const cle = `whyme/${cand.campagne_id}/${cand.id}/${question}-${priseId}.${ext}`;
    await ctx.env.MEDIA.put(cle, corps, { httpMetadata: { contentType: type } });
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO wm_prises (candidat_id, question_id, cle, type, duree_ms, son_present, taille, reprise, recue_le)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (candidat_id, question_id) DO UPDATE SET cle = excluded.cle, type = excluded.type, duree_ms = excluded.duree_ms,
           son_present = excluded.son_present, taille = excluded.taille, reprise = MAX(wm_prises.reprise, excluded.reprise), recue_le = excluded.recue_le`,
      ).bind(cand.id, question, cle, type, Number.isFinite(duree) ? Math.round(duree) : null, son, corps.byteLength, reprise, maintenant()),
      ctx.env.DB.prepare("UPDATE wm_candidats SET derniere_action_le = ? WHERE id = ?").bind(maintenant(), cand.id),
    ]);
    if (avant && avant.cle !== cle) await ctx.env.MEDIA.delete(avant.cle);
    return json({ ok: true, son: Boolean(son) });
  });

  // Fin de l'interview : toutes les réponses sont arrivées, le montage peut commencer.
  r.post("/api/whyme/candidats/:id/terminer", async (ctx) => {
    const cand = await candidatAuthentifie(ctx.request, ctx.env, ctx.params.id!);
    if (cand.statut !== "en_cours") return json({ statut: cand.statut });
    const camp = await campagneParId(ctx.env.DB, cand.campagne_id);
    const recues = new Set((await ctx.env.DB.prepare("SELECT question_id FROM wm_prises WHERE candidat_id = ?").bind(cand.id)
      .all<{ question_id: string }>()).results.map((p) => p.question_id));
    const manquantes = camp.config.questions.filter((q) => !recues.has(q.id)).map((q) => q.id);
    if (manquantes.length) throw new HttpError(409, "reponses_manquantes", `Réponses manquantes : ${manquantes.join(", ")}`);
    const t = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE wm_candidats SET statut = 'termine', termine_le = ?, derniere_action_le = ? WHERE id = ? AND statut = 'en_cours'").bind(t, t, cand.id),
      ligneJournal(ctx.env.DB, CANDIDAT, { action: "whyme.candidat.termine", cibleType: "wm_candidat", cibleId: cand.id }),
    ]);
    await declencherMontage(ctx.env, cand.id);
    return json({ statut: "termine" });
  });
}
