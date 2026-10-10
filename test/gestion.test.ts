import { test } from "node:test";
import assert from "node:assert/strict";
import { traiter } from "../src/index.ts";
import { ADMIN, client, creerEnv } from "./aide/env.ts";
import { campagneAvecReponses } from "./aide/campagne.ts";

const envoyer = (env: any, methode: string, chemin: string, qui: string, corps: BodyInit, type: string) =>
  traiter(new Request(`http://localhost${chemin}`, { method: methode, headers: { "x-dev-email": qui, "content-type": type }, body: corps }), env);

// ------------------------------------------------------------------ comptes

test("comptes : changement de rôle tracé, impossible sur son propre compte", async () => {
  const { env, db } = creerEnv();
  const api = client(env);
  const cl = (await api("POST", "/api/admin/clients", ADMIN, { nom: "Alpha", raison_sociale: "Alpha SAS", contact_rgpd: "rgpd@alpha.test" })).corps.client;
  const u = (await api("POST", "/api/admin/utilisateurs", ADMIN, { email: "fabrice@whyme.test", role: "admin_whyme" })).corps.utilisateur;
  const r = await api("PATCH", `/api/admin/utilisateurs/${u.id}`, ADMIN, { role: "operateur_whyme" });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal((await api("GET", "/api/moi", "fabrice@whyme.test")).corps.role, "operateur_whyme");
  assert.equal((await api("PATCH", `/api/admin/utilisateurs/${u.id}`, ADMIN, { role: "lecteur_client" })).status, 400, "client obligatoire");
  assert.equal((await api("PATCH", `/api/admin/utilisateurs/${u.id}`, ADMIN, { role: "lecteur_client", client_id: cl.id })).status, 200);
  assert.equal((await api("GET", "/api/moi", "fabrice@whyme.test")).corps.client.nom, "Alpha");
  const moi = (await api("POST", "/api/admin/utilisateurs", ADMIN, { email: "chef@whyme.test", role: "admin_whyme" })).corps.utilisateur;
  assert.equal((await api("PATCH", `/api/admin/utilisateurs/${moi.id}`, "chef@whyme.test", { role: "operateur_whyme" })).status, 409);
  const j = await db.prepare("SELECT COUNT(*) AS n FROM journal WHERE action = 'utilisateur.role'").first<any>();
  assert.equal(j.n, 2);
});

// ------------------------------------------------------------------ logo

test("logo : PNG accepté et servi publiquement, SVG refusé, 1 Mo au plus", async () => {
  const { env } = creerEnv();
  const api = client(env);
  const cl = (await api("POST", "/api/admin/clients", ADMIN, { nom: "Alpha", raison_sociale: "Alpha SAS", contact_rgpd: "rgpd@alpha.test" })).corps.client;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const r = await envoyer(env, "PUT", `/api/admin/clients/${cl.id}/logo`, ADMIN, png as unknown as BodyInit, "image/png");
  assert.equal(r.status, 200);
  const url = ((await r.json()) as any).client.logo_url as string;
  assert.match(url, new RegExp(`^/api/cabine/logo/${cl.id}\\.png\\?v=\\d+$`));
  const logo = await traiter(new Request(`http://localhost${url}`), env);
  assert.equal(logo.status, 200, "sans authentification : la cabine l'affiche");
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.equal(logo.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await logo.arrayBuffer()), png);
  assert.equal((await envoyer(env, "PUT", `/api/admin/clients/${cl.id}/logo`, ADMIN, "<svg/>", "image/svg+xml")).status, 415);
  assert.equal((await envoyer(env, "PUT", `/api/admin/clients/${cl.id}/logo`, ADMIN, new Uint8Array(1024 * 1024 + 1) as unknown as BodyInit, "image/png")).status, 413);
  assert.equal((await traiter(new Request(`http://localhost/api/cabine/logo/${cl.id}.jpg`), env)).status, 404, "pas d'autre fichier servi");
  assert.equal((await envoyer(env, "PUT", `/api/admin/clients/${cl.id}/logo`, "lit@nimporte.test", png as unknown as BodyInit, "image/png")).status, 403);
});

// ------------------------------------------------------------------ campagnes

test("campagne : nom et dates modifiables ; durée de conservation figée une fois active", async () => {
  const { api, cid } = await campagneAvecReponses();
  const r = await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { nom: "Salon de Lyon", debut: "2026-11-01", fin: "2026-11-30" });
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  const c = (await api("GET", `/api/admin/campagnes/${cid}`, ADMIN)).corps.campagne;
  assert.equal(c.nom, "Salon de Lyon");
  assert.equal(c.statut, "active", "le nom ne remet pas la campagne en brouillon");
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { conservation_jours: 30 })).status, 409);
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { debut: "2026-12-01", fin: "2026-11-01" })).status, 400);
});

