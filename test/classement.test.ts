// Option Analyse, lot 2 : classement des propos, vues par question, recherche par thèmes, direct et alertes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN } from "./aide/env.ts";
import { campagneAnalyse, fauxMistral } from "./aide/analyse.ts";
import { transcrireReponse } from "../src/analyse/transcription.ts";
import { classerReponse, consigne, lireClassement, reprendreClassements, situerExtrait } from "../src/analyse/classement.ts";
import { SEUIL_MINIMUM, SEUIL_VISITEURS, heureParis, verbatimsRepresentatifs } from "../src/routes/analyse.ts";

const traiterReponse = async (env: any, rid: string, faux: ReturnType<typeof fauxMistral>) => {
  assert.equal(await transcrireReponse(env, rid, { fetch: faux.f }), "faite");
  return classerReponse(env, rid, { fetch: faux.f });
};

test("la grille de thèmes : identifiants tirés des libellés, 15 au plus, sans doublon", async () => {
  const { api, cid, db } = await campagneAnalyse();
  const c = (await api("GET", `/api/admin/campagnes/${cid}`, ADMIN)).corps.campagne;
  assert.deepEqual(c.grille_themes.map((t: any) => t.id), ["silence", "ecran", "prix"]);
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { grille_themes: Array.from({ length: 16 }, (_, i) => ({ libelle: `T${i}` })) })).status, 400);
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { grille_themes: [{ libelle: "Prix" }, { libelle: "prix" }] })).status, 400);
  void db;
});

