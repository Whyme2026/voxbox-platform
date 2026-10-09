// API de l'espace WhyMe : clients, comptes, campagnes, cabines, journal.
// Réservée aux rôles WhyMe ; chaque route vérifie en plus l'action précise.

import type { Contexte, Routeur } from "../routeur.ts";
import { identifier, estWhyme, ROLES_CLIENT, ROLES_WHYME, type Identite, type Role } from "../auth/identite.ts";
import { exiger, type Action } from "../auth/droits.ts";
import { conflit, interdit, introuvable, invalide, json, lireJson, maintenant, nouvelId, texte } from "../http.ts";
import { ligneJournal } from "../journal.ts";
import { validerParcours } from "../parcours/schema.ts";
import { empreinte, genererTextes, type FicheClient } from "../rgpd/consentement.ts";
import { changerStatut, chargerCampagne, detailCampagne, verifierModifiable, type Statut } from "./campagnes-commun.ts";
import { codeAleatoire } from "../auth/cabine.ts";

async function whyme(ctx: Contexte, action: Action): Promise<Identite> {
  const id = await identifier(ctx.request, ctx.env);
  if (!estWhyme(id)) throw interdit();
  exiger(id, action);
  return id;
}

export function slugifier(s: string): string {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 40) || "sans-nom";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function couleurs(v: unknown): string {
  if (v === undefined) return "{}";
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalide("couleurs : objet attendu");
  for (const [k, c] of Object.entries(v)) {
    if (typeof c !== "string" || !/^#[0-9a-fA-F]{6}$/.test(c)) throw invalide(`couleurs.${k} : format #RRGGBB attendu`);
  }
  return JSON.stringify(v);
}

const codeAppairage = () => codeAleatoire(6);

export function routesAdmin(r: Routeur): void {
  // ---------------------------------------------------------------- clients
  r.get("/api/admin/clients", async (ctx) => {
    await whyme(ctx, "campagnes.lire");
    const { results } = await ctx.env.DB.prepare("SELECT * FROM clients ORDER BY nom").all();
    return json({ clients: results.map((c) => ({ ...c, couleurs: JSON.parse(String(c.couleurs)) })) });
  });

  r.post("/api/admin/clients", async (ctx) => {
    const id = await whyme(ctx, "clients.gerer");
    const d = await lireJson(ctx.request);
    const nom = texte(d, "nom", { requis: true, max: 80 })!;
    const fiche = {
      id: nouvelId(),
      slug: slugifier(texte(d, "slug", { max: 40 }) ?? nom),
      nom,
      raison_sociale: texte(d, "raison_sociale", { requis: true, max: 160 })!,
      contact_rgpd: texte(d, "contact_rgpd", { requis: true, max: 160 })!,
      logo_url: texte(d, "logo_url", { max: 500 }) ?? null,
      couleurs: couleurs(d.couleurs),
    };
    const existe = await ctx.env.DB.prepare("SELECT 1 FROM clients WHERE slug = ?").bind(fiche.slug).first();
    if (existe) throw conflit(`Un client « ${fiche.slug} » existe déjà`);
    const now = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO clients (id, slug, nom, raison_sociale, contact_rgpd, logo_url, couleurs, cree_le, maj_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(fiche.id, fiche.slug, fiche.nom, fiche.raison_sociale, fiche.contact_rgpd, fiche.logo_url, fiche.couleurs, now, now),
      ligneJournal(ctx.env.DB, id, { action: "client.creation", cibleType: "client", cibleId: fiche.id, clientId: fiche.id }),
    ]);
    return json({ client: { ...fiche, couleurs: JSON.parse(fiche.couleurs) } }, 201);
  });

  r.patch("/api/admin/clients/:id", async (ctx) => {
    const id = await whyme(ctx, "clients.gerer");
    const c = await ctx.env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(ctx.params.id).first<Record<string, unknown>>();
    if (!c) throw introuvable("Client introuvable");
    const d = await lireJson(ctx.request);
    const maj = {
      nom: texte(d, "nom", { max: 80 }) ?? c.nom,
      raison_sociale: texte(d, "raison_sociale", { max: 160 }) ?? c.raison_sociale,
      contact_rgpd: texte(d, "contact_rgpd", { max: 160 }) ?? c.contact_rgpd,
      logo_url: d.logo_url === null ? null : texte(d, "logo_url", { max: 500 }) ?? c.logo_url,
      couleurs: d.couleurs === undefined ? c.couleurs : couleurs(d.couleurs),
    };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE clients SET nom = ?, raison_sociale = ?, contact_rgpd = ?, logo_url = ?, couleurs = ?, maj_le = ? WHERE id = ?")
        .bind(maj.nom, maj.raison_sociale, maj.contact_rgpd, maj.logo_url, maj.couleurs, maintenant(), ctx.params.id),
      ligneJournal(ctx.env.DB, id, { action: "client.modification", cibleType: "client", cibleId: ctx.params.id, clientId: ctx.params.id }),
    ]);
    return json({ client: { ...c, ...maj, couleurs: JSON.parse(String(maj.couleurs)) } });
  });

  // ---------------------------------------------------------------- comptes
  r.get("/api/admin/utilisateurs", async (ctx) => {
    await whyme(ctx, "utilisateurs.gerer");
    const { results } = await ctx.env.DB.prepare(
      "SELECT u.id, u.email, u.role, u.client_id, c.nom AS client_nom, u.actif, u.cree_le FROM utilisateurs u LEFT JOIN clients c ON c.id = u.client_id ORDER BY u.email",
    ).all();
    return json({ utilisateurs: results });
  });

  r.post("/api/admin/utilisateurs", async (ctx) => {
    const id = await whyme(ctx, "utilisateurs.gerer");
    const d = await lireJson(ctx.request);
    const email = texte(d, "email", { requis: true, max: 160 })!.toLowerCase();
    if (!EMAIL.test(email)) throw invalide("email : adresse invalide");
    const role = d.role as Role;
    if (![...ROLES_WHYME, ...ROLES_CLIENT].includes(role)) throw invalide("role : valeur inconnue");
    const clientId = texte(d, "client_id", { max: 64 }) ?? null;
    if (ROLES_CLIENT.includes(role)) {
      if (!clientId) throw invalide("client_id : obligatoire pour un compte client");
      const c = await ctx.env.DB.prepare("SELECT 1 FROM clients WHERE id = ?").bind(clientId).first();
      if (!c) throw invalide("client_id : client inconnu");
    } else if (clientId) {
      throw invalide("client_id : un compte WhyMe n'est rattaché à aucun client");
    }
    const existe = await ctx.env.DB.prepare("SELECT 1 FROM utilisateurs WHERE email = ?").bind(email).first();
    if (existe) throw conflit("Un compte existe déjà pour cet e-mail");
    const u = { id: nouvelId(), email, role, client_id: clientId, actif: 1, cree_le: maintenant() };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO utilisateurs (id, email, role, client_id, actif, cree_le) VALUES (?, ?, ?, ?, 1, ?)")
        .bind(u.id, u.email, u.role, u.client_id, u.cree_le),
      ligneJournal(ctx.env.DB, id, { action: "utilisateur.creation", cibleType: "utilisateur", cibleId: u.id, clientId, details: { email, role } }),
    ]);
    return json({ utilisateur: u }, 201);
  });

  r.patch("/api/admin/utilisateurs/:id", async (ctx) => {
    const id = await whyme(ctx, "utilisateurs.gerer");
    const u = await ctx.env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(ctx.params.id)
      .first<{ id: string; email: string; role: Role; client_id: string | null; actif: number }>();
    if (!u) throw introuvable("Compte introuvable");
    const d = await lireJson(ctx.request);
    if (d.actif !== undefined && typeof d.actif !== "boolean") throw invalide("actif : vrai ou faux attendu");
    const actif = d.actif === undefined ? u.actif : d.actif ? 1 : 0;
    if (u.email === id.email && actif === 0) throw conflit("Vous ne pouvez pas désactiver votre propre compte");
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE utilisateurs SET actif = ? WHERE id = ?").bind(actif, u.id),
      ligneJournal(ctx.env.DB, id, {
        action: actif ? "utilisateur.reactivation" : "utilisateur.desactivation",
        cibleType: "utilisateur", cibleId: u.id, clientId: u.client_id, details: { email: u.email },
      }),
    ]);
    return json({ utilisateur: { ...u, actif } });
  });

  // ---------------------------------------------------------------- campagnes
  r.get("/api/admin/campagnes", async (ctx) => {
    await whyme(ctx, "campagnes.lire");
    const client = ctx.url.searchParams.get("client");
    const sql = "SELECT c.*, cl.nom AS client_nom FROM campagnes c JOIN clients cl ON cl.id = c.client_id"
      + (client ? " WHERE c.client_id = ?" : "") + " ORDER BY c.cree_le DESC";
    const st = ctx.env.DB.prepare(sql);
    const { results } = await (client ? st.bind(client) : st).all();
    return json({ campagnes: results });
  });

  r.post("/api/admin/campagnes", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const d = await lireJson(ctx.request);
    const clientId = texte(d, "client_id", { requis: true, max: 64 })!;
    const client = await ctx.env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
    if (!client) throw invalide("client_id : client inconnu");
    const nom = texte(d, "nom", { requis: true, max: 120 })!;
    const debut = texte(d, "debut", { max: 10 }) ?? null;
    const fin = texte(d, "fin", { max: 10 }) ?? null;
    if ((debut && !DATE.test(debut)) || (fin && !DATE.test(fin))) throw invalide("dates au format AAAA-MM-JJ");
    if (debut && fin && fin < debut) throw invalide("La fin précède le début");
    const conservation = d.conservation_jours === undefined ? 365 : Number(d.conservation_jours);
    if (!Number.isInteger(conservation) || conservation < 1 || conservation > 1095) throw invalide("conservation_jours : entre 1 et 1095");
    const slug = slugifier(texte(d, "slug", { max: 40 }) ?? nom);
    const existe = await ctx.env.DB.prepare("SELECT 1 FROM campagnes WHERE client_id = ? AND slug = ?").bind(clientId, slug).first();
    if (existe) throw conflit(`Une campagne « ${slug} » existe déjà pour ce client`);
    const now = maintenant();
    const c = { id: nouvelId(), client_id: clientId, slug, nom, debut, fin, statut: "brouillon", conservation_jours: conservation };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO campagnes (id, client_id, slug, nom, debut, fin, statut, conservation_jours, cree_le, maj_le) VALUES (?, ?, ?, ?, ?, ?, 'brouillon', ?, ?, ?)",
      ).bind(c.id, c.client_id, c.slug, c.nom, c.debut, c.fin, c.conservation_jours, now, now),
      ligneJournal(ctx.env.DB, id, { action: "campagne.creation", cibleType: "campagne", cibleId: c.id, clientId }),
    ]);
    return json({ campagne: c }, 201);
  });

  r.get("/api/admin/campagnes/:id", async (ctx) => {
    const id = await whyme(ctx, "campagnes.lire");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    return json({ campagne: await detailCampagne(ctx.env.DB, c) });
  });

  // Nouvelle version du parcours (fichier de configuration JSON).
  r.post("/api/admin/campagnes/:id/parcours", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    verifierModifiable(c);
    const d = await lireJson(ctx.request);
    const problemes = validerParcours(d.config);
    if (problemes.length) return json({ erreur: "parcours_invalide", problemes }, 400);
    const der = await ctx.env.DB.prepare("SELECT MAX(numero) AS n FROM parcours_versions WHERE campagne_id = ?").bind(c.id).first<{ n: number | null }>();
    const v = { id: nouvelId(), numero: (der?.n ?? 0) + 1 };
    const now = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO parcours_versions (id, campagne_id, numero, config, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(v.id, c.id, v.numero, JSON.stringify(d.config), id.email, now),
      // Toute modification remet la campagne en brouillon : le client doit revalider.
      ctx.env.DB.prepare("UPDATE campagnes SET parcours_version_id = ?, statut = 'brouillon', validee_par = NULL, validee_le = NULL, maj_le = ? WHERE id = ?")
        .bind(v.id, now, c.id),
      ligneJournal(ctx.env.DB, id, { action: "campagne.parcours", cibleType: "campagne", cibleId: c.id, clientId: c.client_id, details: { version: v.numero } }),
    ]);
    return json({ parcours_version: v }, 201);
  });

  // Nouvelle version des textes de consentement, générés depuis la fiche client sauf textes fournis.
  r.post("/api/admin/campagnes/:id/consentement", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    verifierModifiable(c);
    const d = await lireJson(ctx.request);
    const fiche = await ctx.env.DB.prepare("SELECT nom, raison_sociale, contact_rgpd FROM clients WHERE id = ?").bind(c.client_id).first<FicheClient>();
    if (!fiche) throw introuvable("Client introuvable");
    const generes = genererTextes(fiche, c.conservation_jours);
    const textes = {
      texte_interne: texte(d, "texte_interne", { max: 2000 }) ?? generes.texte_interne,
      texte_diffusion: texte(d, "texte_diffusion", { max: 1000 }) ?? generes.texte_diffusion,
    };
    const der = await ctx.env.DB.prepare("SELECT MAX(numero) AS n FROM consentement_versions WHERE campagne_id = ?").bind(c.id).first<{ n: number | null }>();
    const v = { id: nouvelId(), numero: (der?.n ?? 0) + 1, ...textes, empreinte: await empreinte(textes) };
    const now = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO consentement_versions (id, campagne_id, numero, texte_interne, texte_diffusion, empreinte, cree_par, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(v.id, c.id, v.numero, v.texte_interne, v.texte_diffusion, v.empreinte, id.email, now),
      ctx.env.DB.prepare("UPDATE campagnes SET consentement_version_id = ?, statut = 'brouillon', validee_par = NULL, validee_le = NULL, maj_le = ? WHERE id = ?")
        .bind(v.id, now, c.id),
      ligneJournal(ctx.env.DB, id, { action: "campagne.consentement", cibleType: "campagne", cibleId: c.id, clientId: c.client_id, details: { version: v.numero } }),
    ]);
    return json({ consentement_version: v }, 201);
  });

  r.post("/api/admin/campagnes/:id/statut", async (ctx) => {
    const id = await whyme(ctx, "campagnes.gerer");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    const d = await lireJson(ctx.request);
    const cible = d.statut as Statut;
    if (!["brouillon", "validee", "active", "close"].includes(cible)) throw invalide("statut : valeur inconnue");
    if (cible === "validee") exiger(id, "campagnes.valider");
    await changerStatut(ctx.env.DB, id, c, cible);
    return json({ campagne: { ...c, statut: cible } });
  });

  // ---------------------------------------------------------------- cabines
  r.get("/api/admin/cabines", async (ctx) => {
    await whyme(ctx, "cabines.gerer");
    const { results } = await ctx.env.DB.prepare(
      "SELECT cb.id, cb.nom, cb.code_appairage, cb.jeton_hash IS NOT NULL AS appairee, cb.campagne_id, ca.nom AS campagne_nom, cb.dernier_signal, cb.vu_le, cb.cree_le FROM cabines cb LEFT JOIN campagnes ca ON ca.id = cb.campagne_id ORDER BY cb.nom",
    ).all();
    return json({ cabines: results });
  });

  r.post("/api/admin/cabines", async (ctx) => {
    const id = await whyme(ctx, "cabines.gerer");
    const d = await lireJson(ctx.request);
    const cab = { id: nouvelId(), nom: texte(d, "nom", { requis: true, max: 60 })!, code_appairage: codeAppairage(), cree_le: maintenant() };
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("INSERT INTO cabines (id, nom, code_appairage, cree_le) VALUES (?, ?, ?, ?)").bind(cab.id, cab.nom, cab.code_appairage, cab.cree_le),
      ligneJournal(ctx.env.DB, id, { action: "cabine.creation", cibleType: "cabine", cibleId: cab.id }),
    ]);
    return json({ cabine: cab }, 201);
  });

  r.patch("/api/admin/cabines/:id", async (ctx) => {
    const id = await whyme(ctx, "cabines.gerer");
    const cab = await ctx.env.DB.prepare("SELECT id FROM cabines WHERE id = ?").bind(ctx.params.id).first();
    if (!cab) throw introuvable("Cabine introuvable");
    const d = await lireJson(ctx.request);
    const campagneId = d.campagne_id === null ? null : texte(d, "campagne_id", { requis: true, max: 64 })!;
    let clientId: string | null = null;
    if (campagneId) {
      const c = await ctx.env.DB.prepare("SELECT client_id, statut FROM campagnes WHERE id = ?").bind(campagneId).first<{ client_id: string; statut: Statut }>();
      if (!c) throw invalide("campagne_id : campagne inconnue");
      if (c.statut === "close") throw conflit("Impossible d'affecter une campagne close");
      clientId = c.client_id;
    }
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE cabines SET campagne_id = ? WHERE id = ?").bind(campagneId, ctx.params.id),
      ligneJournal(ctx.env.DB, id, { action: "cabine.affectation", cibleType: "cabine", cibleId: ctx.params.id, clientId, details: { campagne_id: campagneId } }),
    ]);
    return json({ cabine: { id: ctx.params.id, campagne_id: campagneId } });
  });

  // Nouveau code d'appairage : la tablette actuelle est déconnectée (jeton révoqué).
  r.post("/api/admin/cabines/:id/code", async (ctx) => {
    const id = await whyme(ctx, "cabines.gerer");
    const cab = await ctx.env.DB.prepare("SELECT id FROM cabines WHERE id = ?").bind(ctx.params.id).first();
    if (!cab) throw introuvable("Cabine introuvable");
    const code = codeAppairage();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE cabines SET code_appairage = ?, jeton_hash = NULL WHERE id = ?").bind(code, ctx.params.id),
      ligneJournal(ctx.env.DB, id, { action: "cabine.nouveau_code", cibleType: "cabine", cibleId: ctx.params.id }),
    ]);
    return json({ cabine: { id: ctx.params.id, code_appairage: code } });
  });

  // ---------------------------------------------------------------- journal
  r.get("/api/admin/journal", async (ctx) => {
    await whyme(ctx, "journal.lire");
    const limite = Math.min(Math.max(Number(ctx.url.searchParams.get("limite") ?? 100) || 100, 1), 500);
    const client = ctx.url.searchParams.get("client");
    const st = ctx.env.DB.prepare(
      `SELECT * FROM journal ${client ? "WHERE client_id = ?" : ""} ORDER BY quand DESC LIMIT ${limite}`,
    );
    const { results } = await (client ? st.bind(client) : st).all();
    return json({ journal: results });
  });
}
