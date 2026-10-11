// Espace RH Why me (/rh/, API /api/rh/*, protégé par Cloudflare Access) : clients (organisateurs) et leurs contacts,
// entreprises recruteuses (sous-clients, communes à toutes les campagnes) et leurs recruteurs, campagnes, suivi des
// interviews (montage, e-mail), statistiques, équipe RH. Réservé à l'équipe RH (src/whyme/equipe.ts), séparée des
// comptes Parlopop.

import type { Routeur, Contexte } from "../routeur.ts";
import { exigerRh, type ActionRh, type IdentiteRh } from "./equipe.ts";
import { statistiquesCampagne } from "./statistiques.ts";
import { conflit, HttpError, introuvable, invalide, json, lireJson, maintenant, nouvelId, texte } from "../http.ts";
import { codeAleatoire } from "../auth/cabine.ts";
import { journaliser, ligneJournal } from "../journal.ts";
import { servirMiniature, servirVideo } from "../media.ts";
import { slugifier } from "../routes/admin.ts";
import { empreinteTextes, genererTextes, validerConfig, type ConfigWhyme } from "./config.ts";
import { campagneParId, campagnePourCandidat, candidatParId, entreprisesDeCampagne, supprimerCandidat } from "./commun.ts";
import { declencherMontage, etatServiceMontage, montageConfigure, planMontage } from "./montage.ts";
import { expediteurWhyme } from "./courriels.ts";
import { envoyerCourriel } from "../courriel.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** /i/apercu ouvre le parcours candidat sur un brouillon de l'éditeur, sans rien enregistrer. */
export const CODES_RESERVES = new Set(["apercu"]);

const LOGOS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

const whyme = (ctx: Contexte, action: ActionRh): Promise<IdentiteRh> => exigerRh(ctx.request, ctx.env, action);

/** Une adresse ne sert qu'à un seul compte de l'espace partenaires (recruteur ou contact client). */
async function emailLibre(ctx: Contexte, email: string): Promise<void> {
  if (await ctx.env.DB.prepare("SELECT 1 FROM wm_recruteurs WHERE email = ?").bind(email).first()
    || await ctx.env.DB.prepare("SELECT 1 FROM wm_contacts_client WHERE email = ?").bind(email).first()) {
    throw conflit("Cette adresse a déjà un compte (recruteur ou contact client)");
  }
}

/** Un nom d'organisation, pas une adresse e-mail (confusion fréquente avec les contacts et les recruteurs). */
function nomOrganisation(d: Record<string, unknown>, quoi: string): string {
  const nom = texte(d, "nom", { requis: true, max: 80 })!;
  if (nom.includes("@")) throw invalide(`C'est une adresse e-mail : le nom ${quoi} est attendu ici (les personnes s'ajoutent ensuite, avec leur adresse).`);
  return nom;
}

async function lireClient(ctx: Contexte, v: unknown): Promise<string> {
  if (typeof v !== "string" || !(await ctx.env.DB.prepare("SELECT 1 FROM wm_clients WHERE id = ?").bind(v).first())) throw invalide("Client inconnu");
  return v;
}

/** Entreprises proposées : identifiants existants, sans doublon. Liste vide permise (exigée seulement à l'ouverture). */
async function lireEntreprises(ctx: Contexte, v: unknown): Promise<string[]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw invalide("Entreprises : liste attendue");
  const ids = [...new Set(v)];
  for (const e of ids) {
    if (typeof e !== "string" || !(await ctx.env.DB.prepare("SELECT 1 FROM wm_entreprises WHERE id = ?").bind(e).first())) throw invalide("Entreprise inconnue");
  }
  return ids as string[];
}

