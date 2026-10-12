// Option Analyse, lot 1 : transcription des réponses (décisions du 11/10/2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../src/index.ts";
import type { Env } from "../src/types.ts";
import { ADMIN, client, creerEnv } from "./aide/env.ts";
import { reprendreTranscriptions, transcrireReponse } from "../src/analyse/transcription.ts";
import { lireReponse, termesContexte, type Fetch } from "../src/analyse/mistral.ts";
import { MENTION_ANALYSE } from "../src/rgpd/consentement.ts";

const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));

/** Faux service Mistral : note chaque appel et répond ce qu'on lui dit. */
function fauxMistral(reponse: () => Response = () => Response.json({
  text: "On n'entend rien, même sur le boulevard.",
  language: "fr",
  segments: [{ text: "On n'entend rien,", start: 0.4, end: 1.6 }, { text: "même sur le boulevard.", start: 1.7, end: 3.1 }],
})) {
  const appels: { url: string; champs: [string, string][]; auth: string | null }[] = [];
  const f: Fetch = async (input, init) => {
    const form = init?.body as FormData;
    appels.push({
      url: String(input),
      champs: [...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `fichier:${(v as File).name}`]),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return reponse();
  };
  return { f, appels };
}

/**
 * Une marque, une campagne (avec ou sans option), une cabine et une tablette appairée.
 * « reception » : la transcription part dès l'envoi de la vidéo (comme en ligne) ; sinon on la lance à la main.
 */
async function campagne(opts: { option: boolean; env?: Partial<Env>; vocabulaire?: string[]; reception?: boolean }) {
  const { env, db } = creerEnv(opts.env);
  const api = client(env);
  const marque = async (nom: string) => {
    const cl = await api("POST", "/api/admin/clients", ADMIN, { nom, raison_sociale: `${nom} SAS`, contact_rgpd: `rgpd@${nom.toLowerCase()}.test` });
    await api("POST", "/api/admin/utilisateurs", ADMIN, { email: `lit@${nom.toLowerCase()}.test`, role: "lecteur_client", client_id: cl.corps.client.id });
    return cl.corps.client.id as string;
  };
  const alpha = await marque("Alpha");
  await marque("Beta");
  const cid = (await api("POST", "/api/admin/campagnes", ADMIN, { client_id: alpha, nom: "Essai" })).corps.campagne.id as string;
  if (opts.option || opts.vocabulaire) {
    const p = await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { option_analyse: opts.option, vocabulaire: opts.vocabulaire ?? [] });
    assert.equal(p.status, 200, JSON.stringify(p.corps));
  }
  await api("POST", `/api/admin/campagnes/${cid}/parcours`, ADMIN, { config: demo });
  const cons = await api("POST", `/api/admin/campagnes/${cid}/consentement`, ADMIN, {});
  assert.equal(cons.status, 201, JSON.stringify(cons.corps));
  assert.equal((await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "validee" })).status, 200);
  assert.equal((await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "active" })).status, 200);
  const cab = await api("POST", "/api/admin/cabines", ADMIN, { nom: "Cabine 1" });
  await api("PATCH", `/api/admin/cabines/${cab.corps.cabine.id}`, ADMIN, { campagne_id: cid });
  const jeton = (await api("POST", "/api/cabine/appairer", undefined, { code: cab.corps.cabine.code_appairage })).corps.jeton as string;
  const enAttente: Promise<unknown>[] = [];
  const execution = { waitUntil: (p: Promise<unknown>) => { enAttente.push(p); } };
  const tablette = async (methode: string, chemin: string, corps: unknown, entetes: Record<string, string> = {}) => {
    const json = !(corps instanceof Uint8Array);
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode,
      headers: { authorization: `Bearer ${jeton}`, ...(json ? { "content-type": "application/json" } : {}), ...entetes },
      body: json ? JSON.stringify(corps) : (corps as unknown as BodyInit),
    }), env, opts.reception ? execution : undefined);
    return { status: res.status, corps: (await res.json()) as any };
  };
  const conf = (await traiter(new Request("http://localhost/api/cabine/config", { headers: { authorization: `Bearer ${jeton}` } }), env).then((r) => r.json())) as any;
  const visiteur = async (son = "1") => {
    const sid = crypto.randomUUID();
    const s = await tablette("POST", "/api/cabine/sessions", {
      id: sid, prenom: "Camille", consent_interne: true,
      parcours_version_id: conf.campagne.parcours_version_id, consentement_version_id: conf.consentement.id,
    });
    assert.equal(s.status, 201, JSON.stringify(s.corps));
    const put = await tablette("PUT", `/api/cabine/sessions/${sid}/reponses/q-coup-de-coeur`, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]),
      { "content-type": "video/webm", "x-duree-ms": "9000", "x-son-present": son });
    assert.equal(put.status, 201, JSON.stringify(put.corps));
    const rep = await db.prepare("SELECT id, transcription_etat FROM reponses WHERE session_id = ?").bind(sid).first<{ id: string; transcription_etat: string | null }>();
    return { sid, rid: rep!.id, etat: rep!.transcription_etat, put: put.corps };
  };
  return { env, db, api, cid, conf, tablette, visiteur, enAttente };
}