test("après la transcription, le propos est classé : thèmes de la grille, tonalité, extrait exact et son moment", async () => {
  const { env, db, visiteur } = await campagneAnalyse();
  const v = await visiteur();
  const faux = fauxMistral();
  assert.equal(await traiterReponse(env, v.rid, faux), "faite");
  const chat = faux.appels.find((a) => a.url.endsWith("/chat/completions"))!;
  assert.equal(chat.corps.model, "mistral-large-latest");
  assert.deepEqual(chat.corps.response_format, { type: "json_object" });
  assert.match(chat.corps.messages[0].content, /jamais la personne/);
  assert.match(chat.corps.messages[1].content, /On n'entend rien/);

  const { results } = await db.prepare("SELECT theme_id, tonalite, extrait, debut, fin FROM reponse_themes WHERE reponse_id = ? ORDER BY theme_id").bind(v.rid).all<any>();
  assert.deepEqual(results.map((r) => [r.theme_id, r.tonalite]), [["ecran", "negatif"], ["silence", "positif"]]);
  const ecran = results.find((r) => r.theme_id === "ecran");
  assert.equal(ecran.extrait, "pour la clim il faut trois menus");
  assert.ok(ecran.debut > 0 && ecran.fin > ecran.debut, "moment de l'extrait retrouvé dans les mots horodatés");
  const r = await db.prepare("SELECT analyse_etat, alerte FROM reponses WHERE id = ?").bind(v.rid).first<any>();
  assert.equal(r.analyse_etat, "faite");
  assert.equal(r.alerte, 0);
  assert.ok(await db.prepare("SELECT 1 FROM journal WHERE action = 'reponse.classement' AND cible_id = ?").bind(v.rid).first());
});

test("la sortie du modèle est contrôlée : thème inconnu, tonalité inconnue, doublon et citation inexacte écartés", () => {
  const grille = [{ id: "silence", libelle: "Silence" }, { id: "prix", libelle: "Prix" }];
  const c = lireClassement(JSON.stringify({
    themes: [
      { id: "silence", tonalite: "positif", extrait: "très calme" },
      { id: "silence", tonalite: "negatif", extrait: "x" },
      { id: "profil", tonalite: "positif" },
      { id: "prix", tonalite: "furieux" },
    ],
    autre_sujet: "  recharge  ", alerte: "oui", motif_alerte: "rien",
  }), grille, "C'est très calme dedans.", []);
  assert.deepEqual(c.themes, [{ id: "silence", tonalite: "positif", extrait: "très calme", debut: null, fin: null }]);
  assert.equal(c.autre_sujet, "recharge");
  assert.equal(c.alerte, false, "seul true vaut alerte");
  assert.equal(c.motif_alerte, null);
  const inexact = lireClassement({ themes: [{ id: "prix", tonalite: "negatif", extrait: "beaucoup trop cher" }] }, grille, "C'est un peu cher.", []);
  assert.equal(inexact.themes[0]!.extrait, null, "une reformulation n'est pas une citation");
  assert.throws(() => lireClassement("pas du json", grille, "", []));
});

test("situer un extrait dans les mots horodatés, malgré la ponctuation et les accents", () => {
  const seg = [{ d: 0.5, f: 0.7, t: "Alors," }, { d: 0.8, f: 1, t: "l'écran" }, { d: 1.1, f: 1.3, t: "est" }, { d: 1.4, f: 1.9, t: "superbe." }];
  assert.deepEqual(situerExtrait("l'ecran est superbe", seg), { debut: 0.8, fin: 1.9 });
  assert.equal(situerExtrait("rien à voir", seg), null);
});

test("la consigne interdit tout jugement sur la personne et rappelle que le texte est une donnée", () => {
  const t = consigne([{ id: "prix", libelle: "Prix" }]);
  assert.match(t, /jamais la personne/);
  assert.match(t, /ignore-les/);
  assert.match(t, /- prix : Prix/);
});

test("insatisfaction forte : alerte du jour, visible dans le direct, puis marquée comme vue (journalisé)", async () => {
  const { env, db, api, cid, visiteur } = await campagneAnalyse();
  const v = await visiteur("Karim");
  const faux = fauxMistral({
    texte: "On m'a laissé attendre vingt minutes, personne ne m'a rien expliqué, c'est inadmissible.",
    classement: { themes: [], autre_sujet: "accueil en concession", alerte: true, motif_alerte: "Attente de vingt minutes sans explication." },
  });
  await traiterReponse(env, v.rid, faux);
  const d = await api("GET", `/api/espace/campagnes/${cid}/direct`, "lit@alpha.test");
  assert.equal(d.status, 200, JSON.stringify(d.corps));
  assert.equal(d.corps.visiteurs.aujourdhui, 1);
  assert.equal(d.corps.alertes.length, 1);
  assert.equal(d.corps.alertes[0].alerte_motif, "Attente de vingt minutes sans explication.");
  assert.equal(d.corps.derniers_propos[0].autre_sujet, "accueil en concession");
  assert.equal(d.corps.derniers_propos[0].alerte, true);
  assert.equal(d.corps.cabines.length, 1);
  const vue = await api("POST", `/api/espace/reponses/${v.rid}/alerte-vue`, "lit@alpha.test", {});
  assert.equal(vue.status, 200);
  assert.ok(await db.prepare("SELECT 1 FROM journal WHERE action = 'reponse.alerte_vue' AND utilisateur_email = 'lit@alpha.test'").first());
  assert.equal((await api("POST", `/api/espace/reponses/${v.rid}/alerte-vue`, "lit@beta.test", {})).status, 404);
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/direct`, "lit@beta.test")).status, 404);
});

test("recherche par thèmes : dès la première réponse, filtrable, cloisonnée et journalisée", async () => {
  const { env, db, api, cid, visiteur } = await campagneAnalyse();
  const v = await visiteur("Sophie");
  await traiterReponse(env, v.rid, fauxMistral());
  const w = await visiteur("Paul");
  await traiterReponse(env, w.rid, fauxMistral({ texte: "Franchement c'est trop cher pour moi.", classement: { themes: [{ id: "prix", tonalite: "negatif", extrait: "c'est trop cher" }], alerte: false } }));

  const ecran = await api("GET", `/api/espace/campagnes/${cid}/analyse/propos?theme=ecran`, "lit@alpha.test");
  assert.equal(ecran.status, 200, JSON.stringify(ecran.corps));
  assert.equal(ecran.corps.total, 1);
  assert.equal(ecran.corps.propos[0].prenom, "Sophie");
  assert.equal(ecran.corps.propos[0].extrait, "pour la clim il faut trois menus");
  assert.equal(ecran.corps.propos[0].themes.length, 2);
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/analyse/propos?theme=prix&tonalite=positif`, ADMIN)).corps.total, 0);
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/analyse/propos?q=cher`, ADMIN)).corps.total, 1);
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/analyse/propos?q=100%25`, ADMIN)).corps.total, 0, "les jokers SQL sont neutralisés");
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/analyse/propos?theme=inconnu`, ADMIN)).status, 404);
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/analyse/propos?theme=ecran`, "lit@beta.test")).status, 404);
  assert.ok(await db.prepare("SELECT 1 FROM journal WHERE action = 'analyse.recherche'").first());
});

