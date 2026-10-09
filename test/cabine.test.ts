import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../src/index.ts";
import { ADMIN, client, creerEnv } from "./aide/env.ts";

const parcoursAuto = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-automobile.json"), "utf8"));

/** Une marque, une campagne active, une cabine appairée. */
async function cabinePrete(parcours = parcoursAuto, activer = true) {
  const { env, db, media } = creerEnv();
  const api = client(env);
  const cl = await api("POST", "/api/admin/clients", ADMIN, { nom: "Auto", raison_sociale: "Auto SAS", contact_rgpd: "rgpd@auto.test" });
  const cp = await api("POST", "/api/admin/campagnes", ADMIN, { client_id: cl.corps.client.id, nom: "Essai" });
  const cid = cp.corps.campagne.id;
  assert.equal((await api("POST", `/api/admin/campagnes/${cid}/parcours`, ADMIN, { config: parcours })).status, 201);
  await api("POST", `/api/admin/campagnes/${cid}/consentement`, ADMIN, {});
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "validee" });
  if (activer) await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "active" });
  const cab = await api("POST", "/api/admin/cabines", ADMIN, { nom: "Cabine 1" });
  await api("PATCH", `/api/admin/cabines/${cab.corps.cabine.id}`, ADMIN, { campagne_id: cid });
  const app = await api("POST", "/api/cabine/appairer", undefined, { code: cab.corps.cabine.code_appairage.toLowerCase() });
  assert.equal(app.status, 201, JSON.stringify(app.corps));
  const jeton = app.corps.jeton as string;

  const tablette = async (methode: string, chemin: string, corps?: unknown, entetes: Record<string, string> = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${jeton}`, ...entetes };
    let body: BodyInit | undefined;
    if (corps instanceof Uint8Array) body = corps as unknown as BodyInit;
    else if (corps !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(corps); }
    const res = await traiter(new Request(`http://localhost${chemin}`, { method: methode, headers, body }), env);
    return { status: res.status, corps: (await res.json()) as any };
  };
  return { env, db, media, api, tablette, cabineId: cab.corps.cabine.id as string, campagneId: cid as string, code: cab.corps.cabine.code_appairage as string };
}

async function demarrer(t: Awaited<ReturnType<typeof cabinePrete>>["tablette"], surcharges: Record<string, unknown> = {}) {
  const conf = await t("GET", "/api/cabine/config");
  return t("POST", "/api/cabine/sessions", {
    parcours_version_id: conf.corps.campagne.parcours_version_id,
    consentement_version_id: conf.corps.consentement.id,
    prenom: "Camille",
    consent_interne: true,
    ...surcharges,
  });
}

test("appairage : le code ne sert qu'une fois", async () => {
  const { api, code } = await cabinePrete();
  const r = await api("POST", "/api/cabine/appairer", undefined, { code });
  assert.equal(r.status, 404);
});

test("sans jeton, la tablette n'a aucun accès", async () => {
  const { env } = await cabinePrete();
  const r = await traiter(new Request("http://localhost/api/cabine/config"), env);
  assert.equal(r.status, 401);
  const faux = await traiter(new Request("http://localhost/api/cabine/config", { headers: { authorization: `Bearer ${"x".repeat(43)}` } }), env);
  assert.equal(faux.status, 401);
});

test("configuration : parcours, habillage et textes de la campagne active", async () => {
  const { tablette } = await cabinePrete();
  const r = await tablette("GET", "/api/cabine/config");
  assert.equal(r.status, 200);
  assert.equal(r.corps.client.nom, "Auto");
  assert.equal(r.corps.parcours.etapes.length, parcoursAuto.etapes.length);
  assert.match(r.corps.consentement.texte_interne, /Auto SAS/);
  assert.ok(r.corps.consentement.texte_diffusion, "le parcours automobile propose la diffusion");
});

test("une campagne non active n'est pas jouée", async () => {
  const { tablette } = await cabinePrete(parcoursAuto, false);
  const r = await tablette("GET", "/api/cabine/config");
  assert.equal(r.corps.campagne, null);
  assert.equal((await tablette("POST", "/api/cabine/sessions", { prenom: "A", consent_interne: true })).status, 409);
});