const etat = async (db: any, rid: string) =>
  db.prepare("SELECT transcription, transcription_etat AS etat, transcription_segments AS segments, transcription_essais AS essais, transcription_erreur AS erreur FROM reponses WHERE id = ?").bind(rid).first();

test("sans l'option, rien n'est mis à transcrire et rien n'est envoyé, même avec une clé", async () => {
  const { env, conf, visiteur } = await campagne({ option: false, env: { MISTRAL_API_KEY: "cle-test" } });
  assert.ok(!conf.consentement.texte_interne.includes("transcrites"));
  const v = await visiteur();
  assert.equal(v.etat, null);
  const faux = fauxMistral();
  await reprendreTranscriptions(env, { fetch: faux.f });
  assert.equal(faux.appels.length, 0);
});

test("avec l'option : textes qui l'annoncent, réponse transcrite, horodatée et journalisée", async () => {
  const { env, db, api, conf, visiteur } = await campagne({ option: true, env: { MISTRAL_API_KEY: "cle-test" }, vocabulaire: ["Geely EX5", "Geely EX5 ", "Zeekr"] });
  assert.ok(conf.consentement.texte_interne.includes(MENTION_ANALYSE.trim()));
  const v = await visiteur();
  assert.equal(v.etat, "a_faire");
  assert.equal(v.put.reponse.transcription, "a_faire");

  const faux = fauxMistral();
  assert.equal(await transcrireReponse(env, v.rid, { fetch: faux.f }), "faite");
  assert.equal(faux.appels.length, 1);
  const appel = faux.appels[0]!;
  assert.equal(appel.url, "https://api.mistral.ai/v1/audio/transcriptions");
  assert.equal(appel.auth, "Bearer cle-test");
  // Mots isolés seulement (le service refuse espaces et virgules) : les expressions sont découpées.
  assert.deepEqual(appel.champs.filter(([k]) => k === "context_bias").map(([, x]) => x), ["Geely", "EX5", "Zeekr"]);
  assert.ok(appel.champs.some(([k, x]) => k === "file" && x === "fichier:reponse.webm"));
  assert.ok(!appel.champs.some(([k]) => k === "language"), "la langue n'est pas imposée avec l'horodatage");

  const e = await etat(db, v.rid);
  assert.equal(e.etat, "faite");
  assert.equal(e.transcription, "On n'entend rien, même sur le boulevard.");
  assert.deepEqual(JSON.parse(e.segments), [{ d: 0.4, f: 1.6, t: "On n'entend rien," }, { d: 1.7, f: 3.1, t: "même sur le boulevard." }]);
  const j = await db.prepare("SELECT utilisateur_email FROM journal WHERE action = 'reponse.transcription' AND cible_id = ?").bind(v.rid).first();
  assert.equal(j.utilisateur_email, "systeme:transcription");

  // Un deuxième passage ne renvoie rien (déjà faite).
  assert.equal(await transcrireReponse(env, v.rid, { fetch: faux.f }), "ignoree");
  assert.equal(faux.appels.length, 1);

  // Lecture : le client propriétaire la lit (journalisé), l'autre marque ne la voit pas.
  const lue = await api("GET", `/api/espace/reponses/${v.rid}/transcription`, "lit@alpha.test");
  assert.equal(lue.status, 200, JSON.stringify(lue.corps));
  assert.equal(lue.corps.transcription.segments.length, 2);
  assert.ok(await db.prepare("SELECT 1 FROM journal WHERE action = 'reponse.transcription_lecture' AND utilisateur_email = 'lit@alpha.test'").first());
  assert.equal((await api("GET", `/api/espace/reponses/${v.rid}/transcription`, "lit@beta.test")).status, 404);

  // La liste des sessions donne l'état, jamais le texte (sa lecture est journalisée à part).
  const liste = await api("GET", `/api/espace/campagnes/${(await db.prepare("SELECT campagne_id FROM sessions WHERE id = ?").bind(v.sid).first()).campagne_id}/sessions`, ADMIN);
  const r = liste.corps.sessions[0].reponses[0];
  assert.equal(r.transcription_etat, "faite");
  assert.equal(r.transcription, undefined);
});

