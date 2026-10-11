// Espace partenaires Why me (/recruteur/). Connexion par lien envoyé par e-mail (15 min, usage unique), puis session
// de 12 h. Deux sortes de comptes :
// - recruteur (entreprise, sous-client) : ne voit que les candidatures transmises à son entreprise, pendant 12 mois :
//   CV et vidéo montée (jamais les rushes), consultables et téléchargeables, chaque accès journalisé ;
// - contact client (organisateur qui a commandé la campagne) : statistiques agrégées de ses campagnes seulement,
//   jamais une identité, une vidéo ni un CV.
// Aucune note, aucun score.
// ⚠ Publique côté Cloudflare Access : /recruteur et /api/recruteur doivent être exclus de la protection.

import type { Routeur, Contexte } from "../routeur.ts";
import { HttpError, introuvable, invalide, json, lireJson, maintenant, texte } from "../http.ts";
import { empreinteJeton, nouveauJeton } from "../auth/cabine.ts";
import { journaliser } from "../journal.ts";
import { servirMiniature, servirVideo } from "../media.ts";
import { JETON } from "./commun.ts";
import { courrielConnexionRecruteur, envoyerWhyme } from "./courriels.ts";
import { statistiquesClient } from "./statistiques.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const LIEN_MIN = 15;
export const SESSION_H = 12;
export const DEMANDES_PAR_HEURE = 3;
const MESSAGE = "Si cette adresse a accès à l'espace, un lien de connexion vient d'y être envoyé.";

interface Recruteur { id: string; email: string; entreprise_id: string; entreprise: string }

const plusTard = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

async function recruteurConnecte(ctx: Contexte): Promise<Recruteur> {
  const m = /^Bearer\s+(\S+)$/.exec(ctx.request.headers.get("authorization") ?? "");
  if (!m || !JETON.test(m[1]!)) throw new HttpError(401, "non_authentifie", "Connectez-vous");
  const r = await ctx.env.DB.prepare(
    `SELECT r.id, r.email, r.entreprise_id, e.nom AS entreprise FROM wm_jetons_recruteur j
       JOIN wm_recruteurs r ON r.id = j.recruteur_id JOIN wm_entreprises e ON e.id = r.entreprise_id
      WHERE j.empreinte = ? AND j.sorte = 'session' AND j.expire_le > ? AND r.actif = 1`,
  ).bind(await empreinteJeton(m[1]!), maintenant()).first<Recruteur>();
  if (!r) throw new HttpError(401, "session_expiree", "Votre session a expiré : reconnectez-vous");
  return r;
}

interface Contact { id: string; email: string; client_id: string; client: string }

async function contactConnecte(ctx: Contexte): Promise<Contact> {
  const m = /^Bearer\s+(\S+)$/.exec(ctx.request.headers.get("authorization") ?? "");
  if (!m || !JETON.test(m[1]!)) throw new HttpError(401, "non_authentifie", "Connectez-vous");
  const c = await ctx.env.DB.prepare(
    `SELECT k.id, k.email, k.client_id, cl.nom AS client FROM wm_jetons_contact j
       JOIN wm_contacts_client k ON k.id = j.contact_id JOIN wm_clients cl ON cl.id = k.client_id
      WHERE j.empreinte = ? AND j.sorte = 'session' AND j.expire_le > ? AND k.actif = 1`,
  ).bind(await empreinteJeton(m[1]!), maintenant()).first<Contact>();
  if (!c) throw new HttpError(401, "session_expiree", "Votre session a expiré : reconnectez-vous");
  return c;
}

/** Candidature visible par ce recruteur : transmise à son entreprise, non retirée, accès de 12 mois en cours. */
async function candidatureVisible(ctx: Contexte, rec: Recruteur, id: string) {
  const c = await ctx.env.DB.prepare(
    `SELECT c.id, c.prenom, c.nom, c.montage_cle, c.miniature_cle, c.cv_cle, c.cv_nom, c.cv_type FROM wm_candidatures ca
       JOIN wm_candidats c ON c.id = ca.candidat_id
      WHERE ca.candidat_id = ? AND ca.entreprise_id = ? AND ca.transmise_le IS NOT NULL AND ca.retiree_le IS NULL
        AND c.supprime_le IS NULL AND c.acces_recruteurs_jusqu > ?`,
  ).bind(id, rec.entreprise_id, maintenant()).first<{ id: string; prenom: string; nom: string; montage_cle: string | null; miniature_cle: string | null; cv_cle: string | null; cv_nom: string | null; cv_type: string | null }>();
  if (!c) throw introuvable("Candidature introuvable");
  return c;
}

