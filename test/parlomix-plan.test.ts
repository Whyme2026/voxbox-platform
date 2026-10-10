import { test } from "node:test";
import assert from "node:assert/strict";
// Code navigateur (JavaScript), testé tel quel.
import {
  segmentsParole, enveloppe, dureeSegments, planParlomix, themeDepuisCouleurs, choixParPersonne, choixParQuestion,
  recadrage, composerJingle, DUREES, CLIPS_MAX,
} from "../public/admin/js/montage/plan.js";

/** Niveaux par tranche de 20 ms à partir d'une description « silence / parole » en millisecondes. */
function niveaux(...morceaux: [number, "s" | "p"][]) {
  const v: number[] = [];
  for (const [ms, quoi] of morceaux) for (let i = 0; i < ms / 20; i++) v.push(quoi === "p" ? 0.7 : 0.05);
  return v;
}

test("les blancs du début et de la fin disparaissent, avec une petite marge", () => {
  const s = segmentsParole(niveaux([2000, "s"], [3000, "p"], [4000, "s"]));
  assert.deepEqual(s, [[1850, 5300]]);
});

test("un silence court au milieu est gardé, un long silence est raccourci", () => {
  const court = segmentsParole(niveaux([500, "s"], [1000, "p"], [500, "s"], [1000, "p"], [1000, "s"]));
  assert.equal(court.length, 1, "500 ms de silence : on garde la respiration");
  const long = segmentsParole(niveaux([500, "s"], [1000, "p"], [2500, "s"], [1000, "p"], [1000, "s"]));
  assert.deepEqual(long, [[350, 1800], [3850, 5300]]);
  assert.ok(dureeSegments(long) < 6000 - 2000, "plus de 2 s de blanc retirées");
});

test("sans voix détectée, la réponse est gardée entière", () => {
  assert.deepEqual(segmentsParole(niveaux([3000, "s"]), { dureeMs: 3000 }), [[0, 3000]]);
});

test("un claquement isolé n'est pas pris pour de la parole", () => {
  assert.deepEqual(segmentsParole(niveaux([1000, "s"], [40, "p"], [1000, "s"]), { dureeMs: 2040 }), [[0, 2040]]);
});

test("l'enveloppe suit le volume du son", () => {
  const f = 8000;
  const son = new Float32Array(f); // 1 s : 0,5 s de silence puis 0,5 s de son
  for (let i = f / 2; i < f; i++) son[i] = 0.3 * Math.sin(i / 3);
  const e = enveloppe(son, f, 20);
  assert.equal(e.length, 50);
  assert.ok(e[5]! < 0.1 && e[40]! > 0.6);
});

const questions = [
  { id: "q1", titre: "Le premier mot", texte: "Un seul mot ?" },
  { id: "q2", titre: "Le coup de cœur", texte: "Tiens, pas mal ?" },
];
const session = (id: string, prenom: string, cree_le: string, cabine: string, diffusion: boolean, retiree = false) => ({
  id, prenom, cree_le, consent_diffusion: diffusion, retiree_le: retiree ? cree_le : null, cabine_id: cabine, cabine_nom: cabine,
  reponses: [
    { id: `${id}-q1`, etape_id: "q1", duree_ms: 8000, son_present: true },
    { id: `${id}-q2`, etape_id: "q2", duree_ms: 9000, son_present: true },
  ],
});
const sessions = [
  session("s2", "Léa", "2026-10-10T10:05:00Z", "cab-B", false),
  session("s1", "Camille", "2026-10-10T10:00:00Z", "cab-A", true),
  session("s3", "Hugo", "2026-10-10T10:10:00Z", "cab-A", true, true),
];

test("Parlomix par personne : ses réponses, titrées par question", () => {
  const c = choixParPersonne(sessions[1]!, questions);
  assert.deepEqual(c.map((x) => x.etiquette), ["Le premier mot", "Le coup de cœur"]);
  assert.deepEqual(choixParPersonne(sessions[2]!, questions), [], "accord retiré : rien");
});

test("Parlomix par question : dans l'ordre de passage, filtrable par cabine et par accord de diffusion", () => {
  assert.deepEqual(choixParQuestion(sessions, { etape: "q2" }).map((x) => x.etiquette), ["Camille", "Léa"]);
  assert.deepEqual(choixParQuestion(sessions, { etape: "q2", cabine: "cab-B" }).map((x) => x.etiquette), ["Léa"]);
  assert.deepEqual(choixParQuestion(sessions, { etape: "q2", diffusionSeulement: true }).map((x) => x.etiquette), ["Camille"]);
  assert.deepEqual(choixParQuestion(sessions, { etape: "q2", avecPrenoms: false }).map((x) => x.etiquette), ["Avis n° 1", "Avis n° 2"]);
  const beaucoup = Array.from({ length: 30 }, (_, i) => session(`x${i}`, `P${i}`, `2026-10-10T11:${String(i).padStart(2, "0")}:00Z`, "cab-A", true));
  assert.equal(choixParQuestion(beaucoup, { etape: "q1" }).length, CLIPS_MAX);
});

