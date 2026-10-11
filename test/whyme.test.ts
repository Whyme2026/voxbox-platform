// Why me : parcours du candidat, montage, transmission, page publique, espace recruteur, droits du candidat, tâches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../src/index.ts";
import { ADMIN, client, creerEnv } from "./aide/env.ts";
import { ajouterMois, validerConfig } from "../src/whyme/config.ts";
import { tachesWhyme } from "../src/whyme/taches.ts";
import { couperLignes, bornesParole } from "../montage/monter.ts";

const modele = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/whyme-campagne-demo.json"), "utf8"));
const CLE = "secret-de-montage-pour-les-tests-0123456789";

/** Campagne ouverte avec deux entreprises (Verkor, Valeo) et un recruteur chez chacune. */
async function preparer(surcharges: Record<string, unknown> = {}) {
  const { env, db, media } = creerEnv({ MONTAGE_CLE: CLE, ...surcharges });
  const api = client(env);
  const verkor = (await api("POST", "/api/admin/whyme/entreprises", ADMIN, { nom: "Verkor" })).corps.entreprise.id as string;
  const valeo = (await api("POST", "/api/admin/whyme/entreprises", ADMIN, { nom: "Valeo" })).corps.entreprise.id as string;
  await api("POST", "/api/admin/whyme/recruteurs", ADMIN, { email: "rh@verkor.test", entreprise_id: verkor });
  await api("POST", "/api/admin/whyme/recruteurs", ADMIN, { email: "rh@valeo.test", entreprise_id: valeo });
  const cp = await api("POST", "/api/admin/whyme/campagnes", ADMIN, { nom: "Mondial 2026", code: "mondial-2026", config: modele, entreprises: [verkor, valeo] });
  assert.equal(cp.status, 201, JSON.stringify(cp.corps));
  const campagneId = cp.corps.campagne.id as string;
  assert.equal((await api("POST", `/api/admin/whyme/campagnes/${campagneId}/statut`, ADMIN, { statut: "active" })).status, 200);
  const publique = (await api("GET", "/api/whyme/campagnes/mondial-2026")).corps;

  const telephone = async (methode: string, chemin: string, jeton: string, corps?: unknown, entetes: Record<string, string> = {}) => {
    const binaire = corps instanceof Uint8Array;
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode,
      headers: { "x-jeton": jeton, ...(corps !== undefined && !binaire ? { "content-type": "application/json" } : {}), ...entetes },
      body: corps === undefined ? undefined : binaire ? (corps as unknown as BodyInit) : JSON.stringify(corps),
    }), env);
    return { status: res.status, corps: (await res.json().catch(() => ({}))) as any };
  };
  const service = async (methode: string, chemin: string, corps?: Uint8Array | object, type?: string, entetes: Record<string, string> = {}) => {
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode,
      headers: { "x-montage-cle": CLE, ...(type ? { "content-type": type } : {}), ...entetes },
      body: corps === undefined ? undefined : corps instanceof Uint8Array ? (corps as unknown as BodyInit) : JSON.stringify(corps),
    }), env);
    return res;
  };

  /** Un candidat qui s'inscrit et répond à toutes les questions. */
  const candidat = async (o: { prenom?: string; entreprises?: string[]; public?: boolean; age?: number; cv?: boolean } = {}) => {
    const id = crypto.randomUUID();
    const jeton = "j".repeat(10) + crypto.randomUUID().replace(/-/g, "");
    const r = await telephone("POST", "/api/whyme/campagnes/mondial-2026/candidats", jeton, {
      id, jeton, prenom: o.prenom ?? "Camille", nom: "Martin", email: "camille@exemple.fr", age: o.age ?? 22, famille: "gerer",
      entreprises: o.entreprises ?? [verkor], consent_candidature: true, consent_public: o.public ?? true, empreinte: publique.empreinte,
    });
    assert.equal(r.status, 201, JSON.stringify(r.corps));
    if (o.cv) assert.equal((await telephone("PUT", `/api/whyme/candidats/${id}/cv`, jeton, new TextEncoder().encode("%PDF-1.4 cv"), { "content-type": "application/pdf", "x-nom-fichier": "CV%20Camille.pdf" })).status, 200);
    for (const q of modele.questions) {
      const p = await telephone("PUT", `/api/whyme/candidats/${id}/prises/${q.id}`, jeton, new Uint8Array([1, 2, 3, 4]), { "content-type": "video/webm;codecs=vp9,opus", "x-duree-ms": "9500", "x-son-present": "1" });
      assert.equal(p.status, 200, JSON.stringify(p.corps));
    }
    return { id, jeton };
  };

  /** Le service de montage fait son travail : miniature puis film. */
  const monter = async (id: string) => {
    const plan = await (await service("GET", `/api/montage/travaux/${id}`)).json() as any;
    assert.equal(plan.questions.length, 4);
    assert.equal((await service("PUT", `/api/montage/miniature/${id}`, new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).status, 200);
    assert.equal((await service("PUT", `/api/montage/resultat/${id}`, new Uint8Array(1000).fill(7), "video/mp4", { "x-duree-ms": "52000" })).status, 200);
    return plan;
  };

  const recruteur = async (email: string) => {
    await api("POST", "/api/recruteur/lien", undefined, { email });
    const courriel = db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE a = ? AND sorte = 'connexion_recruteur' ORDER BY cree_le DESC LIMIT 1").get(email) as { texte: string } | undefined;
    const lien = /#lien=([\w-]+)/.exec(courriel?.texte ?? "")?.[1];
    assert.ok(lien, "lien de connexion reçu");
    const s = await api("POST", "/api/recruteur/session", undefined, { lien });
    assert.equal(s.status, 200, JSON.stringify(s.corps));
    const jeton = s.corps.jeton as string;
    return async (methode: string, chemin: string) => {
      const res = await traiter(new Request(`http://localhost${chemin}`, { method: methode, headers: { authorization: `Bearer ${jeton}` } }), env);
      return res;
    };
  };

  return { env, db, media, api, verkor, valeo, campagneId, publique, telephone, service, candidat, monter, recruteur };
}