export function routesWhymeRecruteur(r: Routeur): void {
  // Demande de lien : même réponse dans tous les cas (on ne révèle pas qui a un compte).
  r.post("/api/recruteur/lien", async (ctx) => {
    const d = await lireJson(ctx.request);
    const email = texte(d, "email", { requis: true, max: 200 })!.toLowerCase();
    if (!EMAIL.test(email)) throw invalide("Adresse e-mail invalide");
    const rec = await ctx.env.DB.prepare(
      "SELECT r.id, e.nom AS entreprise FROM wm_recruteurs r JOIN wm_entreprises e ON e.id = r.entreprise_id WHERE r.email = ? AND r.actif = 1",
    ).bind(email).first<{ id: string; entreprise: string }>();
    if (rec) {
      const recents = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM wm_jetons_recruteur WHERE recruteur_id = ? AND sorte = 'lien' AND cree_le > ?")
        .bind(rec.id, plusTard(-60)).first<{ n: number }>();
      if ((recents?.n ?? 0) < DEMANDES_PAR_HEURE) {
        const jeton = nouveauJeton();
        await ctx.env.DB.prepare("INSERT INTO wm_jetons_recruteur (empreinte, recruteur_id, sorte, expire_le, cree_le) VALUES (?, ?, 'lien', ?, ?)")
          .bind(await empreinteJeton(jeton), rec.id, plusTard(LIEN_MIN), maintenant()).run();
        await envoyerWhyme(ctx.env, email, "connexion_recruteur", courrielConnexionRecruteur(rec.entreprise, `${ctx.url.origin}/recruteur/#lien=${jeton}`));
      }
    } else {
      const contact = await ctx.env.DB.prepare(
        "SELECT k.id, cl.nom AS client FROM wm_contacts_client k JOIN wm_clients cl ON cl.id = k.client_id WHERE k.email = ? AND k.actif = 1",
      ).bind(email).first<{ id: string; client: string }>();
      if (contact) {
        const recents = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM wm_jetons_contact WHERE contact_id = ? AND sorte = 'lien' AND cree_le > ?")
          .bind(contact.id, plusTard(-60)).first<{ n: number }>();
        if ((recents?.n ?? 0) < DEMANDES_PAR_HEURE) {
          const jeton = nouveauJeton();
          await ctx.env.DB.prepare("INSERT INTO wm_jetons_contact (empreinte, contact_id, sorte, expire_le, cree_le) VALUES (?, ?, 'lien', ?, ?)")
            .bind(await empreinteJeton(jeton), contact.id, plusTard(LIEN_MIN), maintenant()).run();
          await envoyerWhyme(ctx.env, email, "connexion_client",
            courrielConnexionRecruteur(contact.client, `${ctx.url.origin}/recruteur/#lien=${jeton}`, "votre espace WhyMe"));
        }
      }
    }
    return json({ message: MESSAGE });
  });

  // Le lien de l'e-mail contre une session de 12 h.
  r.post("/api/recruteur/session", async (ctx) => {
    const d = await lireJson(ctx.request);
    const lien = texte(d, "lien", { requis: true, max: 64 })!;
    if (!JETON.test(lien)) throw new HttpError(401, "lien_invalide", "Ce lien n'est pas valable.");
    const empreinte = await empreinteJeton(lien);
    const j = await ctx.env.DB.prepare(
      `SELECT j.recruteur_id, r.email, e.nom AS entreprise FROM wm_jetons_recruteur j JOIN wm_recruteurs r ON r.id = j.recruteur_id
         JOIN wm_entreprises e ON e.id = r.entreprise_id
        WHERE j.empreinte = ? AND j.sorte = 'lien' AND j.utilise_le IS NULL AND j.expire_le > ? AND r.actif = 1`,
    ).bind(empreinte, maintenant()).first<{ recruteur_id: string; email: string; entreprise: string }>();
    if (!j) return sessionContact(ctx, empreinte);
    const session = nouveauJeton();
    const t = maintenant();
    const res = await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE wm_jetons_recruteur SET utilise_le = ? WHERE empreinte = ? AND utilise_le IS NULL").bind(t, empreinte),
      ctx.env.DB.prepare("INSERT INTO wm_jetons_recruteur (empreinte, recruteur_id, sorte, expire_le, cree_le) VALUES (?, ?, 'session', ?, ?)")
        .bind(await empreinteJeton(session), j.recruteur_id, plusTard(SESSION_H * 60), t),
    ]);
    if (!res[0]?.meta.changes) throw new HttpError(401, "lien_expire", "Ce lien a déjà servi. Demandez-en un nouveau.");
    await journaliser(ctx.env.DB, j.email, { action: "recruteur.connexion", cibleType: "wm_recruteur", cibleId: j.recruteur_id });
    return json({ jeton: session, email: j.email, profil: "recruteur", entreprise: j.entreprise, expire_le: plusTard(SESSION_H * 60) });
  });

  r.post("/api/recruteur/deconnexion", async (ctx) => {
    const m = /^Bearer\s+(\S+)$/.exec(ctx.request.headers.get("authorization") ?? "");
    if (m && JETON.test(m[1]!)) {
      const e = await empreinteJeton(m[1]!);
      await ctx.env.DB.batch([
        ctx.env.DB.prepare("DELETE FROM wm_jetons_recruteur WHERE empreinte = ? AND sorte = 'session'").bind(e),
        ctx.env.DB.prepare("DELETE FROM wm_jetons_contact WHERE empreinte = ? AND sorte = 'session'").bind(e),
      ]);
    }
    return json({ ok: true });
  });

  // Contact client : statistiques agrégées des campagnes de son client, rien d'autre.
  r.get("/api/recruteur/statistiques", async (ctx) => {
    const c = await contactConnecte(ctx);
    await journaliser(ctx.env.DB, c.email, { action: "client.statistiques.lecture", cibleType: "wm_client", cibleId: c.client_id });
    return json({ client: c.client, email: c.email, campagnes: await statistiquesClient(ctx.env.DB, c.client_id) });
  });

  r.get("/api/recruteur/candidats", async (ctx) => {
    const rec = await recruteurConnecte(ctx);
    const lignes = await ctx.env.DB.prepare(
      `SELECT c.id, c.prenom, c.nom, c.email, c.age, c.famille, c.cv_cle IS NOT NULL AS a_cv, c.montage_cle IS NOT NULL AS a_video,
              c.miniature_cle IS NOT NULL AS a_miniature, ca.transmise_le, c.acces_recruteurs_jusqu, w.config, w.nom AS campagne
         FROM wm_candidatures ca JOIN wm_candidats c ON c.id = ca.candidat_id JOIN wm_campagnes w ON w.id = c.campagne_id
        WHERE ca.entreprise_id = ? AND ca.transmise_le IS NOT NULL AND ca.retiree_le IS NULL AND c.supprime_le IS NULL
          AND c.acces_recruteurs_jusqu > ?
        ORDER BY ca.transmise_le DESC LIMIT 500`,
    ).bind(rec.entreprise_id, maintenant()).all<Record<string, any>>();
    const candidats = lignes.results.map((l) => {
      const cfg = JSON.parse(l.config) as { evenement: string; familles?: { id: string; nom: string }[] };
      return {
        id: l.id, prenom: l.prenom, nom: l.nom, email: l.email, age: l.age,
        famille: cfg.familles?.find((f) => f.id === l.famille)?.nom ?? null, evenement: cfg.evenement,
        aCv: Boolean(l.a_cv), aVideo: Boolean(l.a_video), aMiniature: Boolean(l.a_miniature),
        transmise_le: l.transmise_le, acces_jusqu: l.acces_recruteurs_jusqu,
      };
    });
    return json({ entreprise: rec.entreprise, email: rec.email, candidats });
  });

  // Vidéo montée : lecture (journalisée « lecture ») ou téléchargement (?telecharger=1, journalisé à part).
  r.get("/api/recruteur/candidats/:id/video", async (ctx) => {
    const rec = await recruteurConnecte(ctx);
    const c = await candidatureVisible(ctx, rec, ctx.params.id!);
    if (!c.montage_cle) throw introuvable("Le candidat a supprimé sa vidéo");
    const telecharger = ctx.url.searchParams.get("telecharger") === "1";
    return servirVideo(ctx.request, ctx.env, c.montage_cle, {
      type: "video/mp4", nom: `whyme-${c.prenom}-${c.nom}.mp4`,
      journaliser: () => journaliser(ctx.env.DB, rec.email, {
        action: telecharger ? "recruteur.video.telechargement" : "recruteur.video.lecture", cibleType: "wm_candidat", cibleId: c.id,
        details: { entreprise: rec.entreprise },
      }),
    });
  });

  r.get("/api/recruteur/candidats/:id/miniature", async (ctx) => {
    const rec = await recruteurConnecte(ctx);
    const c = await candidatureVisible(ctx, rec, ctx.params.id!);
    return servirMiniature(ctx.env, c.miniature_cle);
  });

  r.get("/api/recruteur/candidats/:id/cv", async (ctx) => {
    const rec = await recruteurConnecte(ctx);
    const c = await candidatureVisible(ctx, rec, ctx.params.id!);
    const objet = c.cv_cle ? await ctx.env.MEDIA.get(c.cv_cle) : null;
    if (!objet?.body) throw introuvable("Pas de CV");
    const telecharger = ctx.url.searchParams.get("telecharger") === "1";
    await journaliser(ctx.env.DB, rec.email, {
      action: telecharger ? "recruteur.cv.telechargement" : "recruteur.cv.lecture", cibleType: "wm_candidat", cibleId: c.id,
      details: { entreprise: rec.entreprise },
    });
    const nom = (c.cv_nom ?? "cv").replace(/[^\w.-]/g, "-");
    return new Response(objet.body, {
      headers: {
        "content-type": c.cv_type ?? "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
        "content-disposition": `${telecharger || c.cv_type !== "application/pdf" ? "attachment" : "inline"}; filename="${nom}"`,
      },
    });
  });
}

