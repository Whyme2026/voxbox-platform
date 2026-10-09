import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../src/index.ts";
import { ADMIN, client, creerEnv } from "./aide/env.ts";

const parcoursAuto = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-automobile.json"), "utf8"));

/** Prépare deux marques, chacune avec un validateur, un lecteur et une campagne complète. */
async function scenario() {
  const { env, db } = creerEnv();
  const api = client(env);

  const marque = async (nom: string) => {
    const c = await api("POST", "/api/admin/clients", ADMIN, {
      nom, raison_sociale: `${nom} France SAS`, contact_rgpd: `rgpd@${nom.toLowerCase()}.test`, couleurs: { principale: "#112233" },
    });
    assert.equal(c.status, 201, JSON.stringify(c.corps));
    const id = c.corps.client.id as string;
    const domaine = nom.toLowerCase();
    for (const [email, role] of [[`valide@${domaine}.test`, "validateur_client"], [`lit@${domaine}.test`, "lecteur_client"]]) {
      const u = await api("POST", "/api/admin/utilisateurs", ADMIN, { email, role, client_id: id });
      assert.equal(u.status, 201, JSON.stringify(u.corps));
    }
    const camp = await api("POST", "/api/admin/campagnes", ADMIN, { client_id: id, nom: `${nom} essai`, debut: "2026-11-01", fin: "2026-11-15", conservation_jours: 365 });
    assert.equal(camp.status, 201, JSON.stringify(camp.corps));
    const cid = camp.corps.campagne.id as string;
    assert.equal((await api("POST", `/api/admin/campagnes/${cid}/parcours`, ADMIN, { config: parcoursAuto })).status, 201);
    assert.equal((await api("POST", `/api/admin/campagnes/${cid}/consentement`, ADMIN, {})).status, 201);
    return { clientId: id, campagneId: cid, validateur: `valide@${domaine}.test`, lecteur: `lit@${domaine}.test` };
  };

  const a = await marque("Alpha");
  const b = await marque("Beta");
  return { env, db, api, a, b };
}

test("santé : répond sans authentification", async () => {
  const { env } = creerEnv();
  const r = await client(env)("GET", "/api/sante");
  assert.equal(r.status, 200);
  assert.equal(r.corps.base, "ok");
});

test("sans identité : 401 ; e-mail inconnu : 403", async () => {
  const { env } = creerEnv();
  const api = client(env);
  assert.equal((await api("GET", "/api/moi")).status, 401);
  assert.equal((await api("GET", "/api/moi", "inconnu@ailleurs.test")).status, 403);
});

test("l'administrateur d'office a tous les droits", async () => {
  const { env } = creerEnv();
  const r = await client(env)("GET", "/api/moi", ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.corps.role, "admin_whyme");
  assert.ok(r.corps.droits.includes("utilisateurs.gerer"));
});

test("un compte client ne voit que les campagnes de sa marque", async () => {
  const { api, a, b } = await scenario();
  const liste = await api("GET", "/api/espace/campagnes", a.lecteur);
  assert.equal(liste.status, 200);
  assert.deepEqual(liste.corps.campagnes.map((c: any) => c.id), [a.campagneId]);

  // Demander explicitement l'autre marque est refusé.
  assert.equal((await api("GET", `/api/espace/campagnes?client=${b.clientId}`, a.lecteur)).status, 403);
  // La campagne d'une autre marque est « introuvable », pas « interdite ».
  assert.equal((await api("GET", `/api/espace/campagnes/${b.campagneId}`, a.lecteur)).status, 404);
  assert.equal((await api("POST", `/api/espace/campagnes/${b.campagneId}/valider`, a.validateur)).status, 404);
});

test("un compte client n'a aucun accès à l'espace WhyMe", async () => {
  const { api, a } = await scenario();
  for (const [m, chemin] of [["GET", "/api/admin/clients"], ["GET", "/api/admin/campagnes"], ["GET", "/api/admin/journal"], ["GET", "/api/admin/cabines"]] as const) {
    assert.equal((await api(m, chemin, a.validateur)).status, 403, chemin);
  }
  assert.equal((await api("POST", "/api/admin/campagnes", a.validateur, { client_id: a.clientId, nom: "x" })).status, 403);
});