test("Why me : configuration validée (3 à 5 questions, durées, identifiants)", () => {
  const c = validerConfig(modele);
  assert.equal(c.questions.length, 4);
  assert.equal(c.questions[0]!.dureeSec, 10);
  assert.equal(c.ageAffiche, true);
  assert.equal(c.ageMinimum, 15);
  assert.throws(() => validerConfig({ ...modele, questions: modele.questions.slice(0, 2) }), /3 à 5/);
  assert.throws(() => validerConfig({ ...modele, questions: [...modele.questions.slice(0, 3), { id: "q-toi", texte: "x" }] }), /double/);
  assert.throws(() => validerConfig({ ...modele, questions: modele.questions.map((q: any) => ({ ...q, dureeSec: 120 })) }), /durée/);
  assert.equal(validerConfig({ ...modele, ageAffiche: false }).ageAffiche, false);
  assert.equal(ajouterMois("2026-01-31T10:00:00.000Z", 1), "2026-02-28T10:00:00.000Z");
});

test("Why me : le téléphone voit la campagne ouverte, ses entreprises et ses textes", async () => {
  const { publique, api, campagneId } = await preparer();
  assert.equal(publique.campagne.evenement, "Mondial de l'Auto");
  assert.deepEqual(publique.entreprises.map((e: any) => e.nom), ["Verkor", "Valeo"]);
  assert.match(publique.textes.candidature, /12 mois/);
  assert.match(publique.textes.informationAge, /âge/);
  assert.equal(publique.empreinte.length, 64);
  // Campagne close : fermée au public.
  await api("POST", `/api/admin/whyme/campagnes/${campagneId}/statut`, ADMIN, { statut: "close" });
  assert.equal((await api("GET", "/api/whyme/campagnes/mondial-2026")).status, 404);
});

