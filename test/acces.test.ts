import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { traiter } from "../src/index.ts";
import { boiteEssai } from "../src/courriel.ts";
import { DEMANDES_PAR_HEURE } from "../src/routes/acces.ts";
import { campagneAvecReponses } from "./aide/campagne.ts";

beforeEach(() => { boiteEssai.length = 0; });

/** Appel avec le jeton d'accès du visiteur dans l'en-tête x-acces. */
function avecJeton(env: any, jeton: string) {
  return async (methode: string, chemin: string, corps?: unknown) => {
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode,
      headers: { "x-acces": jeton, ...(corps ? { "content-type": "application/json" } : {}) },
      body: corps ? JSON.stringify(corps) : undefined,
    }), env);
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, corps: type.includes("json") ? await res.json() as any : await res.arrayBuffer() };
  };
}

const jetonDu = (texte: string) => /#acces=([\w-]+)/.exec(texte)?.[1] ?? "";

test("accès par e-mail : même réponse que l'adresse soit connue ou non ; lien envoyé seulement si elle l'est", async () => {
  const { api } = await campagneAvecReponses();
  const connue = await api("POST", "/api/acces/demande", undefined, { email: "  Camille@Exemple.fr " });
  const inconnue = await api("POST", "/api/acces/demande", undefined, { email: "personne@exemple.fr" });
  assert.equal(connue.status, 200);
  assert.deepEqual(connue.corps, inconnue.corps, "on ne révèle pas qui est passé dans la cabine");
  assert.equal(boiteEssai.length, 1);
  assert.equal(boiteEssai[0]!.a, "camille@exemple.fr");
  assert.match(boiteEssai[0]!.texte, /Bonjour Camille/);
  assert.ok(jetonDu(boiteEssai[0]!.texte).length >= 40);
  assert.equal((await api("POST", "/api/acces/demande", undefined, { email: "pas-une-adresse" })).status, 400);
});

test("accès par e-mail : au plus trois demandes par heure pour une adresse", async () => {
  const { api } = await campagneAvecReponses();
  for (let i = 0; i < DEMANDES_PAR_HEURE + 2; i++) assert.equal((await api("POST", "/api/acces/demande", undefined, { email: "camille@exemple.fr" })).status, 200);
  assert.equal(boiteEssai.length, DEMANDES_PAR_HEURE);
});

test("accès par e-mail : le visiteur voit ses passages et ses vidéos, pas ceux des autres", async () => {
  const { env, db, api, lea } = await campagneAvecReponses();
  await api("POST", "/api/acces/demande", undefined, { email: "camille@exemple.fr" });
  const appel = avecJeton(env, jetonDu(boiteEssai[0]!.texte));
  const moi = await appel("GET", "/api/acces/moi");
  assert.equal(moi.status, 200, JSON.stringify(moi.corps));
  assert.equal(moi.corps.passages.length, 1);
  const p = moi.corps.passages[0];
  assert.equal(p.prenom, "Camille");
  assert.equal(p.marque, "Alpha");
  assert.equal(p.diffusion, true);
  assert.deepEqual(p.reponses.map((r: any) => r.question), ["Le premier mot", "Le coup de cœur"], "titres courts des questions");
  const video = await appel("GET", `/api/acces/reponses/${p.reponses[0].id}/video`);
  assert.equal(video.status, 200);
  const j = await db.prepare("SELECT utilisateur_email FROM journal WHERE action = 'reponse.visionnage' ORDER BY quand DESC").first<any>();
  assert.equal(j.utilisateur_email, "visiteur (accès par e-mail)", "le visionnage est tracé");
  // Les réponses et la session d'une autre personne restent inaccessibles.
  const autre = await db.prepare("SELECT id FROM reponses WHERE session_id = ?").bind(lea).first<any>();
  assert.equal((await appel("GET", `/api/acces/reponses/${autre.id}/video`)).status, 404);
  assert.equal((await appel("POST", `/api/acces/sessions/${lea}`, { portee: "tout" })).status, 404);
});

test("accès par e-mail : sans jeton valable, rien ; un lien expiré est refusé", async () => {
  const { env, db, api } = await campagneAvecReponses();
  assert.equal((await api("GET", "/api/acces/moi")).status, 401);
  assert.equal((await avecJeton(env, "x".repeat(43))("GET", "/api/acces/moi")).status, 401);
  await api("POST", "/api/acces/demande", undefined, { email: "camille@exemple.fr" });
  await db.prepare("UPDATE acces_visiteur SET expire_le = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
  const r = await avecJeton(env, jetonDu(boiteEssai[0]!.texte))("GET", "/api/acces/moi");
  assert.equal(r.status, 401);
  assert.equal(r.corps.erreur ?? r.corps.code, "lien_expire");
  const ligne = await db.prepare("SELECT jeton_empreinte FROM acces_visiteur").first<any>();
  assert.ok(!boiteEssai[0]!.texte.includes(ligne.jeton_empreinte), "seule l'empreinte du jeton est gardée");
});

test("accès par e-mail : retrait de la diffusion, puis suppression ; le passage disparaît de la liste", async () => {
  const { env, db, media, api, camille } = await campagneAvecReponses();
  await api("POST", "/api/acces/demande", undefined, { email: "camille@exemple.fr" });
  const appel = avecJeton(env, jetonDu(boiteEssai[0]!.texte));
  assert.equal((await appel("POST", `/api/acces/sessions/${camille}`, { portee: "diffusion" })).status, 200);
  assert.equal((await appel("GET", "/api/acces/moi")).corps.passages[0].diffusion, false);
  const avant = media.objets.size;
  assert.equal((await appel("POST", `/api/acces/sessions/${camille}`, { portee: "tout" })).status, 200);
  assert.equal(media.objets.size, avant - 2, "les deux vidéos sont supprimées");
  assert.equal((await appel("GET", "/api/acces/moi")).corps.passages.length, 0);
  const s = await db.prepare("SELECT email, retiree_le FROM sessions WHERE id = ?").bind(camille).first<any>();
  assert.equal(s.email, null);
  assert.ok(s.retiree_le);
  const j = await db.prepare("SELECT utilisateur_email, details FROM journal WHERE action = 'session.retrait'").first<any>();
  assert.equal(j.utilisateur_email, "visiteur (accès par e-mail)");
});

test("accès par e-mail : hors développement et sans clé d'envoi, la demande échoue franchement", async () => {
  const { env, api } = await campagneAvecReponses();
  env.AUTH_MODE = "access";
  const r = await traiter(new Request("http://localhost/api/acces/demande", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "camille@exemple.fr" }) }), env);
  assert.equal(r.status, 503);
  void api;
});