test("le validateur valide sa campagne, le lecteur ne peut pas", async () => {
  const { api, a } = await scenario();
  assert.equal((await api("POST", `/api/espace/campagnes/${a.campagneId}/valider`, a.lecteur)).status, 403);
  const v = await api("POST", `/api/espace/campagnes/${a.campagneId}/valider`, a.validateur);
  assert.equal(v.status, 200, JSON.stringify(v.corps));
  const d = await api("GET", `/api/espace/campagnes/${a.campagneId}`, a.lecteur);
  assert.equal(d.corps.campagne.statut, "validee");
  assert.equal(d.corps.campagne.validee_par, a.validateur);
  assert.equal(d.corps.campagne.parcours.config.etapes.length, parcoursAuto.etapes.length);
  assert.match(d.corps.campagne.consentement.texte_interne, /Alpha France SAS/);
});

test("modifier le parcours d'une campagne validée la remet en brouillon", async () => {
  const { api, a } = await scenario();
  await api("POST", `/api/espace/campagnes/${a.campagneId}/valider`, a.validateur);
  const r = await api("POST", `/api/admin/campagnes/${a.campagneId}/parcours`, ADMIN, { config: parcoursAuto });
  assert.equal(r.status, 201);
  assert.equal(r.corps.parcours_version.numero, 2);
  const d = await api("GET", `/api/admin/campagnes/${a.campagneId}`, ADMIN);
  assert.equal(d.corps.campagne.statut, "brouillon");
  assert.equal(d.corps.campagne.validee_par, null);
});

test("cycle de vie : on n'active pas une campagne non validée, ni ne modifie une campagne active", async () => {
  const { api, a } = await scenario();
  assert.equal((await api("POST", `/api/admin/campagnes/${a.campagneId}/statut`, ADMIN, { statut: "active" })).status, 409);
  await api("POST", `/api/espace/campagnes/${a.campagneId}/valider`, a.validateur);
  assert.equal((await api("POST", `/api/admin/campagnes/${a.campagneId}/statut`, ADMIN, { statut: "active" })).status, 200);
  assert.equal((await api("POST", `/api/admin/campagnes/${a.campagneId}/parcours`, ADMIN, { config: parcoursAuto })).status, 409);
  assert.equal((await api("POST", `/api/admin/campagnes/${a.campagneId}/statut`, ADMIN, { statut: "close" })).status, 200);
  assert.equal((await api("POST", `/api/admin/campagnes/${a.campagneId}/statut`, ADMIN, { statut: "active" })).status, 409);
});

test("une campagne sans parcours ni consentement ne peut pas être validée", async () => {
  const { api, a } = await scenario();
  const c = await api("POST", "/api/admin/campagnes", ADMIN, { client_id: a.clientId, nom: "Vide" });
  assert.equal((await api("POST", `/api/espace/campagnes/${c.corps.campagne.id}/valider`, a.validateur)).status, 409);
});

test("un parcours invalide est refusé avec la liste des problèmes", async () => {
  const { api, a } = await scenario();
  const r = await api("POST", `/api/admin/campagnes/${a.campagneId}/parcours`, ADMIN, { config: { version: 1, langue: "fr", etapes: [] } });
  assert.equal(r.status, 400);
  assert.equal(r.corps.erreur, "parcours_invalide");
  assert.ok(r.corps.problemes.length > 0);
});

test("un opérateur WhyMe gère les campagnes mais pas les comptes", async () => {
  const { api, a } = await scenario();
  assert.equal((await api("POST", "/api/admin/utilisateurs", ADMIN, { email: "ops@whyme.test", role: "operateur_whyme" })).status, 201);
  assert.equal((await api("GET", "/api/admin/campagnes", "ops@whyme.test")).status, 200);
  assert.equal((await api("POST", "/api/admin/utilisateurs", "ops@whyme.test", { email: "x@y.test", role: "admin_whyme" })).status, 403);
  assert.equal((await api("POST", "/api/admin/clients", "ops@whyme.test", { nom: "Z", raison_sociale: "Z", contact_rgpd: "z" })).status, 403);
  // Un opérateur ne valide pas à la place du client.
  assert.equal((await api("POST", `/api/admin/campagnes/${a.campagneId}/statut`, "ops@whyme.test", { statut: "validee" })).status, 403);
});

