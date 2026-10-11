// Montage des interviews Why me, côté plateforme.
// Le montage lui-même (ffmpeg) tourne dans un service séparé (dossier montage/ : conteneur Cloudflare en
// juridiction UE, ou petit serveur en Europe). La plateforme lui signale une interview terminée ; le service
// vient chercher le plan et les prises, monte le film 9:16, le renvoie, et la plateforme finalise :
// rushes effacés, candidatures transmises, e-mail au candidat.
// Toutes les routes /api/montage/* exigent une requête signée avec le secret partagé (montage/signature.ts).

import type { Routeur, Contexte } from "../routeur.ts";
import type { Env } from "../types.ts";
import { HttpError, introuvable, json, lireJson, maintenant, texte } from "../http.ts";
import { codeAleatoire, empreinteJeton, nouveauJeton } from "../auth/cabine.ts";
import { ligneJournal, journaliser } from "../journal.ts";
import { lireMiniature, servirVideo } from "../media.ts";
import { ACCES_RECRUTEURS_MOIS, LIEN_PUBLIC_MOIS, ajouterMois } from "./config.ts";
import { campagneParId, candidatParId } from "./commun.ts";
import { courrielVideoPrete, envoyerWhyme } from "./courriels.ts";
import { ENTETE_SIGNATURE, empreinteCourte, signer, verifierSignature } from "../../montage/signature.ts";

export const SERVICE = "service de montage";
export const ESSAIS_MAX = 3;
export const TAILLE_MAX_MONTAGE = 95 * 1024 * 1024;

/** Demande le montage au service. Sans service configuré, l'interview reste « terminée » (en attente). */
export const montageConfigure = (env: Env) => Boolean((env.MONTAGE_SERVICE || env.MONTAGE_URL) && env.MONTAGE_CLE);

export async function declencherMontage(env: Env, id: string): Promise<boolean> {
  if (!montageConfigure(env)) return false;
  const c = await candidatParId(env.DB, id);
  if (!c || c.supprime_le || (c.statut !== "termine" && c.statut !== "montage" && c.statut !== "erreur")) return false;
  await env.DB.prepare("UPDATE wm_candidats SET statut = 'montage', erreur = NULL, montage_demande_le = ?, montage_essais = montage_essais + 1 WHERE id = ?")
    .bind(maintenant(), id).run();
  try {
    const url = env.MONTAGE_SERVICE ? "https://voxbox-montage/monter" : `${env.MONTAGE_URL!.replace(/\/$/, "")}/monter`;
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", [ENTETE_SIGNATURE]: await signer(env.MONTAGE_CLE!, "POST", "/monter") },
      body: JSON.stringify({ id, api: c.origine }),
      signal: AbortSignal.timeout(15_000),
    };
    const res = env.MONTAGE_SERVICE ? await env.MONTAGE_SERVICE.fetch(url, init) : await fetch(url, init);
    if (!res.ok) throw new Error(`service de montage : ${res.status}`);
    return true;
  } catch (e) {
    // Le service reprendra au prochain passage des tâches planifiées.
    console.error("Why me : montage non déclenché", id, e);
    return false;
  }
}