/** Lien d'un contact client contre une session de 12 h (même mécanique que pour les recruteurs). */
async function sessionContact(ctx: Contexte, empreinte: string): Promise<Response> {
  const j = await ctx.env.DB.prepare(
    `SELECT j.contact_id, k.email, cl.nom AS client FROM wm_jetons_contact j JOIN wm_contacts_client k ON k.id = j.contact_id
       JOIN wm_clients cl ON cl.id = k.client_id
      WHERE j.empreinte = ? AND j.sorte = 'lien' AND j.utilise_le IS NULL AND j.expire_le > ? AND k.actif = 1`,
  ).bind(empreinte, maintenant()).first<{ contact_id: string; email: string; client: string }>();
  if (!j) throw new HttpError(401, "lien_expire", "Ce lien a expiré ou a déjà servi. Demandez-en un nouveau.");
  const session = nouveauJeton();
  const t = maintenant();
  const res = await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE wm_jetons_contact SET utilise_le = ? WHERE empreinte = ? AND utilise_le IS NULL").bind(t, empreinte),
    ctx.env.DB.prepare("INSERT INTO wm_jetons_contact (empreinte, contact_id, sorte, expire_le, cree_le) VALUES (?, ?, 'session', ?, ?)")
      .bind(await empreinteJeton(session), j.contact_id, plusTard(SESSION_H * 60), t),
  ]);
  if (!res[0]?.meta.changes) throw new HttpError(401, "lien_expire", "Ce lien a déjà servi. Demandez-en un nouveau.");
  await journaliser(ctx.env.DB, j.email, { action: "client.connexion", cibleType: "wm_contact_client", cibleId: j.contact_id });
  return json({ jeton: session, email: j.email, profil: "client", client: j.client, expire_le: plusTard(SESSION_H * 60) });
}