test("la réception lance la transcription après la réponse à la tablette", async () => {
  const { env, db, visiteur, enAttente } = await campagne({ option: true, env: { MISTRAL_API_KEY: "cle-test" }, reception: true });
  const vrai = globalThis.fetch;
  const faux = fauxMistral();
  globalThis.fetch = faux.f as typeof fetch;
  try {
    const v = await visiteur();
    await Promise.all(enAttente);
    assert.equal(faux.appels.length, 1);
    assert.equal((await etat(db, v.rid)).etat, "faite");
  } finally {
    globalThis.fetch = vrai;
  }
  void env;
});

test("sans clé d'API, rien ne part : la réponse reste « à faire » et la reprise la traite une fois la clé posée", async () => {
  const { env, db, visiteur } = await campagne({ option: true });
  const v = await visiteur();
  const faux = fauxMistral();
  assert.equal(await transcrireReponse(env, v.rid, { fetch: faux.f }), "sans_cle");
  assert.equal((await etat(db, v.rid)).etat, "a_faire");
  env.MISTRAL_API_KEY = "cle-posee";
  const bilan = await reprendreTranscriptions(env, { fetch: faux.f });
  assert.equal(bilan.faite, 1);
  assert.equal(faux.appels.length, 1);
});

test("pas de son détecté par la tablette : pas de transcription", async () => {
  const { visiteur } = await campagne({ option: true, env: { MISTRAL_API_KEY: "cle-test" } });
  assert.equal((await visiteur("0")).etat, null);
});

test("erreurs : nouvel essai si le service est indisponible, abandon après 3 essais ou si la requête est refusée", async () => {
  const { env, db, visiteur } = await campagne({ option: true, env: { MISTRAL_API_KEY: "cle-test" } });
  const v = await visiteur();
  const panne = fauxMistral(() => new Response("indisponible", { status: 503 }));
  assert.equal(await transcrireReponse(env, v.rid, { fetch: panne.f }), "reessai");
  assert.equal((await etat(db, v.rid)).etat, "a_faire");
  assert.equal(await transcrireReponse(env, v.rid, { fetch: panne.f }), "reessai");
  assert.equal(await transcrireReponse(env, v.rid, { fetch: panne.f }), "echec");
  const e = await etat(db, v.rid);
  assert.equal(e.etat, "echec");
  assert.equal(e.essais, 3);
  assert.match(e.erreur, /503/);
  assert.ok(await db.prepare("SELECT 1 FROM journal WHERE action = 'reponse.transcription_echec' AND cible_id = ?").bind(v.rid).first());

  const w = await visiteur();
  const refus = fauxMistral(() => new Response("format", { status: 400 }));
  assert.equal(await transcrireReponse(env, w.rid, { fetch: refus.f }), "echec");
});

test("une transcription bloquée « en cours » est reprise par la tâche planifiée", async () => {
  const { env, db, visiteur } = await campagne({ option: true, env: { MISTRAL_API_KEY: "cle-test" } });
  const v = await visiteur();
  await db.prepare("UPDATE reponses SET transcription_etat = 'en_cours', transcription_le = ? WHERE id = ?").bind(new Date(Date.now() - 3600_000).toISOString(), v.rid).run();
  const faux = fauxMistral();
  assert.equal((await reprendreTranscriptions(env, { fetch: faux.f })).faite, 1);
});

test("un nouvel envoi de la vidéo efface l'ancienne transcription et la remet à faire", async () => {
  const { env, db, tablette, visiteur } = await campagne({ option: true, env: { MISTRAL_API_KEY: "cle-test" } });
  const v = await visiteur();
  await transcrireReponse(env, v.rid, { fetch: fauxMistral().f });
  await tablette("PUT", `/api/cabine/sessions/${v.sid}/reponses/q-coup-de-coeur`, new Uint8Array([9, 9, 9]), { "content-type": "video/webm", "x-son-present": "1" });
  const e = await etat(db, v.rid);
  assert.equal(e.etat, "a_faire");
  assert.equal(e.transcription, null);
  assert.equal(e.essais, 0);
});

