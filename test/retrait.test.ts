import { test } from "node:test";
import assert from "node:assert/strict";
import { traiter } from "../src/index.ts";
import { ADMIN } from "./aide/env.ts";
import { campagneAvecReponses } from "./aide/campagne.ts";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

test("lien de retrait : le code choisi par la tablette est gardé, la page publique le reconnaît", async () => {
  const { api, visiteur } = await campagneAvecReponses();
  await visiteur("A", "Inès", true, undefined, "K7Q2MZ4XPA");
  const info = await api("GET", "/api/retrait/k7q2-mz4x-pa");
  assert.equal(info.status, 200, "sans authentification, tirets et minuscules tolérés");
  assert.equal(info.corps.prenom, "Inès");
  assert.equal(info.corps.marque, "Alpha");
  assert.equal(info.corps.diffusion, true);
  assert.equal((await api("GET", "/api/retrait/AAAAAAAAAA")).status, 404);
  assert.equal((await api("GET", "/api/retrait/court")).status, 404);
});

test("lien de retrait : le visiteur retire la diffusion, puis tout ; vidéos et miniatures supprimées", async () => {
  const { db, media, api, tablette, visiteur } = await campagneAvecReponses();
  const sid = await visiteur("A", "Inès", true, undefined, "K7Q2MZ4XPA");
  const m = await tablette("A", "PUT", `/api/cabine/sessions/${sid}/reponses/q-premier-mot/miniature`, jpeg, { "content-type": "image/jpeg" });
  assert.equal(m.status, 201, JSON.stringify(m.corps));
  const avant = media.objets.size;
  assert.equal((await api("POST", "/api/retrait/K7Q2MZ4XPA", undefined, { portee: "diffusion" })).status, 200);
  assert.equal((await api("GET", "/api/retrait/K7Q2MZ4XPA")).corps.diffusion, false);
  assert.equal((await api("POST", "/api/retrait/K7Q2MZ4XPA", undefined, { portee: "diffusion" })).status, 409);
  assert.equal((await api("POST", "/api/retrait/K7Q2MZ4XPA", undefined, { portee: "tout" })).status, 200);
  assert.equal(media.objets.size, avant - 3, "2 vidéos + 1 miniature");
  const info = await api("GET", "/api/retrait/K7Q2MZ4XPA");
  assert.ok(info.corps.retiree_le);
  assert.equal(info.corps.prenom, null, "le prénom n'est plus montré");
  const j = await db.prepare("SELECT utilisateur_email, details FROM journal WHERE action = 'session.retrait'").first<any>();
  assert.equal(j.utilisateur_email, "visiteur (lien de retrait)");
  assert.match(j.details, /"origine":"visiteur"/);
});

test("miniatures : envoyées par la cabine, servies au client propriétaire seulement", async () => {
  const { env, api, cid, camille, tablette } = await campagneAvecReponses();
  assert.equal((await tablette("A", "PUT", `/api/cabine/sessions/${camille}/reponses/q-premier-mot/miniature`, jpeg, { "content-type": "image/jpeg" })).status, 201);
  assert.equal((await tablette("B", "PUT", `/api/cabine/sessions/${camille}/reponses/q-coup-de-coeur/miniature`, jpeg, { "content-type": "image/jpeg" })).status, 404, "pas depuis une autre cabine");
  assert.equal((await tablette("A", "PUT", `/api/cabine/sessions/${camille}/reponses/q-premier-mot/miniature`, new Uint8Array([1]), { "content-type": "image/png" })).status, 415);
  const s = (await api("GET", `/api/espace/campagnes/${cid}/sessions`, ADMIN)).corps.sessions.find((x: any) => x.id === camille);
  const [avec, sans] = [s.reponses.find((r: any) => r.etape_id === "q-premier-mot"), s.reponses.find((r: any) => r.etape_id === "q-coup-de-coeur")];
  assert.equal(avec.miniature, true);
  assert.equal(sans.miniature, false);
  const img = await traiter(new Request(`http://localhost/api/espace/reponses/${avec.id}/miniature`, { headers: { "x-dev-email": "lit@alpha.test" } }), env);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.equal((await api("GET", `/api/espace/reponses/${avec.id}/miniature`, "lit@beta.test")).status, 404);
  // Rattrapage par Parlorama pour une réponse sans miniature ; jamais de remplacement.
  const put = (id: string) => traiter(new Request(`http://localhost/api/espace/reponses/${id}/miniature`, { method: "PUT", headers: { "x-dev-email": "lit@alpha.test", "content-type": "image/jpeg" }, body: jpeg as unknown as BodyInit }), env);
  assert.equal((await put(sans.id)).status, 201);
  assert.equal((await put(sans.id)).status, 200, "déjà présente : rien n'est remplacé");
});

test("vidéo téléchargée pour fabriquer une miniature : tracée à part dans le journal", async () => {
  const { env, db, api, cid } = await campagneAvecReponses();
  const rep = (await api("GET", `/api/espace/campagnes/${cid}/sessions`, ADMIN)).corps.sessions[0].reponses[0];
  await traiter(new Request(`http://localhost/api/espace/reponses/${rep.id}/video?pour=miniature`, { headers: { "x-dev-email": ADMIN } }), env);
  const j = await db.prepare("SELECT action FROM journal WHERE cible_id = ?").bind(rep.id).all<any>();
  assert.deepEqual(j.results.map((x: any) => x.action), ["reponse.miniature"]);
});
