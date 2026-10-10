import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../src/index.ts";
import { ADMIN, client, creerEnv } from "./aide/env.ts";

const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));

/** Deux marques ; la première a une campagne active, deux cabines et trois visiteurs qui ont répondu. */
async function campagneAvecReponses() {
  const { env, db, media } = creerEnv();
  const api = client(env);
  const marque = async (nom: string) => {
    const cl = await api("POST", "/api/admin/clients", ADMIN, { nom, raison_sociale: `${nom} SAS`, contact_rgpd: `rgpd@${nom.toLowerCase()}.test`, couleurs: { principale: "#0F6E5A" } });
    await api("POST", "/api/admin/utilisateurs", ADMIN, { email: `lit@${nom.toLowerCase()}.test`, role: "lecteur_client", client_id: cl.corps.client.id });
    return cl.corps.client.id as string;
  };
  const alpha = await marque("Alpha");
  await marque("Beta");
  const cid = (await api("POST", "/api/admin/campagnes", ADMIN, { client_id: alpha, nom: "Démo" })).corps.campagne.id as string;
  await api("POST", `/api/admin/campagnes/${cid}/parcours`, ADMIN, { config: demo });
  await api("POST", `/api/admin/campagnes/${cid}/consentement`, ADMIN, {});
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "validee" });
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "active" });

  const tablettes: Record<string, { jeton: string; id: string }> = {};
  for (const nom of ["A", "B"]) {
    const cab = await api("POST", "/api/admin/cabines", ADMIN, { nom: `Cabine ${nom}` });
    await api("PATCH", `/api/admin/cabines/${cab.corps.cabine.id}`, ADMIN, { campagne_id: cid });
    tablettes[nom] = { jeton: (await api("POST", "/api/cabine/appairer", undefined, { code: cab.corps.cabine.code_appairage })).corps.jeton, id: cab.corps.cabine.id };
  }
  const tablette = async (cab: string, methode: string, chemin: string, corps: unknown, entetes: Record<string, string> = {}) => {
    const json = !(corps instanceof Uint8Array);
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode,
      headers: { authorization: `Bearer ${tablettes[cab]!.jeton}`, ...(json ? { "content-type": "application/json" } : {}), ...entetes },
      body: json ? JSON.stringify(corps) : (corps as unknown as BodyInit),
    }), env);
    return { status: res.status, corps: (await res.json()) as any };
  };
  const conf = (await traiter(new Request("http://localhost/api/cabine/config", { headers: { authorization: `Bearer ${tablettes.A!.jeton}` } }), env).then((r) => r.json())) as any;
  const visiteur = async (cab: string, prenom: string, diffusion: boolean) => {
    const sid = crypto.randomUUID();
    await tablette(cab, "POST", "/api/cabine/sessions", {
      id: sid, prenom, consent_interne: true, consent_diffusion: diffusion,
      parcours_version_id: conf.campagne.parcours_version_id, consentement_version_id: conf.consentement.id,
    });
    for (const q of ["q-premier-mot", "q-coup-de-coeur"]) {
      await tablette(cab, "PUT", `/api/cabine/sessions/${sid}/reponses/${q}`, new Uint8Array([1, 2, 3]), { "content-type": "video/webm", "x-duree-ms": "9000", "x-son-present": "1" });
    }
    return sid;
  };
  const camille = await visiteur("A", "Camille", true);
  const lea = await visiteur("B", "Léa", false);
  const hugo = await visiteur("A", "Hugo", true);
  const donnees = (await api("GET", `/api/espace/campagnes/${cid}/sessions`, ADMIN)).corps;
  const reponse = (sid: string, etape: string) => donnees.sessions.find((s: any) => s.id === sid).reponses.find((r: any) => r.etape_id === etape).id as string;
  return { env, db, media, api, cid, camille, lea, hugo, reponse, cabines: { A: tablettes.A!.id, B: tablettes.B!.id } };
}

/** Plan minimal tel que Parlorama l'envoie. */
const plan = (reponses: [string, string][]) => ({
  version: 1,
  sequences: [
    { type: "carte", role: "intro", dureeMs: 2200 },
    ...reponses.map(([reponseId, sessionId]) => ({ type: "clip", reponseId, sessionId, segments: [[0, 5000]], dureeMs: 5000 })),
    { type: "carte", role: "fin", dureeMs: 2000 },
  ],
  sessions: [...new Set(reponses.map(([, s]) => s))],
});

async function envoyerFilm(env: any, id: string, qui: string, octets = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])) {
  const res = await traiter(new Request(`http://localhost/api/espace/parlomix/${id}/fichier`, {
    method: "PUT", headers: { "x-dev-email": qui, "content-type": "video/mp4", "x-duree-ms": "21000" }, body: octets as unknown as BodyInit,
  }), env);
  return { status: res.status, corps: (await res.json()) as any };
}