/** Le service répond-il, et avec le même secret ? (comparaison d'empreintes : le secret n'est jamais montré). */
export async function etatServiceMontage(env: Env): Promise<"absent" | "identique" | "differente" | "injoignable"> {
  if (!montageConfigure(env)) return "absent";
  try {
    const sante = "/sante";
    const res = env.MONTAGE_SERVICE ? await env.MONTAGE_SERVICE.fetch(`https://voxbox-montage${sante}`, { signal: AbortSignal.timeout(5_000) })
      : await fetch(`${env.MONTAGE_URL!.replace(/\/$/, "")}${sante}`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return "injoignable";
    const d = (await res.json()) as { empreinteCle?: string };
    return d.empreinteCle === await empreinteCourte(env.MONTAGE_CLE!) ? "identique" : "differente";
  } catch {
    return "injoignable";
  }
}

async function exigerService(ctx: Contexte): Promise<void> {
  const ok = ctx.env.MONTAGE_CLE && await verifierSignature(ctx.env.MONTAGE_CLE, ctx.request.method, new URL(ctx.request.url).pathname,
    ctx.request.headers.get(ENTETE_SIGNATURE));
  if (!ok) throw new HttpError(401, "non_authentifie", "Service de montage non reconnu");
}

/** Ce que le service doit monter : questions dans l'ordre, prises, prénom et âge à incruster. */
export async function planMontage(env: Env, id: string) {
  const c = await candidatParId(env.DB, id);
  if (!c || c.supprime_le) throw introuvable("Interview introuvable");
  const camp = await campagneParId(env.DB, c.campagne_id);
  const prises = new Map((await env.DB.prepare("SELECT question_id, type, duree_ms, son_present FROM wm_prises WHERE candidat_id = ?")
    .bind(id).all<{ question_id: string; type: string; duree_ms: number | null; son_present: number }>()).results.map((p) => [p.question_id, p]));
  const questions = camp.config.questions.map((q, i) => {
    const p = prises.get(q.id);
    if (!p) throw new HttpError(409, "prise_manquante", `Réponse manquante : ${q.id}`);
    return { id: q.id, numero: i + 1, carton: q.carton ?? q.texte, texte: q.texte, type: p.type, dureeMs: p.duree_ms, sonPresent: Boolean(p.son_present) };
  });
  return {
    id: c.id,
    prenom: c.prenom,
    age: camp.config.ageAffiche ? c.age : null,
    evenement: camp.config.evenement,
    questions,
    format: { largeur: 720, hauteur: 1280 },
  };
}

/** Le film est arrivé : finalisation (rushes effacés, candidatures transmises, e-mail). Idempotent. */
export async function finaliser(env: Env, id: string): Promise<void> {
  const c = await candidatParId(env.DB, id);
  if (!c || c.supprime_le || !c.montage_cle || c.statut === "pret") return;
  const camp = await campagneParId(env.DB, c.campagne_id);
  const t = maintenant();
  const codePublic = c.consent_public ? (c.code_public ?? codeAleatoire(10)) : null;
  const jetonGestion = nouveauJeton();
  const prises = await env.DB.prepare("SELECT cle FROM wm_prises WHERE candidat_id = ?").bind(id).all<{ cle: string }>();
  const entreprises = (await env.DB.prepare(
    `SELECT e.nom FROM wm_candidatures ca JOIN wm_entreprises e ON e.id = ca.entreprise_id
      WHERE ca.candidat_id = ? AND ca.retiree_le IS NULL ORDER BY e.nom`,
  ).bind(id).all<{ nom: string }>()).results.map((e) => e.nom);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE wm_candidats SET statut = 'pret', erreur = NULL, pret_le = ?, code_public = ?, gestion_empreinte = ?,
         acces_recruteurs_jusqu = ?, public_jusqu = ? WHERE id = ? AND statut <> 'pret'`,
    ).bind(t, codePublic, await empreinteJeton(jetonGestion), ajouterMois(t, ACCES_RECRUTEURS_MOIS),
      codePublic ? ajouterMois(t, LIEN_PUBLIC_MOIS) : null, id),
    env.DB.prepare("UPDATE wm_candidatures SET transmise_le = ? WHERE candidat_id = ? AND retiree_le IS NULL AND transmise_le IS NULL").bind(t, id),
    env.DB.prepare("DELETE FROM wm_prises WHERE candidat_id = ?").bind(id),
    ligneJournal(env.DB, SERVICE, { action: "whyme.candidature.transmise", cibleType: "wm_candidat", cibleId: id, details: { entreprises: entreprises.length } }),
  ]);
  // Rushes effacés dès que le montage est prêt (décision du 11/10/2026).
  if (prises.results.length) await env.MEDIA.delete(prises.results.map((p) => p.cle));

  const o = c.origine;
  const courriel = courrielVideoPrete({
    prenom: c.prenom,
    evenement: camp.config.evenement,
    organisateur: camp.config.organisateur,
    entreprises,
    aCv: Boolean(c.cv_cle),
    lienVideo: codePublic ? `${o}/v/${codePublic}` : null,
    lienSticker: codePublic ? `${o}/api/whyme/videos/${codePublic}/sticker.png` : null,
    lienGestion: `${o}/whyme/gerer/#g=${jetonGestion}`,
    lienConfidentialite: `${o}/whyme/confidentialite/`,
  });
  // Émis dans tous les cas : parti chez Brevo, ou gardé dans wm_courriels (environnement de test sans clé).
  await envoyerWhyme(env, c.email, "video_prete", courriel);
  await env.DB.prepare("UPDATE wm_candidats SET courriel_envoye_le = ? WHERE id = ?").bind(maintenant(), id).run();
}