test("le plan alterne cartes et réponses, avec jingle entre les réponses", () => {
  const theme = themeDepuisCouleurs({ principale: "#0F6E5A" });
  const plan = planParlomix({
    type: "personne", titre: "Camille", sousTitre: "Démo", signature: "Parlopop", format: "9:16", theme,
    clips: [
      { id: "r1", sessionId: "s1", etiquette: "Le premier mot", dureeMs: 8000, segments: [[1000, 4000]] },
      { id: "r2", sessionId: "s1", etiquette: "Le coup de cœur", detail: "Tiens ?", dureeMs: 9000, segments: [] },
    ],
  });
  assert.deepEqual(plan.sequences.map((s) => s.type === "carte" ? s.role : "clip"), ["intro", "clip", "transition", "clip", "fin"]);
  assert.equal(plan.dureeMs, DUREES.intro + 3000 + DUREES.transition + 9000 + DUREES.fin);
  assert.deepEqual(plan.dimensions, { largeur: 720, hauteur: 1280 });
  assert.deepEqual(plan.sessions, ["s1"]);
  assert.equal(theme.marque, "#0F6E5A");
  assert.equal(theme.surMarque, "#FFFFFF");
  assert.equal(theme.parole, "#F2D27A", "couleur absente : celle de Parlopop");
});

test("le recadrage 9:16 suit le visage sans sortir de l'image", () => {
  assert.deepEqual(recadrage(1280, 720), { sx: 438, sy: 0, sw: 405, sh: 720 });
  assert.equal(recadrage(1280, 720, 0).sx, 0);
  assert.equal(recadrage(1280, 720, 1).sx, 1280 - 405);
});

test("le jingle dure un peu plus d'une seconde, sans saturer, et se termine en silence", () => {
  const j = composerJingle(48000);
  assert.equal(j.length, Math.round(1.1 * 48000));
  let crete = 0;
  for (const v of j) crete = Math.max(crete, Math.abs(v));
  assert.ok(Math.abs(crete - 0.6) < 1e-6);
  assert.ok(Math.abs(j[j.length - 1]!) < 0.01);
});

test("habillage : le Parlomix reprend couleurs, bulles, polices, capitales et fonds de la campagne", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const geely = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-geely.json"), "utf8"));
  const th = themeDepuisCouleurs({ principale: "#0F6E5A" }, geely.habillage);
  assert.equal(th.marque, "#1B1F22", "l'habillage l'emporte sur la fiche client");
  assert.equal(th.parole, "#FF5841");
  assert.equal(th.bulle, "#FFFFFF");
  assert.equal(th.surBulle, "#23263F");
  assert.equal(th.policeTitres, "Michroma");
  assert.equal(th.policeTexte, "Inter");
  assert.equal(th.titresLarges, true);
  assert.equal(th.majuscules, true);
  assert.deepEqual(th.fonds?.couchant, { couleur: "#B7A6C6", texte: "#1B1F22", couleurBas: "#EDBFA6" });
  // Sans habillage : rien de plus que les couleurs.
  assert.equal(themeDepuisCouleurs({}).habille, undefined);
});

test("habillage : fond de la question et visuel du modèle choisi par la personne, sur les cartes du plan", async () => {
  const { visuelDeReponse } = await import("../public/admin/js/montage/plan.js");
  const etapesChoix = [
    { id: "aiguillage", options: [{ id: "essai", visuel: "starray" }, { id: "client", visuel: "e5" }] },
    { id: "modele-b", options: [{ id: "starray", visuel: "starray" }, { id: "e2", visuel: "e2" }] },
    { id: "connu", options: [{ id: "oui" }] },
  ];
  assert.equal(visuelDeReponse("choix", { aiguillage: "essai", "modele-b": "e2", connu: "oui" }, etapesChoix), "e2");
  assert.equal(visuelDeReponse("choix", { aiguillage: "client" }, etapesChoix), "e5");
  assert.equal(visuelDeReponse("choix", {}, etapesChoix), undefined);
  assert.equal(visuelDeReponse("e2", {}, etapesChoix), "e2");
  assert.equal(visuelDeReponse(undefined, { aiguillage: "essai" }, etapesChoix), undefined);

  const camille = { ...session("s9", "Camille", "2026-10-10T10:00:00Z", "cab-A", true), choix: { aiguillage: "essai", "modele-b": "e2" } };
  const qs = [{ id: "q1", titre: "Le premier mot", texte: "Un mot ?", fond: "couchant", visuel: "choix" }, { id: "q2", titre: "Le coup de cœur", texte: "Pourquoi ?" }];
  const clips = choixParPersonne(camille, qs, etapesChoix);
  assert.deepEqual(clips.map((c) => [c.fond, c.visuel]), [["couchant", "e2"], [undefined, undefined]]);
  const plan = planParlomix({
    type: "personne", titre: "Camille", signature: "Geely", format: "16:9", theme: themeDepuisCouleurs({}),
    clips: clips.map((c) => ({ ...c, segments: [] })),
  });
  const cartes = plan.sequences.filter((s) => s.type === "carte");
  assert.deepEqual(cartes.map((c: any) => [c.role, c.fond, c.visuel]), [["intro", "couchant", "e2"], ["transition", undefined, undefined], ["fin", "couchant", undefined]]);
  // Par question : chaque personne avec son modèle sur sa carte.
  const parQuestion = choixParQuestion([camille], { etape: "q1", question: qs[0], etapesChoix });
  assert.equal(parQuestion[0]!.visuel, "e2");
});