test("un compte désactivé perd l'accès immédiatement", async () => {
  const { api, db, a } = await scenario();
  const u = await db.prepare("SELECT id FROM utilisateurs WHERE email = ?").bind(a.lecteur).first<{ id: string }>();
  assert.equal((await api("PATCH", `/api/admin/utilisateurs/${u!.id}`, ADMIN, { actif: false })).status, 200);
  assert.equal((await api("GET", "/api/moi", a.lecteur)).status, 403);
});

test("un compte client doit être rattaché à un client, un compte WhyMe à aucun", async () => {
  const { api, a } = await scenario();
  assert.equal((await api("POST", "/api/admin/utilisateurs", ADMIN, { email: "c@x.test", role: "lecteur_client" })).status, 400);
  assert.equal((await api("POST", "/api/admin/utilisateurs", ADMIN, { email: "w@x.test", role: "operateur_whyme", client_id: a.clientId })).status, 400);
});

test("les actions sensibles sont journalisées", async () => {
  const { api, a } = await scenario();
  await api("POST", `/api/espace/campagnes/${a.campagneId}/valider`, a.validateur);
  const j = await api("GET", `/api/admin/journal?client=${a.clientId}`, ADMIN);
  const actions = j.corps.journal.map((l: any) => l.action);
  for (const attendu of ["client.creation", "utilisateur.creation", "campagne.creation", "campagne.parcours", "campagne.consentement", "campagne.statut.validee"]) {
    assert.ok(actions.includes(attendu), attendu);
  }
  const validation = j.corps.journal.find((l: any) => l.action === "campagne.statut.validee");
  assert.equal(validation.utilisateur_email, a.validateur);
});

test("cabine : création avec code d'appairage et affectation à une campagne", async () => {
  const { api, a } = await scenario();
  const c = await api("POST", "/api/admin/cabines", ADMIN, { nom: "Cabine 1" });
  assert.equal(c.status, 201);
  assert.match(c.corps.cabine.code_appairage, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal((await api("PATCH", `/api/admin/cabines/${c.corps.cabine.id}`, ADMIN, { campagne_id: a.campagneId })).status, 200);
  const l = await api("GET", "/api/admin/cabines", ADMIN);
  assert.equal(l.corps.cabines[0].campagne_id, a.campagneId);
});

test("le mode dev est refusé hors machine locale et en production", async () => {
  const { env } = creerEnv();
  const viaInternet = await traiter(new Request("https://voxbox-test.whyme.workers.dev/api/moi", { headers: { "x-dev-email": ADMIN } }), env);
  assert.equal(viaInternet.status, 500);
  const { env: prod } = creerEnv({ ENVIRONNEMENT: "production" });
  const enProd = await traiter(new Request("http://localhost/api/moi", { headers: { "x-dev-email": ADMIN } }), prod);
  assert.equal(enProd.status, 500);
});

test("en mode Access, l'en-tête de dev est ignoré", async () => {
  const { env } = creerEnv({ AUTH_MODE: "access", ENVIRONNEMENT: "test", ACCESS_TEAM_DOMAIN: "https://whyme.cloudflareaccess.com", ACCESS_AUD: "aud" });
  const r = await traiter(new Request("https://voxbox-test.whyme.workers.dev/api/moi", { headers: { "x-dev-email": ADMIN } }), env);
  assert.equal(r.status, 401);
});

test("en mode Access non configuré, l'API protégée répond 503 et pas 200", async () => {
  const { env } = creerEnv({ AUTH_MODE: "access", ENVIRONNEMENT: "test" });
  const r = await traiter(new Request("https://voxbox-test.whyme.workers.dev/api/moi"), env);
  assert.equal(r.status, 503);
});

test("route inconnue : 404 ; mauvaise méthode : 405", async () => {
  const { env } = creerEnv();
  const api = client(env);
  assert.equal((await api("GET", "/api/rien", ADMIN)).status, 404);
  assert.equal((await api("DELETE", "/api/admin/clients", ADMIN)).status, 405);
});