test("campagne validée : changer la durée régénère les textes et remet en brouillon", async () => {
  const { env } = creerEnv();
  const api = client(env);
  const cl = (await api("POST", "/api/admin/clients", ADMIN, { nom: "Alpha", raison_sociale: "Alpha SAS", contact_rgpd: "rgpd@alpha.test" })).corps.client;
  const cid = (await api("POST", "/api/admin/campagnes", ADMIN, { client_id: cl.id, nom: "Essai", conservation_jours: 365 })).corps.campagne.id;
  const { readFileSync } = await import("node:fs");
  const demo = JSON.parse(readFileSync(new URL("../fixtures/parcours-demo.json", import.meta.url), "utf8"));
  await api("POST", `/api/admin/campagnes/${cid}/parcours`, ADMIN, { config: demo });
  await api("POST", `/api/admin/campagnes/${cid}/consentement`, ADMIN, {});
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "validee" });
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { conservation_jours: 90 })).status, 200);
  const c = (await api("GET", `/api/admin/campagnes/${cid}`, ADMIN)).corps.campagne;
  assert.equal(c.statut, "brouillon");
  assert.equal(c.consentement.numero, 2);
  assert.match(c.consentement.texte_interne, /3 mois/);
});

test("campagne : seul un brouillon sans visiteur se supprime, ses cabines sont libérées", async () => {
  const { env, db } = creerEnv();
  const api = client(env);
  const cl = (await api("POST", "/api/admin/clients", ADMIN, { nom: "Alpha", raison_sociale: "Alpha SAS", contact_rgpd: "rgpd@alpha.test" })).corps.client;
  const cid = (await api("POST", "/api/admin/campagnes", ADMIN, { client_id: cl.id, nom: "Brouillon" })).corps.campagne.id;
  const cab = (await api("POST", "/api/admin/cabines", ADMIN, { nom: "Tablette" })).corps.cabine;
  await api("PATCH", `/api/admin/cabines/${cab.id}`, ADMIN, { campagne_id: cid });
  const r = await api("DELETE", `/api/admin/campagnes/${cid}`, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal((await db.prepare("SELECT campagne_id FROM cabines WHERE id = ?").bind(cab.id).first<any>()).campagne_id, null);
  assert.equal((await api("GET", `/api/admin/campagnes/${cid}`, ADMIN)).status, 404);
  const active = await campagneAvecReponses();
  assert.equal((await active.api("DELETE", `/api/admin/campagnes/${active.cid}`, ADMIN)).status, 409);
});

test("éditeur : vérification d'un parcours sans l'enregistrer", async () => {
  const { env } = creerEnv();
  const api = client(env);
  const r = await api("POST", "/api/admin/parcours/valider", ADMIN, { config: { version: 1, langue: "fr", etapes: [] } });
  assert.equal(r.status, 200);
  assert.ok(r.corps.problemes.length > 0);
  assert.equal((await api("POST", "/api/admin/parcours/valider", "lit@nimporte.test", { config: {} })).status, 403);
});

// ------------------------------------------------------------------ visiteurs

test("visiteur : retrait d'accord, vidéos et Parlomix supprimés, trace anonyme conservée", async () => {
  const { env, db, media, api, cid, camille, lea, reponse } = await campagneAvecReponses();
  const p = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "question", etape_id: "q-premier-mot", format: "16:9", titre: "Le premier mot",
    plan: { version: 1, sessions: [camille, lea], sequences: [camille, lea].map((s) => ({ type: "clip", reponseId: reponse(s, "q-premier-mot"), sessionId: s, segments: [[0, 1]] })) },
  });
  await envoyer(env, "PUT", `/api/espace/parlomix/${p.corps.parlomix.id}/fichier`, ADMIN, new Uint8Array([1]) as unknown as BodyInit, "video/mp4");
  const avant = media.objets.size;
  assert.equal((await api("POST", `/api/espace/sessions/${camille}/retrait`, "lit@alpha.test", {})).status, 403, "un lecteur ne peut pas");
  assert.equal((await api("POST", `/api/espace/sessions/${camille}/retrait`, "valide@beta.test", {})).status, 404, "un autre client non plus");
  const r = await api("POST", `/api/espace/sessions/${camille}/retrait`, "valide@alpha.test", {});
  assert.equal(r.status, 200, JSON.stringify(r.corps));
  assert.equal(r.corps.session.videos_supprimees, 2);
  assert.equal(r.corps.session.parlomix_supprimes, 1);
  assert.equal(media.objets.size, avant - 3, "2 vidéos + 1 Parlomix supprimés du stockage");
  const s = await db.prepare("SELECT prenom, email, recontact, retiree_le FROM sessions WHERE id = ?").bind(camille).first<any>();
  assert.equal(s.prenom, "(retiré)");
  assert.equal(s.email, null);
  assert.ok(s.retiree_le);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM reponses WHERE session_id = ?").bind(camille).first<any>()).n, 0);
  assert.equal((await api("POST", `/api/espace/sessions/${camille}/retrait`, ADMIN, {})).status, 409, "déjà retiré");
  const j = await db.prepare("SELECT details FROM journal WHERE action = 'session.retrait'").first<any>();
  assert.ok(!j.details.includes("Camille"), "le journal ne garde pas le prénom");
});