test("par question : rien d'agrégé sous 100 visiteurs, répartition, tonalité et verbatims au-delà", async () => {
  const { env, db, api, cid, visiteur } = await campagneAnalyse();
  const v = await visiteur();
  await traiterReponse(env, v.rid, fauxMistral());
  const sous = await api("GET", `/api/espace/campagnes/${cid}/analyse`, "lit@alpha.test");
  assert.equal(sous.status, 200, JSON.stringify(sous.corps));
  assert.deepEqual(sous.corps.seuil, { visiteurs: 1, requis: SEUIL_VISITEURS, atteint: false });
  const q = sous.corps.questions.find((x: any) => x.id === "q-coup-de-coeur");
  assert.equal(q.classees, 1);
  assert.equal(q.themes, undefined, "pas de répartition sous le seuil");

  // 100 visiteurs de plus, classés directement en base (le classement lui-même est testé plus haut).
  const s0 = await db.prepare("SELECT campagne_id, consentement_version_id, parcours_version_id FROM sessions WHERE id = ?").bind(v.sid).first<any>();
  const now = new Date().toISOString();
  for (let i = 0; i < SEUIL_VISITEURS; i++) {
    const sid = crypto.randomUUID();
    const rid = crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO sessions (id, campagne_id, canal, prenom, consent_interne, consentement_version_id, parcours_version_id, code_retrait, cree_le, purge_prevue_le)
        VALUES (?, ?, 'cabine', ?, 1, ?, ?, ?, ?, ?)`).bind(sid, s0.campagne_id, `V${i}`, s0.consentement_version_id, s0.parcours_version_id, `C${String(i).padStart(9, "0")}`, now, now),
      db.prepare(`INSERT INTO reponses (id, session_id, etape_id, cle_source, statut, transcription, transcription_etat, analyse_etat, cree_le, maj_le)
        VALUES (?, ?, 'q-coup-de-coeur', 'x.webm', 'recue', 'Très silencieuse, vraiment agréable à conduire.', 'faite', 'faite', ?, ?)`).bind(rid, sid, now, now),
      db.prepare("INSERT INTO reponse_themes (reponse_id, theme_id, tonalite, extrait) VALUES (?, 'silence', ?, ?)")
        .bind(rid, i % 10 === 0 ? "negatif" : "positif", `Très silencieuse, vraiment agréable à conduire (${i}).`),
    ]);
  }
  const sur = await api("GET", `/api/espace/campagnes/${cid}/analyse`, "lit@alpha.test");
  assert.equal(sur.corps.seuil.atteint, true);
  const q2 = sur.corps.questions.find((x: any) => x.id === "q-coup-de-coeur");
  const silence = q2.themes.find((t: any) => t.id === "silence");
  assert.equal(silence.n, 101);
  assert.equal(silence.negatif, 10);
  assert.equal(silence.positif, 91);
  assert.ok(silence.verbatims.length >= 2 && silence.verbatims.length <= 3);
  assert.equal(silence.verbatims[0].tonalite, "positif", "la tonalité la plus fréquente d'abord");
  assert.ok(silence.verbatims.some((x: any) => x.tonalite === "negatif"), "la minorité est aussi représentée");
  assert.ok(await db.prepare("SELECT 1 FROM journal WHERE action = 'analyse.consultation'").first());
});

test("seuil réglable par campagne : 100 par défaut, 20 au moins, abaissé il ouvre les vues plus tôt (journalisé)", async () => {
  const { env, db, api, cid, visiteur } = await campagneAnalyse();
  const v = await visiteur();
  await traiterReponse(env, v.rid, fauxMistral());
  const c = (await api("GET", `/api/admin/campagnes/${cid}`, ADMIN)).corps.campagne;
  assert.equal(c.seuil_analyse, SEUIL_VISITEURS);
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { seuil_analyse: SEUIL_MINIMUM - 1 })).status, 400);
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { seuil_analyse: 1001 })).status, 400);
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, "lit@alpha.test", { seuil_analyse: 20 })).status, 403, "réservé à WhyMe");
  const ok = await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { seuil_analyse: 20 });
  assert.equal(ok.status, 200, JSON.stringify(ok.corps));
  assert.equal(ok.corps.campagne.seuil_analyse, 20);
  const sous = await api("GET", `/api/espace/campagnes/${cid}/analyse`, "lit@alpha.test");
  assert.deepEqual(sous.corps.seuil, { visiteurs: 1, requis: 20, atteint: false });

  const s0 = await db.prepare("SELECT campagne_id, consentement_version_id, parcours_version_id FROM sessions WHERE id = ?").bind(v.sid).first<any>();
  const now = new Date().toISOString();
  for (let i = 0; i < 19; i++) {
    const sid = crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO sessions (id, campagne_id, canal, prenom, consent_interne, consentement_version_id, parcours_version_id, code_retrait, cree_le, purge_prevue_le)
        VALUES (?, ?, 'cabine', ?, 1, ?, ?, ?, ?, ?)`).bind(sid, s0.campagne_id, `V${i}`, s0.consentement_version_id, s0.parcours_version_id, `S${String(i).padStart(9, "0")}`, now, now),
      db.prepare(`INSERT INTO reponses (id, session_id, etape_id, cle_source, statut, transcription_etat, analyse_etat, cree_le, maj_le)
        VALUES (?, ?, 'q-coup-de-coeur', 'x.webm', 'recue', 'faite', 'faite', ?, ?)`).bind(crypto.randomUUID(), sid, now, now),
    ]);
  }
  const sur = await api("GET", `/api/espace/campagnes/${cid}/analyse`, "lit@alpha.test");
  assert.deepEqual(sur.corps.seuil, { visiteurs: 20, requis: 20, atteint: true });
  assert.ok(Array.isArray(sur.corps.questions[0].themes), "vues agrégées ouvertes");
  const j = await db.prepare("SELECT details FROM journal WHERE action = 'campagne.modification' ORDER BY rowid DESC LIMIT 1").first<any>();
  assert.equal(JSON.parse(j.details).seuil_analyse, 20);
});