export function routesWhymeMontage(r: Routeur): void {
  r.get("/api/montage/travaux/:id", async (ctx) => {
    await exigerService(ctx);
    return json(await planMontage(ctx.env, ctx.params.id!));
  });

  r.get("/api/montage/prises/:id/:question", async (ctx) => {
    await exigerService(ctx);
    const p = await ctx.env.DB.prepare("SELECT cle, type FROM wm_prises WHERE candidat_id = ? AND question_id = ?")
      .bind(ctx.params.id!, ctx.params.question!).first<{ cle: string; type: string }>();
    if (!p) throw introuvable("Prise introuvable");
    return servirVideo(ctx.request, ctx.env, p.cle, { type: p.type, nom: p.cle.split("/").pop()!, journaliser: async () => {} });
  });

  r.ajouter("PUT", "/api/montage/miniature/:id", async (ctx) => {
    await exigerService(ctx);
    const c = await candidatParId(ctx.env.DB, ctx.params.id!);
    if (!c || c.supprime_le) throw introuvable("Interview introuvable");
    const corps = await lireMiniature(ctx.request);
    const cle = `whyme/${c.campagne_id}/${c.id}/miniature.jpg`;
    await ctx.env.MEDIA.put(cle, corps, { httpMetadata: { contentType: "image/jpeg" } });
    await ctx.env.DB.prepare("UPDATE wm_candidats SET miniature_cle = ? WHERE id = ?").bind(cle, c.id).run();
    return json({ ok: true });
  });

  r.ajouter("PUT", "/api/montage/resultat/:id", async (ctx) => {
    await exigerService(ctx);
    const c = await candidatParId(ctx.env.DB, ctx.params.id!);
    if (!c || c.supprime_le) throw introuvable("Interview introuvable");
    if ((ctx.request.headers.get("content-type") ?? "").split(";")[0]!.trim() !== "video/mp4") throw new HttpError(415, "format", "MP4 attendu");
    const corps = await ctx.request.arrayBuffer();
    if (!corps.byteLength || corps.byteLength > TAILLE_MAX_MONTAGE) throw new HttpError(413, "taille", "Montage vide ou trop lourd");
    const cle = `whyme/${c.campagne_id}/${c.id}/montage.mp4`;
    await ctx.env.MEDIA.put(cle, corps, { httpMetadata: { contentType: "video/mp4" } });
    const duree = Number(ctx.request.headers.get("x-duree-ms") ?? 0);
    await ctx.env.DB.prepare("UPDATE wm_candidats SET montage_cle = ?, montage_taille = ?, montage_duree_ms = ? WHERE id = ?")
      .bind(cle, corps.byteLength, Number.isFinite(duree) && duree > 0 ? Math.round(duree) : null, c.id).run();
    await finaliser(ctx.env, c.id);
    return json({ ok: true });
  });

  r.post("/api/montage/echec/:id", async (ctx) => {
    await exigerService(ctx);
    const d = await lireJson(ctx.request);
    const message = texte(d, "message", { max: 500 }) ?? "Échec du montage";
    await ctx.env.DB.prepare("UPDATE wm_candidats SET statut = 'erreur', erreur = ? WHERE id = ? AND statut <> 'pret'").bind(message, ctx.params.id!).run();
    await journaliser(ctx.env.DB, SERVICE, { action: "whyme.montage.echec", cibleType: "wm_candidat", cibleId: ctx.params.id!, details: { message } });
    return json({ ok: true });
  });
}