test("visiteur : retrait du seul accord de diffusion, ses Parlomix ne sont plus diffusables", async () => {
  const { env, db, api, cid, camille, hugo, reponse } = await campagneAvecReponses();
  const p = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "question", etape_id: "q-premier-mot", format: "16:9", titre: "x",
    plan: { version: 1, sessions: [camille, hugo], sequences: [camille, hugo].map((s) => ({ type: "clip", reponseId: reponse(s, "q-premier-mot"), sessionId: s, segments: [[0, 1]] })) },
  });
  assert.equal(p.corps.parlomix.diffusable, true);
  await envoyer(env, "PUT", `/api/espace/parlomix/${p.corps.parlomix.id}/fichier`, ADMIN, new Uint8Array([1]) as unknown as BodyInit, "video/mp4");
  assert.equal((await api("POST", `/api/espace/sessions/${hugo}/diffusion-retiree`, ADMIN, {})).status, 200);
  assert.equal((await db.prepare("SELECT consent_diffusion FROM sessions WHERE id = ?").bind(hugo).first<any>()).consent_diffusion, 0);
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/parlomix`, ADMIN)).corps.parlomix[0].diffusable, false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM reponses WHERE session_id = ?").bind(hugo).first<any>()).n, 2, "les réponses restent");
});

test("export : CSV pour tableur, e-mail seulement si recontact accepté, export journalisé", async () => {
  const { env, db, cid } = await campagneAvecReponses();
  const res = await traiter(new Request(`http://localhost/api/espace/campagnes/${cid}/export.csv`, { headers: { "x-dev-email": "lit@alpha.test" } }), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/csv/);
  const octets = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...octets.slice(0, 3)], [0xef, 0xbb, 0xbf], "BOM pour Excel");
  const texte = new TextDecoder().decode(octets);
  const lignes = texte.trim().split("\r\n");
  assert.equal(lignes.length, 4, "en-tête + 3 visiteurs");
  assert.match(lignes[1]!, /Camille;;camille@exemple\.fr;oui;oui;Cabine A;2;/);
  assert.match(lignes[2]!, /Léa;;;non;non;Cabine B;2;/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM journal WHERE action = 'campagne.export'").first<any>()).n, 1);
  const autre = await traiter(new Request(`http://localhost/api/espace/campagnes/${cid}/export.csv`, { headers: { "x-dev-email": "lit@beta.test" } }), env);
  assert.equal(autre.status, 404);
});

// ------------------------------------------------------------------ Parlomix

test("Parlomix : supprimé par son auteur ou par WhyMe, pas par un autre compte du client", async () => {
  const { env, media, api, cid, camille, reponse } = await campagneAvecReponses();
  const creer = async (qui: string) => {
    const p = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, qui, {
      type: "personne", session_id: camille, format: "16:9", titre: "Camille",
      plan: { version: 1, sessions: [camille], sequences: [{ type: "clip", reponseId: reponse(camille, "q-premier-mot"), sessionId: camille, segments: [[0, 1]] }] },
    });
    await envoyer(env, "PUT", `/api/espace/parlomix/${p.corps.parlomix.id}/fichier`, qui, new Uint8Array([1]) as unknown as BodyInit, "video/mp4");
    return p.corps.parlomix.id as string;
  };
  const p1 = await creer("lit@alpha.test");
  assert.equal((await api("DELETE", `/api/espace/parlomix/${p1}`, "valide@alpha.test")).status, 403);
  assert.equal((await api("DELETE", `/api/espace/parlomix/${p1}`, "lit@beta.test")).status, 404);
  const avant = media.objets.size;
  assert.equal((await api("DELETE", `/api/espace/parlomix/${p1}`, "lit@alpha.test")).status, 200);
  assert.equal(media.objets.size, avant - 1);
  const p2 = await creer("lit@alpha.test");
  assert.equal((await api("DELETE", `/api/espace/parlomix/${p2}`, ADMIN)).status, 200);
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/parlomix`, ADMIN)).corps.parlomix.length, 0);
});
