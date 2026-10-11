// Purge à échéance (Parlopop) : la durée de conservation promise aux visiteurs est respectée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN } from "./aide/env.ts";
import { campagneAvecReponses } from "./aide/campagne.ts";
import { campagneAnalyse, fauxMistral } from "./aide/analyse.ts";
import { purgerEchues } from "../src/rgpd/purge.ts";
import { transcrireReponse } from "../src/analyse/transcription.ts";
import { classerReponse } from "../src/analyse/classement.ts";

const dans = (jours: number) => new Date(Date.now() + jours * 86_400_000).toISOString();

test("rien n'est purgé avant l'échéance ; à l'échéance, fichiers et données partent, une trace anonyme reste", async () => {
  const { env, db, media, api, cid, camille, lea } = await campagneAvecReponses();
  const fichiersAvant = media.objets.size;
  assert.ok(fichiersAvant >= 6);
  assert.deepEqual(await purgerEchues(env), { sessions: 0, videos: 0, parlomix: 0, erreurs: 0 });

  // La campagne de démo conserve 365 jours : on se place juste après l'échéance de Camille seulement.
  const echeance = (await db.prepare("SELECT purge_prevue_le FROM sessions WHERE id = ?").bind(camille).first<any>()).purge_prevue_le as string;
  await db.prepare("UPDATE sessions SET purge_prevue_le = ? WHERE id = ?").bind(dans(400), lea).run();
  const bilan = await purgerEchues(env, { maintenant: new Date(Date.parse(echeance) + 1000).toISOString() });
  assert.equal(bilan.sessions, 2, "Camille et Hugo (même échéance à la seconde près), pas Léa");
  assert.equal(bilan.videos, 4);

  const s = await db.prepare("SELECT prenom, email, nom, purgee_le, consent_diffusion FROM sessions WHERE id = ?").bind(camille).first<any>();
  assert.equal(s.prenom, "(supprimé)");
  assert.equal(s.email, null);
  assert.ok(s.purgee_le);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM reponses WHERE session_id = ?").bind(camille).first<any>()).n, 0);
  assert.equal(media.objets.size, fichiersAvant - 4);
  assert.ok([...media.objets.keys()].every((k) => !k.includes(camille)));
  const j = await db.prepare("SELECT utilisateur_email, details FROM journal WHERE action = 'session.purge' AND cible_id = ?").bind(camille).first<any>();
  assert.equal(j.utilisateur_email, "purge automatique");
  assert.ok(!j.details.includes("Camille"), "le journal ne garde pas le prénom");

  // Parlorama : la session purgée n'apparaît plus ; Léa reste.
  const liste = await api("GET", `/api/espace/campagnes/${cid}/sessions`, ADMIN);
  assert.deepEqual(liste.corps.sessions.map((x: any) => x.prenom), ["Léa"]);
  // Un second passage ne refait rien.
  assert.equal((await purgerEchues(env, { maintenant: new Date(Date.parse(echeance) + 2000).toISOString() })).sessions, 0);
});

test("une tablette restée hors ligne ne peut pas renvoyer une vidéo pour un passage purgé", async () => {
  const { env, db, camille, tablette } = await campagneAvecReponses();
  await db.prepare("UPDATE sessions SET purge_prevue_le = ? WHERE id = ?").bind(dans(-1), camille).run();
  assert.equal((await purgerEchues(env)).sessions, 1);
  const put = await tablette("A", "PUT", `/api/cabine/sessions/${camille}/reponses/q-premier-mot`, new Uint8Array([1, 2]), { "content-type": "video/webm" });
  assert.equal(put.status, 410);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM reponses WHERE session_id = ?").bind(camille).first<any>()).n, 0);
});

test("les Parlomix où figure une personne purgée sont supprimés", async () => {
  const { env, db, media, cid, camille } = await campagneAvecReponses();
  await db.prepare(`INSERT INTO parlomix (id, campagne_id, type, session_id, format, titre, sessions, nb_extraits, diffusable, plan, statut, cle, cree_par, cree_le)
    VALUES ('px1', ?, 'personne', ?, '16:9', 'Camille', ?, 2, 0, '{}', 'pret', 'campagnes/x/parlomix/px1.webm', ?, ?)`)
    .bind(cid, camille, JSON.stringify([camille]), ADMIN, new Date().toISOString()).run();
  await media.put("campagnes/x/parlomix/px1.webm", new ArrayBuffer(3));
  await db.prepare("UPDATE sessions SET purge_prevue_le = ? WHERE id = ?").bind(dans(-1), camille).run();
  const b = await purgerEchues(env);
  assert.equal(b.parlomix, 1);
  assert.equal(await db.prepare("SELECT 1 FROM parlomix WHERE id = 'px1'").first(), null);
  assert.ok(!media.objets.has("campagnes/x/parlomix/px1.webm"));
});

test("option Analyse : transcriptions, thèmes et alertes partent aussi à l'échéance ; la campagne annonce la prochaine purge", async () => {
  const { env, db, api, cid, visiteur } = await campagneAnalyse();
  const v = await visiteur();
  const faux = fauxMistral();
  await transcrireReponse(env, v.rid, { fetch: faux.f });
  await classerReponse(env, v.rid, { fetch: faux.f });
  assert.ok((await db.prepare("SELECT COUNT(*) AS n FROM reponse_themes").first<any>()).n > 0);
  const d = (await api("GET", `/api/admin/campagnes/${cid}`, ADMIN)).corps.campagne;
  assert.equal(d.purge.restantes, 1);
  assert.ok(d.purge.prochaine);
  await db.prepare("UPDATE sessions SET purge_prevue_le = ? WHERE id = ?").bind(dans(-1), v.sid).run();
  await purgerEchues(env);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM reponse_themes").first<any>()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM reponses").first<any>()).n, 0);
  assert.equal((await api("GET", `/api/admin/campagnes/${cid}`, ADMIN)).corps.campagne.purge.purgees, 1);
});

test("une panne du stockage n'arrête pas la purge des autres passages, et rien n'est marqué supprimé à tort", async () => {
  const { env, db, media, camille, lea } = await campagneAvecReponses();
  await db.prepare("UPDATE sessions SET purge_prevue_le = ? WHERE id IN (?, ?)").bind(dans(-1), camille, lea).run();
  const supprimer = media.delete.bind(media);
  let premier = true;
  media.delete = async (cles) => { if (premier) { premier = false; throw new Error("R2 indisponible"); } return supprimer(cles); };
  const b = await purgerEchues(env);
  assert.equal(b.erreurs, 1);
  assert.equal(b.sessions, 1);
  const restante = await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id IN (?, ?) AND purgee_le IS NULL").bind(camille, lea).first<any>();
  assert.equal(restante.n, 1, "la session en échec reste à purger au passage suivant");
  assert.equal((await purgerEchues(env)).sessions, 1);
});