test("retrait d'accord : la transcription disparaît avec la réponse, et rien n'est envoyé après", async () => {
  const { env, db, api, visiteur } = await campagne({ option: true, env: { MISTRAL_API_KEY: "cle-test" } });
  const v = await visiteur();
  await transcrireReponse(env, v.rid, { fetch: fauxMistral().f });
  const w = await visiteur();
  assert.equal((await api("POST", `/api/espace/sessions/${v.sid}/retrait`, ADMIN, {})).status, 200);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM reponses WHERE session_id = ?").bind(v.sid).first().then((x: any) => x.n), 0);
  assert.notEqual((await api("GET", `/api/espace/reponses/${v.rid}/transcription`, ADMIN)).status, 200);
  // Retrait pendant que la réponse attend : elle n'est jamais envoyée.
  await api("POST", `/api/espace/sessions/${w.sid}/retrait`, ADMIN, {});
  const faux = fauxMistral();
  await reprendreTranscriptions(env, { fetch: faux.f });
  assert.equal(faux.appels.length, 0);
});

test("option : se règle avant l'activation seulement, et les textes rédigés à la main doivent l'annoncer", async () => {
  const { api, cid } = await campagne({ option: true, env: { MISTRAL_API_KEY: "cle-test" } });
  const actif = await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { option_analyse: false });
  assert.equal(actif.status, 409);
  // Le vocabulaire, lui, peut changer en cours de campagne.
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { vocabulaire: ["EX5"] })).status, 200);
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { vocabulaire: Array.from({ length: 101 }, (_, i) => `t${i}`) })).status, 400);

  const { env } = creerEnv();
  const api2 = client(env);
  const cl = (await api2("POST", "/api/admin/clients", ADMIN, { nom: "Gamma", raison_sociale: "Gamma SAS", contact_rgpd: "rgpd@gamma.test" })).corps.client.id;
  const c2 = (await api2("POST", "/api/admin/campagnes", ADMIN, { client_id: cl, nom: "Brouillon" })).corps.campagne.id;
  await api2("POST", `/api/admin/campagnes/${c2}/parcours`, ADMIN, { config: demo });
  assert.equal((await api2("POST", `/api/admin/campagnes/${c2}/consentement`, ADMIN, {})).status, 201);
  // Activer l'option régénère les textes (nouvelle version, qui l'annonce).
  const p = await api2("PATCH", `/api/admin/campagnes/${c2}`, ADMIN, { option_analyse: true });
  assert.equal(p.status, 200, JSON.stringify(p.corps));
  const d = (await api2("GET", `/api/admin/campagnes/${c2}`, ADMIN)).corps.campagne;
  assert.equal(d.option_analyse, true);
  assert.equal(d.consentement.analyse, 1);
  assert.equal(d.consentement.numero, 2);
  // Un texte rédigé à la main qui ne parle pas d'analyse est refusé.
  const manuel = await api2("POST", `/api/admin/campagnes/${c2}/consentement`, ADMIN, { texte_interne: "Vous acceptez d'être filmé." });
  assert.equal(manuel.status, 400);
});

test("lecture tolérante de la réponse du service (mots ou segments)", () => {
  const mots = lireReponse({ text: " Bonjour à tous ", words: [{ word: "Bonjour", start: 0.12345, end: 0.5 }, { word: "à", start: 0.6, end: 0.7 }, { word: "", start: 1, end: 2 }] });
  assert.equal(mots.texte, "Bonjour à tous");
  assert.deepEqual(mots.segments, [{ d: 0.12, f: 0.5, t: "Bonjour" }, { d: 0.6, f: 0.7, t: "à" }]);
  const vide = lireReponse({ text: "" });
  assert.deepEqual(vide, { texte: "", langue: null, segments: [] });
  assert.throws(() => lireReponse(null));
});

test("vocabulaire : envoyé au service en mots isolés, sans espace ni virgule (refus 400 du 12/10/2026)", () => {
  assert.deepEqual(termesContexte(["Mondial de l'Auto", "PFA", "Fabrique de l'Innovation", "mondial", "Renault, Peugeot"]),
    ["Mondial", "l'Auto", "PFA", "Fabrique", "l'Innovation", "Renault", "Peugeot"]);
  assert.ok(termesContexte(Array.from({ length: 150 }, (_, i) => `terme${i}`)).length === 100);
  assert.ok(termesContexte(["Mondial de l'Auto"]).every((t) => !/[\s,]/u.test(t)));
});