test("Parlomix par personne : déclaré, film envoyé, listé et servi, avec trace dans le journal", async () => {
  const { env, db, api, cid, camille, reponse } = await campagneAvecReponses();
  const r = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, "lit@alpha.test", {
    type: "personne", session_id: camille, format: "9:16", titre: "Camille",
    plan: plan([[reponse(camille, "q-premier-mot"), camille], [reponse(camille, "q-coup-de-coeur"), camille]]),
  });
  assert.equal(r.status, 201, JSON.stringify(r.corps));
  assert.equal(r.corps.parlomix.diffusable, true);
  assert.equal((await envoyerFilm(env, r.corps.parlomix.id, "lit@alpha.test")).status, 200);
  const liste = await api("GET", `/api/espace/campagnes/${cid}/parlomix`, "lit@alpha.test");
  assert.equal(liste.corps.parlomix.length, 1);
  assert.equal(liste.corps.parlomix[0].disponible, true);
  assert.equal(liste.corps.parlomix[0].duree_ms, 21000);
  const video = await traiter(new Request(`http://localhost/api/espace/parlomix/${r.corps.parlomix.id}/video`, { headers: { "x-dev-email": "lit@alpha.test" } }), env);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get("content-type"), "video/mp4");
  const j = await db.prepare("SELECT action FROM journal WHERE action LIKE 'parlomix.%' ORDER BY quand").all<any>();
  assert.deepEqual(j.results.map((x: any) => x.action), ["parlomix.creation", "parlomix.visionnage"]);
});

test("Parlomix par question : une seule question, filtrable par cabine, diffusable seulement si tous ont accepté", async () => {
  const { api, cid, camille, lea, hugo, reponse, cabines } = await campagneAvecReponses();
  const tous = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "question", etape_id: "q-coup-de-coeur", format: "16:9", titre: "Le coup de cœur",
    plan: plan([camille, lea, hugo].map((s) => [reponse(s, "q-coup-de-coeur"), s])),
  });
  assert.equal(tous.status, 201, JSON.stringify(tous.corps));
  assert.equal(tous.corps.parlomix.diffusable, false, "Léa n'a pas accepté la diffusion");
  const cabineA = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "question", etape_id: "q-coup-de-coeur", cabine_id: cabines.A, format: "16:9", titre: "Cabine A",
    plan: plan([camille, hugo].map((s) => [reponse(s, "q-coup-de-coeur"), s])),
  });
  assert.equal(cabineA.status, 201);
  assert.equal(cabineA.corps.parlomix.diffusable, true);
  const melange = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "question", etape_id: "q-coup-de-coeur", format: "16:9", titre: "Mélange",
    plan: plan([[reponse(camille, "q-coup-de-coeur"), camille], [reponse(lea, "q-premier-mot"), lea]]),
  });
  assert.equal(melange.status, 400, "deux questions différentes");
  const mauvaiseCabine = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "question", etape_id: "q-coup-de-coeur", cabine_id: cabines.A, format: "16:9", titre: "Cabine A",
    plan: plan([[reponse(lea, "q-coup-de-coeur"), lea]]),
  });
  assert.equal(mauvaiseCabine.status, 400, "Léa est passée par la cabine B");
});

test("Parlomix : un autre client ne peut ni monter ni voir les réponses de la campagne", async () => {
  const { env, api, cid, camille, reponse } = await campagneAvecReponses();
  const r = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, "lit@beta.test", {
    type: "personne", session_id: camille, format: "16:9", titre: "x", plan: plan([[reponse(camille, "q-premier-mot"), camille]]),
  });
  assert.equal(r.status, 404);
  const ok = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "personne", session_id: camille, format: "16:9", titre: "x", plan: plan([[reponse(camille, "q-premier-mot"), camille]]),
  });
  await envoyerFilm(env, ok.corps.parlomix.id, ADMIN);
  assert.equal((await api("GET", `/api/espace/parlomix/${ok.corps.parlomix.id}/video`, "lit@beta.test")).status, 404);
  assert.equal((await envoyerFilm(env, ok.corps.parlomix.id, ADMIN)).status, 409, "film déjà reçu");
});

test("Parlomix : plus servi dès qu'une personne montée retire son accord", async () => {
  const { env, db, api, cid, camille, lea, reponse } = await campagneAvecReponses();
  const r = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "question", etape_id: "q-premier-mot", format: "16:9", titre: "Le premier mot",
    plan: plan([camille, lea].map((s) => [reponse(s, "q-premier-mot"), s])),
  });
  await envoyerFilm(env, r.corps.parlomix.id, ADMIN);
  await db.prepare("UPDATE sessions SET retiree_le = ? WHERE id = ?").bind(new Date().toISOString(), lea).run();
  assert.equal((await api("GET", `/api/espace/parlomix/${r.corps.parlomix.id}/video`, ADMIN)).status, 410);
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/parlomix`, ADMIN)).corps.parlomix[0].disponible, false);
  const nouveau = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "personne", session_id: lea, format: "16:9", titre: "Léa", plan: plan([[reponse(lea, "q-premier-mot"), lea]]),
  });
  assert.equal(nouveau.status, 410, "on ne monte plus ses réponses");
});

test("Parlomix : 20 réponses au plus, et seulement des réponses de la campagne", async () => {
  const { api, cid, camille, reponse } = await campagneAvecReponses();
  const r = reponse(camille, "q-premier-mot");
  const trop = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "personne", session_id: camille, format: "16:9", titre: "x", plan: plan(Array.from({ length: 21 }, () => [r, camille] as [string, string])),
  });
  assert.equal(trop.status, 400);
  const inconnue = await api("POST", `/api/espace/campagnes/${cid}/parlomix`, ADMIN, {
    type: "personne", session_id: camille, format: "16:9", titre: "x", plan: plan([[crypto.randomUUID(), camille]]),
  });
  assert.equal(inconnue.status, 400);
});
