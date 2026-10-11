// Alertes d'exploitation (Parlobox) : cabine hors ligne, batterie, file d'envoi, micro, vidéos sans voix, analyse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN } from "./aide/env.ts";
import { campagneAvecReponses } from "./aide/campagne.ts";
import { verifierExploitation } from "../src/exploitation/alertes.ts";
import { boiteEssai } from "../src/courriel.ts";

const ilYa = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ouvertes = async (db: any) => (await db.prepare("SELECT type, cible_id FROM alertes_exploitation WHERE fermee_le IS NULL ORDER BY type").all()).results as { type: string; cible_id: string }[];

test("cabine hors ligne : alerte ouverte une seule fois, e-mail aux comptes WhyMe, fermée au retour", async () => {
  const { env, db, api, cabines } = await campagneAvecReponses();
  await db.prepare("UPDATE cabines SET vu_le = ?, dernier_signal = NULL").bind(ilYa(1)).run();
  await db.prepare("UPDATE cabines SET vu_le = ? WHERE id = ?").bind(ilYa(25), cabines.A).run();
  boiteEssai.length = 0;
  const b1 = await verifierExploitation(env);
  assert.equal(b1.ouvertes, 1);
  assert.deepEqual((await ouvertes(db)).map((a) => a.type), ["cabine_hors_ligne"]);
  assert.equal(b1.notifiees, 1);
  assert.ok(boiteEssai.some((c) => c.a === ADMIN && /ne répond plus/.test(c.sujet)));

  // Toujours hors ligne : pas de nouvelle alerte, pas de nouvel e-mail.
  boiteEssai.length = 0;
  const b2 = await verifierExploitation(env);
  assert.equal(b2.ouvertes, 0);
  assert.equal(boiteEssai.length, 0);

  // Parlorama : visible, et « je m'en occupe ».
  const liste = await api("GET", "/api/admin/alertes", ADMIN);
  assert.equal(liste.corps.alertes.length, 1);
  assert.equal((await api("POST", `/api/admin/alertes/${liste.corps.alertes[0].id}/vue`, ADMIN, {})).status, 200);
  assert.equal((await api("GET", "/api/admin/alertes", "lit@alpha.test")).status, 403, "réservé à WhyMe");

  await db.prepare("UPDATE cabines SET vu_le = ? WHERE id = ?").bind(ilYa(0.5), cabines.A).run();
  const b3 = await verifierExploitation(env);
  assert.equal(b3.fermees, 1);
  assert.equal((await ouvertes(db)).length, 0);
});

test("une cabine éteinte depuis la veille est rangée, pas en panne", async () => {
  const { env, db } = await campagneAvecReponses();
  await db.prepare("UPDATE cabines SET vu_le = ?").bind(ilYa(20 * 60)).run();
  assert.equal((await verifierExploitation(env)).ouvertes, 0);
});

test("batterie basse hors charge, file d'envoi bloquée, micro inaccessible ; fermées quand ça revient", async () => {
  const { env, db, cabines } = await campagneAvecReponses();
  await db.prepare("UPDATE cabines SET vu_le = ?, dernier_signal = ?").bind(ilYa(1), JSON.stringify({ batterie: 80, file: 0, micro: true })).run();
  await db.prepare("UPDATE cabines SET dernier_signal = ? WHERE id = ?").bind(JSON.stringify({ batterie: 12, en_charge: false, file: 14, micro: false }), cabines.B).run();
  await verifierExploitation(env);
  assert.deepEqual((await ouvertes(db)).map((a) => a.type), ["batterie_basse", "file_bloquee", "micro_absent"]);
  // En charge, file vidée, micro revenu.
  await db.prepare("UPDATE cabines SET dernier_signal = ? WHERE id = ?").bind(JSON.stringify({ batterie: 14, en_charge: true, file: 1, micro: true }), cabines.B).run();
  assert.equal((await verifierExploitation(env)).fermees, 3);
});

test("vidéos sans voix : alerte à 2 sur les 6 dernières d'une cabine, fermée quand les 3 dernières ont du son", async () => {
  const { env, db, cabines, visiteur } = await campagneAvecReponses();
  await db.prepare("UPDATE cabines SET vu_le = ?").bind(ilYa(1)).run();
  // Deux visiteurs de plus sur la cabine A, dont les vidéos n'ont pas de voix détectée.
  for (const p of ["Zoé", "Yan"]) {
    const sid = await visiteur("A", p, false);
    await db.prepare("UPDATE reponses SET son_present = 0, cree_le = ? WHERE session_id = ?").bind(new Date(Date.now() + 1000).toISOString(), sid).run();
  }
  await verifierExploitation(env);
  const a = await ouvertes(db);
  assert.deepEqual(a.map((x) => [x.type, x.cible_id]), [["videos_sans_son", cabines.A]]);
  // Trois nouvelles réponses avec du son : l'alerte se ferme.
  for (const p of ["Ali", "Bea"]) {
    const sid = await visiteur("A", p, false);
    await db.prepare("UPDATE reponses SET cree_le = ? WHERE session_id = ?").bind(new Date(Date.now() + 5000).toISOString(), sid).run();
  }
  assert.equal((await verifierExploitation(env)).fermees, 1);
});

test("option Analyse : transcriptions abandonnées signalées par campagne", async () => {
  const { env, db, cid, camille } = await campagneAvecReponses();
  await db.prepare("UPDATE cabines SET vu_le = ?").bind(ilYa(1)).run();
  await db.prepare("UPDATE campagnes SET option_analyse = 1 WHERE id = ?").bind(cid).run();
  await db.prepare("UPDATE reponses SET transcription_etat = 'echec', maj_le = ? WHERE session_id = ?").bind(new Date().toISOString(), camille).run();
  await verifierExploitation(env);
  assert.deepEqual((await ouvertes(db)).map((x) => [x.type, x.cible_id]), [["analyse_echec", cid]]);
  await db.prepare("UPDATE reponses SET transcription_etat = 'faite' WHERE session_id = ?").bind(camille).run();
  assert.equal((await verifierExploitation(env)).fermees, 1);
});

test("sans service d'e-mail (environnement en ligne sans Brevo) : l'alerte reste visible, signalée plus tard", async () => {
  const { env, db, cabines } = await campagneAvecReponses();
  env.AUTH_MODE = "access";
  await db.prepare("UPDATE cabines SET vu_le = ?").bind(ilYa(1)).run();
  await db.prepare("UPDATE cabines SET vu_le = ? WHERE id = ?").bind(ilYa(30), cabines.B).run();
  const b = await verifierExploitation(env);
  assert.equal(b.ouvertes, 1);
  assert.equal(b.notifiees, 0);
  const a = await db.prepare("SELECT notifiee_le FROM alertes_exploitation").first<any>();
  assert.equal(a.notifiee_le, null);
});