export function routesWhymeAdmin(r: Routeur): void {
  // ------------------------------------------------------------------ entreprises
  r.get("/api/rh/entreprises", async (ctx) => {
    await whyme(ctx, "gerer");
    const e = await ctx.env.DB.prepare(
      `SELECT e.id, e.nom, e.slug, e.logo_cle IS NOT NULL AS a_logo,
              (SELECT COUNT(*) FROM wm_recruteurs r WHERE r.entreprise_id = e.id AND r.actif = 1) AS recruteurs,
              (SELECT COUNT(*) FROM wm_campagne_entreprises ce WHERE ce.entreprise_id = e.id) AS campagnes,
              (SELECT COUNT(*) FROM wm_candidatures ca WHERE ca.entreprise_id = e.id) AS candidatures
         FROM wm_entreprises e ORDER BY e.nom`,
    ).all<Record<string, unknown>>();
    return json({ entreprises: e.results.map((x) => ({ ...x, logo: x.a_logo ? `/api/whyme/entreprises/${x.id}/logo` : null })) });
  });

  r.post("/api/rh/entreprises", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const d = await lireJson(ctx.request);
    const nom = nomOrganisation(d, "de l'entreprise");
    const slug = slugifier(nom);
    if (await ctx.env.DB.prepare("SELECT 1 FROM wm_entreprises WHERE slug = ?").bind(slug).first()) throw conflit("Cette entreprise existe déjà");
    const e = { id: nouvelId(), nom, slug };
    const t = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO wm_entreprises (id, slug, nom, cree_le, maj_le) VALUES (?, ?, ?, ?, ?)").bind(e.id, slug, nom, t, t),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.entreprise.creation", cibleType: "wm_entreprise", cibleId: e.id, details: { nom } }),
    ]);
    return json({ entreprise: e }, 201);
  });

  r.patch("/api/rh/entreprises/:id", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const d = await lireJson(ctx.request);
    const nom = nomOrganisation(d, "de l'entreprise");
    const res = await ctx.env.DB.prepare("UPDATE wm_entreprises SET nom = ?, maj_le = ? WHERE id = ?").bind(nom, maintenant(), ctx.params.id!).run();
    if (!res.meta.changes) throw introuvable("Entreprise introuvable");
    await journaliser(ctx.env.DB, id.email, { action: "whyme.entreprise.modification", cibleType: "wm_entreprise", cibleId: ctx.params.id!, details: { nom } });
    return json({ ok: true });
  });

  r.ajouter("PUT", "/api/rh/entreprises/:id/logo", async (ctx) => {
    const id = await whyme(ctx, "gerer");
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
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.entreprise.logo", cibleType: "wm_entreprise", cibleId: e.id }),
    ]);
    return json({ logo: `/api/whyme/entreprises/${e.id}/logo` });
  });

  // ------------------------------------------------------------------ recruteurs
  r.get("/api/rh/recruteurs", async (ctx) => {
    await whyme(ctx, "gerer");
    const res = await ctx.env.DB.prepare(
      `SELECT r.id, r.email, r.entreprise_id, e.nom AS entreprise, r.actif, r.cree_le FROM wm_recruteurs r
         JOIN wm_entreprises e ON e.id = r.entreprise_id ORDER BY e.nom, r.email`,
    ).all();
    return json({ recruteurs: res.results });
  });

  r.post("/api/rh/recruteurs", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const d = await lireJson(ctx.request);
    const email = texte(d, "email", { requis: true, max: 200 })!.toLowerCase();
    if (!EMAIL.test(email)) throw invalide("Adresse e-mail invalide");
    const entreprise = texte(d, "entreprise_id", { requis: true, max: 40 })!;
    if (!(await ctx.env.DB.prepare("SELECT 1 FROM wm_entreprises WHERE id = ?").bind(entreprise).first())) throw invalide("Entreprise inconnue");
    await emailLibre(ctx, email);
    const rec = { id: nouvelId(), email, entreprise_id: entreprise };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO wm_recruteurs (id, email, entreprise_id, cree_le) VALUES (?, ?, ?, ?)").bind(rec.id, email, entreprise, maintenant()),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.recruteur.creation", cibleType: "wm_recruteur", cibleId: rec.id, details: { email, entreprise } }),
    ]);
    return json({ recruteur: rec }, 201);
  });

  r.patch("/api/rh/recruteurs/:id", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const d = await lireJson(ctx.request);
    if (typeof d.actif !== "boolean") throw invalide("actif : booléen attendu");
    const res = await ctx.env.DB.prepare("UPDATE wm_recruteurs SET actif = ? WHERE id = ?").bind(d.actif ? 1 : 0, ctx.params.id!).run();
    if (!res.meta.changes) throw introuvable("Recruteur introuvable");
    if (!d.actif) await ctx.env.DB.prepare("DELETE FROM wm_jetons_recruteur WHERE recruteur_id = ?").bind(ctx.params.id!).run();
    await journaliser(ctx.env.DB, id.email, { action: d.actif ? "whyme.recruteur.reactivation" : "whyme.recruteur.desactivation", cibleType: "wm_recruteur", cibleId: ctx.params.id! });
    return json({ ok: true });
  });

  // ------------------------------------------------------------------ campagnes
  r.get("/api/rh/campagnes", async (ctx) => {
    await whyme(ctx, "gerer");
    const res = await ctx.env.DB.prepare(
      `SELECT w.id, w.code, w.nom, w.statut, w.config, w.cree_le, w.client_id, cl.nom AS client,
              (SELECT COUNT(*) FROM wm_candidats c WHERE c.campagne_id = w.id AND c.supprime_le IS NULL) AS candidats,
              (SELECT COUNT(*) FROM wm_candidats c WHERE c.campagne_id = w.id AND c.statut = 'pret') AS prets
         FROM wm_campagnes w LEFT JOIN wm_clients cl ON cl.id = w.client_id ORDER BY w.cree_le DESC`,
    ).all<Record<string, any>>();
    const campagnes = [];
    for (const c of res.results) {
      campagnes.push({ ...c, config: JSON.parse(c.config), entreprises: (await entreprisesDeCampagne(ctx.env.DB, c.id)).map((e) => ({ id: e.id, nom: e.nom })) });
    }
    return json({ campagnes });
  });

  r.post("/api/rh/campagnes", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const d = await lireJson(ctx.request);
    const nom = texte(d, "nom", { requis: true, max: 80 })!;
    const client = await lireClient(ctx, d.client_id);
    const config = validerConfig(d.config);
    const entreprises = await lireEntreprises(ctx, d.entreprises);
    const textes = genererTextes(config);
    const c = { id: nouvelId(), code: slugifier(texte(d, "code", { max: 30 }) ?? `${slugifier(config.evenement).slice(0, 20)}-${codeAleatoire(4).toLowerCase()}`) };
    if (CODES_RESERVES.has(c.code) || await ctx.env.DB.prepare("SELECT 1 FROM wm_campagnes WHERE code = ?").bind(c.code).first()) throw conflit("Ce code de campagne est déjà pris");
    const t = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO wm_campagnes (id, code, nom, config, textes, textes_empreinte, cree_par, cree_le, maj_le, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(c.id, c.code, nom, JSON.stringify(config), JSON.stringify(textes), await empreinteTextes(textes), id.email, t, t, client),
      ...entreprises.map((e, i) => ctx.env.DB.prepare("INSERT INTO wm_campagne_entreprises (campagne_id, entreprise_id, ordre) VALUES (?, ?, ?)").bind(c.id, e, i)),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.campagne.creation", cibleType: "wm_campagne", cibleId: c.id, details: { nom, code: c.code } }),
    ]);
    return json({ campagne: { ...c, nom, statut: "brouillon", client_id: client } }, 201);
  });

  // Modification : seulement en brouillon (une campagne active ne change pas sous les pieds d'un candidat).
  r.patch("/api/rh/campagnes/:id", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const c = await campagneParId(ctx.env.DB, ctx.params.id!);
    const d = await lireJson(ctx.request);
    const nom = texte(d, "nom", { max: 80 }) ?? c.nom;
    if (c.statut !== "brouillon" && (d.config !== undefined || d.entreprises !== undefined)) {
      throw conflit("Questionnaire et entreprises ne changent plus une fois la campagne ouverte");
    }
    const config = d.config === undefined ? c.config : validerConfig(d.config);
    const textes = genererTextes(config);
    // Le client peut changer à tout moment : il ne voit que des statistiques, rien de ce qu'a accepté le candidat.
    const client = d.client_id === undefined ? c.client_id : await lireClient(ctx, d.client_id);
    const lots = [
      ctx.env.DB.prepare("UPDATE wm_campagnes SET nom = ?, config = ?, textes = ?, textes_empreinte = ?, client_id = ?, maj_le = ? WHERE id = ?")
        .bind(nom, JSON.stringify(config), JSON.stringify(textes), await empreinteTextes(textes), client, maintenant(), c.id),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.campagne.modification", cibleType: "wm_campagne", cibleId: c.id }),
    ];
    if (d.entreprises !== undefined) {
      const entreprises = await lireEntreprises(ctx, d.entreprises);
      lots.push(ctx.env.DB.prepare("DELETE FROM wm_campagne_entreprises WHERE campagne_id = ?").bind(c.id));
      entreprises.forEach((e, i) => lots.push(ctx.env.DB.prepare("INSERT INTO wm_campagne_entreprises (campagne_id, entreprise_id, ordre) VALUES (?, ?, ?)").bind(c.id, e, i)));
    }
    await ctx.env.DB.batch(lots);
    return json({ ok: true });
  });

  r.post("/api/rh/campagnes/:id/statut", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const c = await campagneParId(ctx.env.DB, ctx.params.id!);
    const d = await lireJson(ctx.request);
    const statut = d.statut;
    const permis: Record<string, string[]> = { brouillon: ["active"], active: ["close", "brouillon"], close: ["active"] };
    if (typeof statut !== "string" || !permis[c.statut]?.includes(statut)) throw conflit(`Passage de « ${c.statut} » à « ${String(statut)} » impossible`);
    if (statut === "active" && !(await entreprisesDeCampagne(ctx.env.DB, c.id)).length) throw conflit("Ajoutez au moins une entreprise");
    if (statut === "active" && !c.client_id) throw conflit("Rattachez d'abord la campagne à un client");
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE wm_campagnes SET statut = ?, maj_le = ? WHERE id = ?").bind(statut, maintenant(), c.id),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.campagne.statut", cibleType: "wm_campagne", cibleId: c.id, details: { de: c.statut, vers: statut } }),
    ]);
    return json({ statut });
  });

  // ------------------------------------------------------------------ suivi des interviews
  r.get("/api/rh/campagnes/:id/candidats", async (ctx) => {
    await whyme(ctx, "gerer");
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

  r.post("/api/rh/candidats/:id/montage", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const c = await candidatParId(ctx.env.DB, ctx.params.id!);
    if (!c || c.supprime_le) throw introuvable("Interview introuvable");
    if (!["termine", "montage", "erreur"].includes(c.statut)) throw conflit("Rien à monter pour cette interview");
    if (!montageConfigure(ctx.env)) throw new HttpError(503, "montage_absent", "Le service de montage n'est pas encore configuré");
    await journaliser(ctx.env.DB, id.email, { action: "whyme.montage.relance", cibleType: "wm_candidat", cibleId: c.id });
    return json({ demande: await declencherMontage(ctx.env, c.id) });
  });

  // Plan de montage (diagnostic) : ce que le service recevra.
  r.get("/api/rh/candidats/:id/plan", async (ctx) => {
    await whyme(ctx, "gerer");
    return json(await planMontage(ctx.env, ctx.params.id!));
  });

  r.get("/api/rh/candidats/:id/video", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const c = await candidatParId(ctx.env.DB, ctx.params.id!);
    if (!c?.montage_cle) throw introuvable("Pas de vidéo montée");
    return servirVideo(ctx.request, ctx.env, c.montage_cle, {
      type: "video/mp4", nom: `whyme-${c.prenom}.mp4`,
      journaliser: () => journaliser(ctx.env.DB, id.email, { action: "whyme.video.lecture", cibleType: "wm_candidat", cibleId: c.id }),
    });
  });

  r.post("/api/rh/candidats/:id/supprimer", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const c = await candidatParId(ctx.env.DB, ctx.params.id!);
    if (!c || c.supprime_le) throw introuvable("Interview introuvable");
    await supprimerCandidat(ctx.env, c, id.email, "demande transmise à WhyMe");
    return json({ ok: true });
  });

  // E-mails de Why me (gardés 7 jours) : en test sans clé Brevo, c'est ici qu'on les lit.
  r.get("/api/rh/courriels", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const res = await ctx.env.DB.prepare("SELECT id, a, sujet, texte, html, sorte, envoye, cree_le FROM wm_courriels ORDER BY cree_le DESC LIMIT 50").all();
    await journaliser(ctx.env.DB, id.email, { action: "whyme.courriels.lecture" });
    return json({ courriels: res.results, brevo: Boolean(ctx.env.BREVO_CLE), expediteur: expediteurWhyme(ctx.env),
      montage: montageConfigure(ctx.env), montageCle: await etatServiceMontage(ctx.env) });
  });

  // Renvoi d'un e-mail gardé (expéditeur refusé par Brevo, e-mail perdu…) : même contenu, même destinataire.
  r.post("/api/rh/courriels/:id/renvoyer", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    if (!ctx.env.BREVO_CLE) throw conflit("Brevo n'est pas configuré : rien ne peut partir");
    const c = await ctx.env.DB.prepare("SELECT id, a, sujet, texte, html, sorte FROM wm_courriels WHERE id = ?")
      .bind(ctx.params.id!).first<{ id: string; a: string; sujet: string; texte: string; html: string; sorte: string }>();
    if (!c) throw introuvable("E-mail introuvable");
    try {
      await envoyerCourriel(ctx.env, { a: c.a, sujet: c.sujet, texte: c.texte, html: c.html, expediteur: "WhyMe", de: expediteurWhyme(ctx.env) });
    } catch (e) {
      throw new HttpError(502, "brevo", `Brevo a refusé l'envoi : ${String((e as Error).message ?? e).slice(0, 300)}`);
    }
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE wm_courriels SET envoye = 1 WHERE id = ?").bind(c.id),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.courriel.renvoi", cibleType: "wm_courriel", cibleId: c.id, details: { sorte: c.sorte } }),
    ]);
    return json({ ok: true });
  });

  r.get("/api/rh/campagnes/:id/statistiques", async (ctx) => {
    await whyme(ctx, "gerer");
    return json(await statistiquesCampagne(ctx.env.DB, ctx.params.id!));
  });

  // ------------------------------------------------------------------ clients et leurs contacts
  r.get("/api/rh/clients", async (ctx) => {
    await whyme(ctx, "gerer");
    const clients = await ctx.env.DB.prepare(
      `SELECT cl.id, cl.nom, cl.slug, cl.cree_le,
              (SELECT COUNT(*) FROM wm_campagnes w WHERE w.client_id = cl.id) AS campagnes
         FROM wm_clients cl ORDER BY cl.nom`,
    ).all();
    const contacts = await ctx.env.DB.prepare(
      "SELECT id, email, client_id, actif, cree_le FROM wm_contacts_client ORDER BY email",
    ).all<{ client_id: string }>();
    return json({ clients: clients.results.map((c: any) => ({ ...c, contacts: contacts.results.filter((x) => x.client_id === c.id) })) });
  });

  r.post("/api/rh/clients", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const d = await lireJson(ctx.request);
    const nom = nomOrganisation(d, "du client");
    const slug = slugifier(nom);
    if (await ctx.env.DB.prepare("SELECT 1 FROM wm_clients WHERE slug = ?").bind(slug).first()) throw conflit("Ce client existe déjà");
    const c = { id: nouvelId(), nom, slug };
    const t = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO wm_clients (id, slug, nom, cree_le, maj_le) VALUES (?, ?, ?, ?, ?)").bind(c.id, slug, nom, t, t),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.client.creation", cibleType: "wm_client", cibleId: c.id, details: { nom } }),
    ]);
    return json({ client: c }, 201);
  });

  r.patch("/api/rh/clients/:id", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const d = await lireJson(ctx.request);
    const nom = nomOrganisation(d, "du client");
    const res = await ctx.env.DB.prepare("UPDATE wm_clients SET nom = ?, maj_le = ? WHERE id = ?").bind(nom, maintenant(), ctx.params.id!).run();
    if (!res.meta.changes) throw introuvable("Client introuvable");
    await journaliser(ctx.env.DB, id.email, { action: "whyme.client.modification", cibleType: "wm_client", cibleId: ctx.params.id!, details: { nom } });
    return json({ ok: true });
  });

  r.post("/api/rh/clients/:id/contacts", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const client = await lireClient(ctx, ctx.params.id!);
    const d = await lireJson(ctx.request);
    const email = texte(d, "email", { requis: true, max: 200 })!.toLowerCase();
    if (!EMAIL.test(email)) throw invalide("Adresse e-mail invalide");
    await emailLibre(ctx, email);
    const contact = { id: nouvelId(), email, client_id: client };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO wm_contacts_client (id, email, client_id, cree_le) VALUES (?, ?, ?, ?)").bind(contact.id, email, client, maintenant()),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.contact.creation", cibleType: "wm_contact_client", cibleId: contact.id, details: { email, client } }),
    ]);
    return json({ contact }, 201);
  });

  r.patch("/api/rh/contacts/:id", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const d = await lireJson(ctx.request);
    if (typeof d.actif !== "boolean") throw invalide("actif : booléen attendu");
    const res = await ctx.env.DB.prepare("UPDATE wm_contacts_client SET actif = ? WHERE id = ?").bind(d.actif ? 1 : 0, ctx.params.id!).run();
    if (!res.meta.changes) throw introuvable("Contact introuvable");
    if (!d.actif) await ctx.env.DB.prepare("DELETE FROM wm_jetons_contact WHERE contact_id = ?").bind(ctx.params.id!).run();
    await journaliser(ctx.env.DB, id.email, { action: d.actif ? "whyme.contact.reactivation" : "whyme.contact.desactivation", cibleType: "wm_contact_client", cibleId: ctx.params.id! });
    return json({ ok: true });
  });

  // ------------------------------------------------------------------ équipe RH
  r.get("/api/rh/moi", async (ctx) => json(await whyme(ctx, "gerer")));

  r.get("/api/rh/equipe", async (ctx) => {
    await whyme(ctx, "equipe");
    const res = await ctx.env.DB.prepare("SELECT email, role, actif, cree_par, cree_le FROM rh_equipe ORDER BY email").all();
    return json({ equipe: res.results, dOffice: (ctx.env.RH_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean) });
  });

  r.post("/api/rh/equipe", async (ctx) => {
    const id = await whyme(ctx, "equipe");
    const d = await lireJson(ctx.request);
    const email = texte(d, "email", { requis: true, max: 200 })!.toLowerCase();
    if (!EMAIL.test(email)) throw invalide("Adresse e-mail invalide");
    const role = d.role === "admin_rh" ? "admin_rh" : d.role === "operateur_rh" ? "operateur_rh" : null;
    if (!role) throw invalide("Rôle : admin_rh ou operateur_rh");
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO rh_equipe (email, role, actif, cree_par, cree_le) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(email) DO UPDATE SET role = excluded.role, actif = 1`,
      ).bind(email, role, id.email, maintenant()),
      ligneJournal(ctx.env.DB, id.email, { action: "rh.equipe.ajout", cibleType: "rh_equipe", cibleId: email, details: { role } }),
    ]);
    return json({ ok: true }, 201);
  });

  r.post("/api/rh/equipe/retirer", async (ctx) => {
    const id = await whyme(ctx, "equipe");
    const d = await lireJson(ctx.request);
    const email = texte(d, "email", { requis: true, max: 200 })!.toLowerCase();
    if (email === id.email) throw conflit("Vous ne pouvez pas retirer votre propre accès");
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE rh_equipe SET actif = 0 WHERE email = ?").bind(email),
      ligneJournal(ctx.env.DB, id.email, { action: "rh.equipe.retrait", cibleType: "rh_equipe", cibleId: email }),
    ]);
    return json({ ok: true });
  });

  // ------------------------------------------------------------------ éditeur de campagne
  // Vérification d'un brouillon (mêmes règles qu'à l'enregistrement), sans rien enregistrer.
  r.post("/api/rh/campagnes/verifier", async (ctx) => {
    await whyme(ctx, "gerer");
    const d = await lireJson(ctx.request);
    try {
      validerConfig(d.config);
      return json({ problemes: [] });
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) return json({ problemes: [e.message] });
      throw e;
    }
  });

  // Aperçu : ce que verrait le téléphone du candidat avec ce brouillon (le parcours tourne sans rien envoyer).
  r.post("/api/rh/campagnes/apercu", async (ctx) => {
    await whyme(ctx, "gerer");
    const d = await lireJson(ctx.request);
    const config = validerConfig(d.config);
    const ids = Array.isArray(d.entreprises) ? d.entreprises.filter((x: unknown) => typeof x === "string").slice(0, 40) : [];
    const entreprises = [];
    for (const id of ids) {
      const e = await ctx.env.DB.prepare("SELECT id, nom, logo_cle FROM wm_entreprises WHERE id = ?").bind(id).first<{ id: string; nom: string; logo_cle: string | null }>();
      if (e) entreprises.push({ id: e.id, nom: e.nom, logo: e.logo_cle ? `/api/whyme/entreprises/${e.id}/logo` : null });
    }
    return json({ campagne: campagnePourCandidat("apercu", config), entreprises, textes: genererTextes(config), empreinte: "apercu", apercu: true });
  });

  // ------------------------------------------------------------------ vidéos montées
  r.get("/api/rh/videos", async (ctx) => {
    await whyme(ctx, "gerer");
    const campagne = ctx.url.searchParams.get("campagne");
    const res = await ctx.env.DB.prepare(
      `SELECT c.id, c.prenom, c.nom, c.age, c.famille, c.campagne_id, w.nom AS campagne, w.config, c.pret_le, c.code_public,
              c.cv_cle IS NOT NULL AS a_cv, c.miniature_cle IS NOT NULL AS a_miniature, c.montage_duree_ms,
              (SELECT GROUP_CONCAT(e.nom, ', ') FROM wm_candidatures ca JOIN wm_entreprises e ON e.id = ca.entreprise_id
                 WHERE ca.candidat_id = c.id AND ca.retiree_le IS NULL) AS entreprises
         FROM wm_candidats c JOIN wm_campagnes w ON w.id = c.campagne_id
        WHERE c.montage_cle IS NOT NULL AND c.supprime_le IS NULL AND (?1 IS NULL OR c.campagne_id = ?1)
        ORDER BY c.pret_le DESC LIMIT 500`,
    ).bind(campagne).all<Record<string, any>>();
    return json({
      videos: res.results.map(({ config, ...v }) => {
        const cfg = JSON.parse(config) as ConfigWhyme;
        return { ...v, a_cv: Boolean(v.a_cv), a_miniature: Boolean(v.a_miniature), evenement: cfg.evenement,
          famille: cfg.familles?.find((f) => f.id === v.famille)?.nom ?? null };
      }),
    });
  });

  r.get("/api/rh/candidats/:id/miniature", async (ctx) => {
    await whyme(ctx, "gerer");
    const c = await candidatParId(ctx.env.DB, ctx.params.id!);
    return servirMiniature(ctx.env, c?.supprime_le ? null : c?.miniature_cle ?? null);
  });

  r.get("/api/rh/candidats/:id/cv", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const c = await candidatParId(ctx.env.DB, ctx.params.id!);
    const objet = c?.cv_cle && !c.supprime_le ? await ctx.env.MEDIA.get(c.cv_cle) : null;
    if (!c || !objet?.body) throw introuvable("Pas de CV");
    await journaliser(ctx.env.DB, id.email, { action: "whyme.cv.lecture", cibleType: "wm_candidat", cibleId: c.id });
    return new Response(objet.body, { headers: {
      "content-type": c.cv_type ?? "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
      "content-disposition": `${c.cv_type === "application/pdf" ? "inline" : "attachment"}; filename="${(c.cv_nom ?? "cv").replace(/[^\w.-]/g, "-")}"`,
    } });
  });

  // ------------------------------------------------------------------ suppressions (fiches créées par erreur)
  // Seulement ce qui n'a encore servi à rien : une fiche liée à une campagne ou à une candidature reste.
  r.ajouter("DELETE", "/api/rh/clients/:id", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const c = await ctx.env.DB.prepare("SELECT id, nom FROM wm_clients WHERE id = ?").bind(ctx.params.id!).first<{ id: string; nom: string }>();
    if (!c) throw introuvable("Client introuvable");
    if (await ctx.env.DB.prepare("SELECT 1 FROM wm_campagnes WHERE client_id = ?").bind(c.id).first()) throw conflit("Ce client a des campagnes : il ne peut pas être supprimé");
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("DELETE FROM wm_jetons_contact WHERE contact_id IN (SELECT id FROM wm_contacts_client WHERE client_id = ?)").bind(c.id),
      ctx.env.DB.prepare("DELETE FROM wm_contacts_client WHERE client_id = ?").bind(c.id),
      ctx.env.DB.prepare("DELETE FROM wm_clients WHERE id = ?").bind(c.id),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.client.suppression", cibleType: "wm_client", cibleId: c.id, details: { nom: c.nom } }),
    ]);
    return json({ ok: true });
  });

  r.ajouter("DELETE", "/api/rh/entreprises/:id", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const e = await ctx.env.DB.prepare("SELECT id, nom, logo_cle FROM wm_entreprises WHERE id = ?").bind(ctx.params.id!).first<{ id: string; nom: string; logo_cle: string | null }>();
    if (!e) throw introuvable("Entreprise introuvable");
    if (await ctx.env.DB.prepare("SELECT 1 FROM wm_campagne_entreprises WHERE entreprise_id = ?").bind(e.id).first()
      || await ctx.env.DB.prepare("SELECT 1 FROM wm_candidatures WHERE entreprise_id = ?").bind(e.id).first()) {
      throw conflit("Cette entreprise est proposée dans une campagne ou a reçu des candidatures : elle ne peut pas être supprimée");
    }
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("DELETE FROM wm_jetons_recruteur WHERE recruteur_id IN (SELECT id FROM wm_recruteurs WHERE entreprise_id = ?)").bind(e.id),
      ctx.env.DB.prepare("DELETE FROM wm_recruteurs WHERE entreprise_id = ?").bind(e.id),
      ctx.env.DB.prepare("DELETE FROM wm_entreprises WHERE id = ?").bind(e.id),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.entreprise.suppression", cibleType: "wm_entreprise", cibleId: e.id, details: { nom: e.nom } }),
    ]);
    if (e.logo_cle) await ctx.env.MEDIA.delete(e.logo_cle);
    return json({ ok: true });
  });

  r.ajouter("DELETE", "/api/rh/campagnes/:id", async (ctx) => {
    const id = await whyme(ctx, "gerer");
    const c = await campagneParId(ctx.env.DB, ctx.params.id!);
    if (c.statut !== "brouillon") throw conflit("Seule une campagne en brouillon peut être supprimée");
    if (await ctx.env.DB.prepare("SELECT 1 FROM wm_candidats WHERE campagne_id = ?").bind(c.id).first()) throw conflit("Cette campagne a des interviews : elle ne peut pas être supprimée");
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("DELETE FROM wm_campagne_entreprises WHERE campagne_id = ?").bind(c.id),
      ctx.env.DB.prepare("DELETE FROM wm_campagnes WHERE id = ?").bind(c.id),
      ligneJournal(ctx.env.DB, id.email, { action: "whyme.campagne.suppression", cibleType: "wm_campagne", cibleId: c.id, details: { nom: c.nom } }),
    ]);
    return json({ ok: true });
  });
}