test("session : accord interne obligatoire, recontact seulement avec e-mail", async () => {
  const { tablette, db } = await cabinePrete();
  assert.equal((await demarrer(tablette, { consent_interne: false })).status, 400);
  const s = await demarrer(tablette, { recontact: true });
  assert.equal(s.status, 201, JSON.stringify(s.corps));
  const ligne = await db.prepare("SELECT recontact, consent_diffusion, purge_prevue_le, cree_le FROM sessions WHERE id = ?").bind(s.corps.session.id).first<any>();
  assert.equal(ligne.recontact, 0);
  assert.equal(ligne.consent_diffusion, 0);
  const jours = (Date.parse(ligne.purge_prevue_le) - Date.parse(ligne.cree_le)) / 86_400_000;
  assert.equal(Math.round(jours), 365);
  const avecEmail = await demarrer(tablette, { email: "Camille@Exemple.fr", recontact: true, consent_diffusion: true });
  const l2 = await db.prepare("SELECT email, recontact, consent_diffusion FROM sessions WHERE id = ?").bind(avecEmail.corps.session.id).first<any>();
  assert.deepEqual({ ...l2 }, { email: "camille@exemple.fr", recontact: 1, consent_diffusion: 1 });
});

test("sans option diffusion, aucun consentement de diffusion n'est accepté", async () => {
  const sansDiffusion = structuredClone(parcoursAuto);
  for (const e of sansDiffusion.etapes) if (e.type === "consentement") delete e.proposerDiffusion;
  const { tablette } = await cabinePrete(sansDiffusion);
  const conf = await tablette("GET", "/api/cabine/config");
  assert.equal(conf.corps.consentement.texte_diffusion, null);
  assert.equal((await demarrer(tablette, { consent_diffusion: true })).status, 400);
  assert.equal((await demarrer(tablette, { consent_diffusion: false })).status, 201);
});

test("une tablette avec une version périmée doit recharger", async () => {
  const { tablette } = await cabinePrete();
  const r = await demarrer(tablette, { parcours_version_id: "ancienne" });
  assert.equal(r.status, 409);
  assert.equal(r.corps.erreur, "version_perimee");
});

test("réponse vidéo : stockée dans le stockage de la campagne, renvoi idempotent", async () => {
  const { tablette, media, db, campagneId } = await cabinePrete();
  const s = await demarrer(tablette);
  const sid = s.corps.session.id;
  const video = new Uint8Array(2048).fill(7);
  const envoi = () => tablette("PUT", `/api/cabine/sessions/${sid}/reponses/q-attentes`, video, {
    "content-type": "video/webm;codecs=vp8,opus", "x-duree-ms": "12000", "x-son-present": "1",
  });
  assert.equal((await envoi()).status, 201);
  assert.equal((await envoi()).status, 201);
  const cle = `campagnes/${campagneId}/sessions/${sid}/q-attentes.webm`;
  assert.equal(media.objets.get(cle)?.taille, 2048);
  const lignes = await db.prepare("SELECT statut, son_present, duree_ms FROM reponses WHERE session_id = ?").bind(sid).all<any>();
  assert.equal(lignes.results.length, 1);
  assert.deepEqual({ ...lignes.results[0] }, { statut: "recue", son_present: 1, duree_ms: 12000 });
});

test("réponse vidéo : étape inconnue, format ou cabine incorrects refusés", async () => {
  const a = await cabinePrete();
  const s = await demarrer(a.tablette);
  const sid = s.corps.session.id;
  const video = new Uint8Array(10);
  assert.equal((await a.tablette("PUT", `/api/cabine/sessions/${sid}/reponses/accueil`, video, { "content-type": "video/webm" })).status, 400);
  assert.equal((await a.tablette("PUT", `/api/cabine/sessions/${sid}/reponses/q-attentes`, video, { "content-type": "image/png" })).status, 415);
  // Une autre cabine ne peut pas écrire dans cette session.
  const b = await cabinePrete();
  assert.equal((await b.tablette("PUT", `/api/cabine/sessions/${sid}/reponses/q-attentes`, video, { "content-type": "video/webm" })).status, 404);
});

test("nouveau code : l'ancienne tablette est déconnectée", async () => {
  const { api, tablette, cabineId } = await cabinePrete();
  assert.equal((await api("POST", `/api/admin/cabines/${cabineId}/code`, ADMIN)).status, 200);
  assert.equal((await tablette("GET", "/api/cabine/config")).status, 401);
});

test("signal de vie enregistré", async () => {
  const { tablette, db, cabineId } = await cabinePrete();
  assert.equal((await tablette("POST", "/api/cabine/signal", { reseau: "wifi", batterie: 0.83, file: 2, micro: true })).status, 200);
  const c = await db.prepare("SELECT dernier_signal FROM cabines WHERE id = ?").bind(cabineId).first<{ dernier_signal: string }>();
  assert.equal(JSON.parse(c!.dernier_signal).batterie, 83);
});