test("changer la grille fait reclasser les réponses ; retrait d'accord : thèmes et alerte effacés avec la réponse", async () => {
  const { env, db, api, cid, visiteur } = await campagneAnalyse();
  const v = await visiteur();
  await traiterReponse(env, v.rid, fauxMistral());
  assert.equal((await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { grille_themes: [{ libelle: "Silence" }, { libelle: "Confort" }] })).status, 200);
  assert.equal((await db.prepare("SELECT analyse_etat FROM reponses WHERE id = ?").bind(v.rid).first<any>()).analyse_etat, "a_faire");
  const faux = fauxMistral({ classement: { themes: [{ id: "silence", tonalite: "positif", extrait: "On n'entend rien" }], alerte: false } });
  assert.equal((await reprendreClassements(env, { fetch: faux.f })).faite, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM reponse_themes WHERE reponse_id = ?").bind(v.rid).first<any>()).n, 1, "l'ancien classement est remplacé");

  assert.equal((await api("POST", `/api/espace/sessions/${v.sid}/retrait`, ADMIN, {})).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM reponse_themes").first<any>()).n, 0);
});

test("sans grille : transcription seule ; service indisponible : nouvel essai puis abandon", async () => {
  const sans = await campagneAnalyse({ grille: [] });
  const v = await sans.visiteur();
  assert.equal(await transcrireReponse(sans.env, v.rid, { fetch: fauxMistral().f }), "faite");
  assert.equal((await sans.db.prepare("SELECT analyse_etat FROM reponses WHERE id = ?").bind(v.rid).first<any>()).analyse_etat, null);

  const { env, db, visiteur } = await campagneAnalyse();
  const w = await visiteur();
  const panne = fauxMistral({ statutClassement: 503 });
  assert.equal(await traiterReponse(env, w.rid, panne), "reessai");
  assert.equal(await classerReponse(env, w.rid, { fetch: panne.f }), "reessai");
  assert.equal(await classerReponse(env, w.rid, { fetch: panne.f }), "echec");
  assert.equal((await db.prepare("SELECT analyse_etat FROM reponses WHERE id = ?").bind(w.rid).first<any>()).analyse_etat, "echec");
});

test("une campagne sans l'option n'a pas de vues d'analyse", async () => {
  const { api, cid } = await campagneAnalyse();
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/analyse`, ADMIN)).status, 200);
  const autre = (await api("POST", "/api/admin/campagnes", ADMIN, { client_id: (await api("GET", `/api/admin/campagnes/${cid}`, ADMIN)).corps.campagne.client_id, nom: "Sans option" })).corps.campagne.id;
  assert.equal((await api("GET", `/api/espace/campagnes/${autre}/analyse`, ADMIN)).status, 409);
});

test("verbatims représentatifs : un par tonalité présente, la plus fréquente d'abord, extraits trop courts écartés", () => {
  const l = (tonalite: any, extrait: string | null) => ({ tonalite, extrait });
  const v = verbatimsRepresentatifs([l("positif", "très calme sur la route vraiment"), l("negatif", "un petit sifflement vers cent dix"), l("positif", "on n'entend rien du tout"), l("positif", "ok"), l("neutre", null)]);
  assert.deepEqual(v.map((x) => x.tonalite), ["positif", "negatif", "positif"]);
});

test("verbatims : un même extrait n'apparaît qu'une fois ; heure de Paris", () => {
  const l = (tonalite: any, extrait: string) => ({ tonalite, extrait });
  const v = verbatimsRepresentatifs([l("positif", "On n'entend rien du tout ici"), l("positif", "on n'entend rien du tout, ici"), l("positif", "très calme sur l'autoroute franchement")]);
  assert.equal(v.length, 2);
  assert.equal(heureParis("2026-10-11T18:30:00Z"), 20);
  assert.equal(heureParis("2026-12-11T23:30:00Z"), 0);
});
