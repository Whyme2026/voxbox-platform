import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../src/index.ts";
import { ADMIN, client, creerEnv } from "./aide/env.ts";

const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));

/** Deux marques ; la première a une campagne active, une cabine appairée et un visiteur qui a répondu à une question. */
async function avecUneReponse() {
  const { env, db } = creerEnv();
  const api = client(env);
  const marque = async (nom: string) => {
    const cl = await api("POST", "/api/admin/clients", ADMIN, { nom, raison_sociale: `${nom} SAS`, contact_rgpd: `rgpd@${nom.toLowerCase()}.test` });
    const id = cl.corps.client.id as string;
    await api("POST", "/api/admin/utilisateurs", ADMIN, { email: `lit@${nom.toLowerCase()}.test`, role: "lecteur_client", client_id: id });
    return id;
  };
  const alpha = await marque("Alpha");
  await marque("Beta");
  const cp = await api("POST", "/api/admin/campagnes", ADMIN, { client_id: alpha, nom: "Démo" });
  const cid = cp.corps.campagne.id as string;
  await api("POST", `/api/admin/campagnes/${cid}/parcours`, ADMIN, { config: demo });
  await api("POST", `/api/admin/campagnes/${cid}/consentement`, ADMIN, {});
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "validee" });
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "active" });
  const cab = await api("POST", "/api/admin/cabines", ADMIN, { nom: "Cabine 1" });
  await api("PATCH", `/api/admin/cabines/${cab.corps.cabine.id}`, ADMIN, { campagne_id: cid });
  const jeton = (await api("POST", "/api/cabine/appairer", undefined, { code: cab.corps.cabine.code_appairage })).corps.jeton as string;
  const tablette = async (methode: string, chemin: string, corps: unknown, entetes: Record<string, string> = {}) => {
    const json = !(corps instanceof Uint8Array);
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode,
      headers: { authorization: `Bearer ${jeton}`, ...(json ? { "content-type": "application/json" } : {}), ...entetes },
      body: json ? JSON.stringify(corps) : (corps as unknown as BodyInit),
    }), env);
    return { status: res.status, corps: (await res.json()) as any };
  };
  const conf = (await traiter(new Request("http://localhost/api/cabine/config", { headers: { authorization: `Bearer ${jeton}` } }), env).then((r) => r.json())) as any;
  const sid = crypto.randomUUID();
  assert.equal((await tablette("POST", "/api/cabine/sessions", {
    id: sid, prenom: "Camille", consent_interne: true, consent_diffusion: true,
    parcours_version_id: conf.campagne.parcours_version_id, consentement_version_id: conf.consentement.id,
  })).status, 201);
  const octets = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  const put = await tablette("PUT", `/api/cabine/sessions/${sid}/reponses/q-coup-de-coeur`, octets, { "content-type": "video/webm", "x-duree-ms": "12000", "x-son-present": "1" });
  assert.equal(put.status, 201, JSON.stringify(put.corps));
  return { env, db, api, cid, sid, octets };
}

test("réponses : WhyMe et le client propriétaire voient les sessions, avec le libellé des questions", async () => {
  const { api, cid } = await avecUneReponse();
  for (const qui of [ADMIN, "lit@alpha.test"]) {
    const r = await api("GET", `/api/espace/campagnes/${cid}/sessions`, qui);
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.equal(r.corps.total, 1);
    assert.equal(r.corps.sessions[0].prenom, "Camille");
    assert.equal(r.corps.sessions[0].consent_diffusion, true);
    assert.equal(r.corps.sessions[0].reponses.length, 1);
    assert.equal(r.corps.sessions[0].reponses[0].duree_ms, 12000);
    assert.equal(r.corps.questions.find((q: any) => q.id === "q-coup-de-coeur").titre, "Le coup de cœur");
  }
});

test("réponses : un autre client ne voit ni la campagne ni ses vidéos", async () => {
  const { api, cid } = await avecUneReponse();
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/sessions`, "lit@beta.test")).status, 404);
  const rep = (await api("GET", `/api/espace/campagnes/${cid}/sessions`, ADMIN)).corps.sessions[0].reponses[0];
  assert.equal((await api("GET", `/api/espace/reponses/${rep.id}/video`, "lit@beta.test")).status, 404);
});

test("vidéo : servie au client propriétaire, et chaque visionnage est journalisé", async () => {
  const { env, db, api, cid, octets } = await avecUneReponse();
  const rep = (await api("GET", `/api/espace/campagnes/${cid}/sessions`, ADMIN)).corps.sessions[0].reponses[0];
  const res = await traiter(new Request(`http://localhost/api/espace/reponses/${rep.id}/video`, { headers: { "x-dev-email": "lit@alpha.test" } }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/webm");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), octets);
  const j = await db.prepare("SELECT utilisateur_email, cible_id FROM journal WHERE action = 'reponse.visionnage'").all<any>();
  assert.deepEqual(j.results, [{ utilisateur_email: "lit@alpha.test", cible_id: rep.id }]);
});

test("vidéo : plus servie quand le visiteur a retiré son accord", async () => {
  const { db, api, cid, sid } = await avecUneReponse();
  const rep = (await api("GET", `/api/espace/campagnes/${cid}/sessions`, ADMIN)).corps.sessions[0].reponses[0];
  await db.prepare("UPDATE sessions SET retiree_le = ? WHERE id = ?").bind(new Date().toISOString(), sid).run();
  assert.equal((await api("GET", `/api/espace/reponses/${rep.id}/video`, ADMIN)).status, 410);
  const liste = await api("GET", `/api/espace/campagnes/${cid}/sessions`, ADMIN);
  assert.deepEqual(liste.corps.sessions[0].reponses, []);
});

test("liste des campagnes WhyMe : nombre de sessions et de réponses", async () => {
  const { api } = await avecUneReponse();
  const r = await api("GET", "/api/admin/campagnes", ADMIN);
  const c = r.corps.campagnes.find((x: any) => x.nom === "Démo");
  assert.equal(c.nb_sessions, 1);
  assert.equal(c.nb_reponses, 1);
});
