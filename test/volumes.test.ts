// Volume de stockage d'une campagne : tailles notées à l'envoi, fichiers anciens mesurés après coup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { campagneAvecReponses } from "./aide/campagne.ts";
import { ADMIN } from "./aide/env.ts";

test("volume : vidéos et miniatures comptées à l'envoi, par campagne", async () => {
  const { api, cid, tablette, visiteur, reponse } = await campagneAvecReponses();
  const sid = await visiteur("A", "Inès", false);
  await tablette("A", "PUT", `/api/cabine/sessions/${sid}/reponses/q-premier-mot/miniature`, new Uint8Array(40), { "content-type": "image/jpeg" });
  const v = (await api("GET", `/api/espace/campagnes/${cid}/volume`, ADMIN)).corps.volume;
  // 4 visiteurs × 2 réponses de 3 octets, une miniature de 40 octets.
  assert.equal(v.videos.nombre, 8);
  assert.equal(v.videos.octets, 24);
  assert.equal(v.videos.dureeMs, 8 * 9000);
  assert.equal(v.miniatures.octets, 40);
  assert.equal(v.octets, 64);
  assert.equal(v.nonMesures, 0);
  assert.ok(reponse);
  const liste = (await api("GET", "/api/admin/campagnes", ADMIN)).corps.campagnes;
  assert.equal(liste.find((c: any) => c.id === cid).octets, 64);
});

test("volume : les fichiers envoyés avant la mesure sont mesurés au premier affichage", async () => {
  const { api, db, cid } = await campagneAvecReponses();
  await db.prepare("UPDATE reponses SET octets_source = NULL").run();
  const v = (await api("GET", `/api/espace/campagnes/${cid}/volume`, ADMIN)).corps.volume;
  assert.equal(v.videos.octets, 18, "6 vidéos de 3 octets, lues dans les métadonnées du stockage");
  const restants = await db.prepare("SELECT COUNT(*) AS n FROM reponses WHERE octets_source IS NULL").first<{ n: number }>();
  assert.equal(restants?.n, 0, "tailles enregistrées");
});

test("volume : réservé aux comptes qui voient la campagne", async () => {
  const { api, cid } = await campagneAvecReponses();
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/volume`, "lit@alpha.test")).status, 200);
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/volume`, "lit@beta.test")).status, 404);
});