test("Why me : inscription contrôlée (âge minimum, accords, entreprises, textes à jour, idempotence)", async () => {
  const { telephone, publique, verkor } = await preparer();
  const id = crypto.randomUUID();
  const jeton = "a".repeat(40);
  const base = { id, jeton, prenom: "Léo", nom: "Durand", email: "leo@exemple.fr", age: 20, famille: "gerer", entreprises: [verkor], consent_candidature: true, consent_public: false, empreinte: publique.empreinte };
  const envoyer = (corps: object) => telephone("POST", "/api/whyme/campagnes/mondial-2026/candidats", jeton, corps);
  assert.equal((await envoyer({ ...base, age: 14 })).corps.erreur, "age_minimum");
  assert.equal((await envoyer({ ...base, consent_candidature: false })).status, 400);
  assert.equal((await envoyer({ ...base, entreprises: [] })).status, 400);
  assert.equal((await envoyer({ ...base, entreprises: ["inconnue"] })).status, 400);
  assert.equal((await envoyer({ ...base, famille: "inconnue" })).status, 400);
  assert.equal((await envoyer({ ...base, empreinte: "0".repeat(64) })).corps.erreur, "textes_changes");
  assert.equal((await envoyer(base)).status, 201);
  // Renvoi après une coupure : même interview, pas de doublon.
  assert.equal((await envoyer(base)).corps.deja, true);
  // Autre jeton sur le même identifiant : refusé.
  assert.equal((await telephone("POST", "/api/whyme/campagnes/mondial-2026/candidats", "b".repeat(40), { ...base, jeton: "b".repeat(40) })).status, 409);
});

test("Why me : prises, une seule reprise par question, fin seulement quand tout est arrivé", async () => {
  const { telephone, publique, verkor, media, db } = await preparer();
  const id = crypto.randomUUID();
  const jeton = "c".repeat(40);
  await telephone("POST", "/api/whyme/campagnes/mondial-2026/candidats", jeton, { id, jeton, prenom: "Inès", nom: "B", email: "ines@exemple.fr", age: 19, famille: "gerer", entreprises: [verkor], consent_candidature: true, empreinte: publique.empreinte });
  const prise = (q: string, entetes: Record<string, string> = {}) => telephone("PUT", `/api/whyme/candidats/${id}/prises/${q}`, jeton, new Uint8Array([9, 9]), { "content-type": "video/mp4", "x-duree-ms": "8000", "x-son-present": "1", ...entetes });
  assert.equal((await prise("q-toi", { "x-prise-id": "p1" })).status, 200);
  assert.equal((await prise("q-toi", { "x-prise-id": "p2", "x-reprise": "1" })).status, 200);
  // Même reprise renvoyée après une coupure : acceptée ; troisième prise : refusée.
  assert.equal((await prise("q-toi", { "x-prise-id": "p2", "x-reprise": "1" })).status, 200);
  assert.equal((await prise("q-toi", { "x-prise-id": "p3", "x-reprise": "1" })).status, 409);
  // La reprise a remplacé la première prise dans le stockage.
  assert.equal([...media.objets.keys()].filter((k) => k.includes(`${id}/q-toi`)).length, 1);
  assert.equal((await prise("inconnue")).status, 400);
  assert.equal((await telephone("PUT", `/api/whyme/candidats/${id}/prises/q-mot`, jeton, new Uint8Array([1]), { "content-type": "image/png" })).status, 415);
  assert.equal((await telephone("PUT", `/api/whyme/candidats/${id}/prises/q-mot`, "d".repeat(40), new Uint8Array([1]), { "content-type": "video/mp4" })).status, 401);
  const fin = await telephone("POST", `/api/whyme/candidats/${id}/terminer`, jeton);
  assert.equal(fin.corps.erreur, "reponses_manquantes");
  for (const q of ["q-autres", "q-decouverte", "q-mot"]) await prise(q);
  assert.equal((await telephone("POST", `/api/whyme/candidats/${id}/terminer`, jeton)).corps.statut, "termine");
  // Sans service de montage configuré : l'interview attend, rien n'est transmis.
  const c = db.sqlite.prepare("SELECT statut FROM wm_candidats WHERE id = ?").get(id) as { statut: string };
  assert.equal(c.statut, "termine");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_candidatures WHERE candidat_id = ? AND transmise_le IS NOT NULL").get(id) as { n: number }).n, 0);
  // Interview terminée : plus de prise ni de CV.
  assert.equal((await prise("q-mot")).status, 409);
});

test("Why me : montage livré → rushes effacés, candidature transmise, e-mail avec page publique et sticker", async () => {
  const { candidat, monter, telephone, service, db, media, env } = await preparer();
  const { id, jeton } = await candidat({ cv: true });
  assert.equal((await telephone("POST", `/api/whyme/candidats/${id}/terminer`, jeton)).status, 200);
  // Le service est authentifié par son secret.
  assert.equal((await traiter(new Request(`http://localhost/api/montage/travaux/${id}`, { headers: { "x-montage-cle": "mauvais" } }), env)).status, 401);
  const plan = await monter(id);
  assert.equal(plan.prenom, "Camille");
  assert.equal(plan.age, 22);
  assert.equal(plan.questions[0].carton, "Toi, en deux mots");
  assert.deepEqual(plan.format, { largeur: 720, hauteur: 1280 });

  const c = db.sqlite.prepare("SELECT statut, code_public, acces_recruteurs_jusqu, public_jusqu, courriel_envoye_le FROM wm_candidats WHERE id = ?").get(id) as any;
  assert.equal(c.statut, "pret");
  assert.match(c.code_public, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.ok(c.acces_recruteurs_jusqu > new Date(Date.now() + 360 * 864e5).toISOString());
  assert.ok(c.public_jusqu > new Date(Date.now() + 720 * 864e5).toISOString());
  // Rushes effacés (décision du 11/10/2026) ; le montage, la miniature et le CV restent.
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_prises WHERE candidat_id = ?").get(id) as { n: number }).n, 0);
  const cles = [...media.objets.keys()].filter((k) => k.includes(id));
  assert.deepEqual(cles.map((k) => k.split("/").pop()).sort(), ["cv.pdf", "miniature.jpg", "montage.mp4"]);
  // E-mail : entreprises nommées, bouton vers la page publique, sticker, lien de gestion, mention du CV.
  const mail = db.sqlite.prepare("SELECT a, sujet, texte, html FROM wm_courriels WHERE sorte = 'video_prete'").get() as any;
  assert.equal(mail.a, "camille@exemple.fr");
  assert.equal(mail.sujet, "Ta vidéo WhyMe est prête !");
  assert.match(mail.texte, /partie chez Verkor/);
  assert.match(mail.texte, /Ton CV et ton interview vidéo leur sont accessibles/);
  assert.match(mail.texte, new RegExp(`/v/${c.code_public}`));
  assert.match(mail.html, /sticker\.png/);
  assert.match(mail.texte, /whyme\/gerer\/#g=/);
  // Le montage renvoyé une seconde fois ne retransmet ni ne renvoie rien.
  await service("PUT", `/api/montage/resultat/${id}`, new Uint8Array(10), "video/mp4");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_courriels WHERE sorte = 'video_prete'").get() as { n: number }).n, 1);
});

test("Why me : sans accord de page publique, pas de lien public ni de sticker", async () => {
  const { candidat, monter, telephone, db } = await preparer();
  const { id, jeton } = await candidat({ public: false });
  await telephone("POST", `/api/whyme/candidats/${id}/terminer`, jeton);
  await monter(id);
  const c = db.sqlite.prepare("SELECT code_public, public_jusqu FROM wm_candidats WHERE id = ?").get(id) as any;
  assert.equal(c.code_public, null);
  assert.equal(c.public_jusqu, null);
  const mail = db.sqlite.prepare("SELECT texte, html FROM wm_courriels WHERE sorte = 'video_prete'").get() as any;
  assert.doesNotMatch(mail.html, /sticker/);
  assert.doesNotMatch(mail.texte, /\/v\//);
  assert.match(mail.texte, /Ton interview vidéo leur est accessible pendant/);
});

test("Why me : page vidéo publique, sticker PNG, et suppression de la vidéo par le candidat (partout)", async () => {
  const { candidat, monter, telephone, db, api, recruteur, env } = await preparer();
  const { id, jeton } = await candidat();
  await telephone("POST", `/api/whyme/candidats/${id}/terminer`, jeton);
  await monter(id);
  const code = (db.sqlite.prepare("SELECT code_public FROM wm_candidats WHERE id = ?").get(id) as any).code_public as string;
  const v = await api("GET", `/api/whyme/videos/${code}`);
  assert.equal(v.status, 200);
  assert.equal(v.corps.prenom, "Camille");
  assert.equal(v.corps.nom, undefined, "pas de nom de famille sur la page publique");
  const flux = await traiter(new Request(`http://localhost/api/whyme/videos/${code}/flux?telecharger=1`), env);
  assert.equal(flux.status, 200);
  assert.match(flux.headers.get("content-disposition") ?? "", /^inline/, "jamais proposé en téléchargement au candidat");
  const sticker = await traiter(new Request(`http://localhost/api/whyme/videos/${code}/sticker.png`), env);
  const png = new Uint8Array(await sticker.arrayBuffer());
  assert.equal(sticker.headers.get("content-type"), "image/png");
  assert.deepEqual([...png.slice(1, 4)].map((o) => String.fromCharCode(o)).join(""), "PNG");
  assert.equal((await api("GET", "/api/whyme/videos/AAAAAAAAAA")).status, 404);

  // Lien « Tu gardes la main » de l'e-mail.
  const texte = (db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE sorte = 'video_prete'").get() as any).texte as string;
  const gestion = /#g=([\w-]+)/.exec(texte)![1]!;
  const gerer = async (action: string) => {
    const r = await traiter(new Request("http://localhost/api/whyme/gestion", { method: "POST", headers: { "content-type": "application/json", "x-gestion": gestion }, body: JSON.stringify({ action }) }), env);
    return { status: r.status, corps: (await r.json()) as any };
  };
  const etat = await gerer("etat");
  assert.deepEqual(etat.corps.entreprises, ["Verkor"]);
  assert.equal(etat.corps.video, true);
  // Le recruteur voit la vidéo…
  const rh = await recruteur("rh@verkor.test");
  assert.equal((await rh("GET", `/api/recruteur/candidats/${id}/video`)).status, 200);
  // … jusqu'à ce que le candidat la supprime : elle disparaît partout (décision du 11/10/2026).
  assert.equal((await gerer("supprimer_video")).status, 200);
  assert.equal((await api("GET", `/api/whyme/videos/${code}`)).status, 404);
  assert.equal((await rh("GET", `/api/recruteur/candidats/${id}/video`)).status, 404);
  const liste = await (await rh("GET", "/api/recruteur/candidats")).json() as any;
  assert.equal(liste.candidats[0].aVideo, false, "la candidature reste, sans vidéo");
  // Toutes les données : la candidature disparaît aussi, le lien ne sert plus.
  assert.equal((await gerer("supprimer_tout")).status, 200);
  assert.equal(((await (await rh("GET", "/api/recruteur/candidats")).json()) as any).candidats.length, 0);
  assert.equal((await gerer("etat")).status, 401);
  const c = db.sqlite.prepare("SELECT prenom, email, supprime_le FROM wm_candidats WHERE id = ?").get(id) as any;
  assert.equal(c.email, "");
  assert.ok(c.supprime_le);
});

test("Why me : espace recruteur cloisonné par entreprise, CV et vidéo journalisés, lien à usage unique", async () => {
  const { candidat, monter, telephone, recruteur, db, verkor, valeo, api } = await preparer();
  const a = await candidat({ prenom: "Alice", entreprises: [verkor], cv: true });
  const b = await candidat({ prenom: "Bruno", entreprises: [verkor, valeo] });
  const c = await candidat({ prenom: "Chloé", entreprises: [valeo] });
  for (const x of [a, b, c]) { await telephone("POST", `/api/whyme/candidats/${x.id}/terminer`, x.jeton); await monter(x.id); }
  // Une interview non montée n'est pas encore transmise.
  await candidat({ prenom: "David", entreprises: [verkor] });

  const verkorRh = await recruteur("rh@verkor.test");
  const listeVerkor = await (await verkorRh("GET", "/api/recruteur/candidats")).json() as any;
  assert.equal(listeVerkor.entreprise, "Verkor");
  assert.deepEqual(listeVerkor.candidats.map((x: any) => x.prenom).sort(), ["Alice", "Bruno"]);
  assert.equal(listeVerkor.candidats.find((x: any) => x.prenom === "Alice").famille, "Gérer & Administrer");
  // Chloé n'a postulé que chez Valeo : invisible pour Verkor.
  assert.equal((await verkorRh("GET", `/api/recruteur/candidats/${c.id}/video`)).status, 404);
  const cv = await verkorRh("GET", `/api/recruteur/candidats/${a.id}/cv?telecharger=1`);
  assert.equal(cv.status, 200);
  assert.match(cv.headers.get("content-disposition") ?? "", /^attachment/);
  const dl = await verkorRh("GET", `/api/recruteur/candidats/${a.id}/video?telecharger=1`);
  assert.match(dl.headers.get("content-disposition") ?? "", /^attachment/, "le recruteur peut télécharger");
  const actions = (db.sqlite.prepare("SELECT action FROM journal WHERE utilisateur_email = 'rh@verkor.test'").all() as any[]).map((l) => l.action);
  assert.deepEqual(actions.sort(), ["recruteur.connexion", "recruteur.cv.telechargement", "recruteur.video.telechargement"]);
  // Sans session : rien.
  assert.equal((await api("GET", "/api/recruteur/candidats")).status, 401);
  // Le lien de connexion ne sert qu'une fois ; une adresse inconnue reçoit la même réponse, sans e-mail.
  const lien = /#lien=([\w-]+)/.exec((db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE a = 'rh@verkor.test'").get() as any).texte)![1];
  assert.equal((await api("POST", "/api/recruteur/session", undefined, { lien })).status, 401);
  const inconnu = await api("POST", "/api/recruteur/lien", undefined, { email: "personne@exemple.fr" });
  assert.equal(inconnu.status, 200);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_courriels WHERE a = 'personne@exemple.fr'").get() as any).n, 0);
});

test("Why me : paramétrage réservé à WhyMe ; campagne figée une fois ouverte", async () => {
  const { api, campagneId, verkor } = await preparer();
  const cl = await api("POST", "/api/admin/clients", ADMIN, { nom: "Marque", raison_sociale: "Marque SAS", contact_rgpd: "rgpd@marque.test" });
  await api("POST", "/api/admin/utilisateurs", ADMIN, { email: "lit@marque.test", role: "lecteur_client", client_id: cl.corps.client.id });
  assert.equal((await api("GET", "/api/admin/whyme/campagnes", "lit@marque.test")).status, 403);
  assert.equal((await api("PATCH", `/api/admin/whyme/campagnes/${campagneId}`, ADMIN, { config: modele })).status, 409);
  assert.equal((await api("PATCH", `/api/admin/whyme/campagnes/${campagneId}`, ADMIN, { nom: "Renommée" })).status, 200);
  assert.equal((await api("POST", "/api/admin/whyme/campagnes", ADMIN, { nom: "X", config: { ...modele, questions: [] }, entreprises: [verkor] })).status, 400);
  assert.equal((await api("POST", "/api/admin/whyme/campagnes", ADMIN, { nom: "X", code: "mondial-2026", config: modele, entreprises: [verkor] })).status, 409);
});

test("Why me : tâches planifiées (relance du montage, e-mail de reprise, purges)", async () => {
  const appels: string[] = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    appels.push(`${init?.method ?? "GET"} ${String(url)} ${String(init?.body ?? "")}`);
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
  try {
    const { candidat, telephone, db, env, publique, verkor } = await preparer({ MONTAGE_URL: "https://montage.test" });
    // Une interview terminée : le montage est demandé tout de suite au service.
    const t = await candidat();
    await telephone("POST", `/api/whyme/candidats/${t.id}/terminer`, t.jeton);
    assert.equal(appels.length, 1);
    assert.match(appels[0]!, /POST https:\/\/montage\.test\/monter .*"api":"http:\/\/localhost"/);
    // Bloqué depuis 20 minutes : relancé par la tâche.
    db.sqlite.prepare("UPDATE wm_candidats SET montage_demande_le = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60_000).toISOString(), t.id);
    assert.equal((await tachesWhyme(env)).montages, 1);

    // Interview interrompue depuis 20 minutes : e-mail de reprise, une seule fois, avec un nouveau jeton.
    const id = crypto.randomUUID();
    const jeton = "e".repeat(40);
    await telephone("POST", "/api/whyme/campagnes/mondial-2026/candidats", jeton, { id, jeton, prenom: "Zoé", nom: "R", email: "zoe@exemple.fr", age: 30, famille: "gerer", entreprises: [verkor], consent_candidature: true, empreinte: publique.empreinte });
    db.sqlite.prepare("UPDATE wm_candidats SET derniere_action_le = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60_000).toISOString(), id);
    assert.equal((await tachesWhyme(env)).reprises, 1);
    assert.equal((await tachesWhyme(env)).reprises, 0);
    const mail = db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE sorte = 'reprise'").get() as any;
    const lien = new RegExp(`/i/mondial-2026#reprise=${id}\\.([\\w-]+)`).exec(mail.texte);
    assert.ok(lien);
    // L'ancien jeton du téléphone ne sert plus ; celui du lien, si.
    assert.equal((await telephone("GET", `/api/whyme/candidats/${id}`, jeton)).status, 401);
    assert.equal((await telephone("GET", `/api/whyme/candidats/${id}`, lien[1]!)).corps.prenom, "Zoé");

    // Purges : interview jamais terminée après 30 jours ; candidature dont tous les accès sont échus.
    db.sqlite.prepare("UPDATE wm_candidats SET cree_le = ? WHERE id = ?").run(new Date(Date.now() - 31 * 864e5).toISOString(), id);
    db.sqlite.prepare("UPDATE wm_candidats SET statut = 'pret', acces_recruteurs_jusqu = ?, public_jusqu = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1000).toISOString(), t.id);
    const bilan = await tachesWhyme(env);
    assert.equal(bilan.purges, 2);
    const restes = db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_candidats WHERE supprime_le IS NULL").get() as any;
    assert.equal(restes.n, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("Why me : montage, typographie des cartons et repérage de la parole", () => {
  assert.deepEqual(couperLignes("Toi… en deux mots ?", 18), ["Toi… en deux", "mots ?"]);
  assert.ok(couperLignes("Quelle est ta dernière découverte ? (appli, livre, sport, film…)", 18).every((l) => l.length <= 18 || !l.includes(" ")));
  const sortie = "[silencedetect] silence_start: 0\n[silencedetect] silence_end: 1.6 | silence_duration: 1.6\n[silencedetect] silence_start: 8.2\n";
  assert.deepEqual(bornesParole(sortie, 10), { debut: 1.35, fin: 8.6 });
  assert.deepEqual(bornesParole("", 10), { debut: 0, fin: 10 });
  // Trop peu de parole : on garde tout plutôt que de couper à l'aveugle.
  assert.deepEqual(bornesParole("silence_start: 0\nsilence_end: 9.5\n", 10), { debut: 0, fin: 10 });
});
