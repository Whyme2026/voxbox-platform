import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Code navigateur (JavaScript), testé tel quel.
import { creerMoteur, diffusionProposee } from "../public/cabine/js/moteur.js";

const auto = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-automobile.json"), "utf8"));

test("le moteur déroule le parcours automobile dans l'ordre", () => {
  const m = creerMoteur(auto);
  const vus: string[] = [];
  let id: string | null = m.premiere();
  while (id) {
    vus.push(id);
    id = m.etape(id).type === "choix" ? m.suivante(id, "berline") : m.suivante(id);
  }
  assert.deepEqual(vus, [
    "accueil", "identite", "accord", "cadrage", "q-attentes", "vehicule", "pause-essai",
    "q-premiere-impression", "q-surprise", "q-recommandation", "fin",
  ]);
});

test("un choix sans option valide est refusé", () => {
  const m = creerMoteur(auto);
  assert.throws(() => m.suivante("vehicule"));
  assert.throws(() => m.suivante("vehicule", "camion"));
});

test("la progression compte les questions du chemin", () => {
  const m = creerMoteur(auto);
  assert.deepEqual(m.progression("q-attentes", []), { numero: 1, total: 4 });
  assert.deepEqual(m.progression("q-surprise", ["q-attentes", "q-premiere-impression"]), { numero: 3, total: 4 });
});

test("la fin n'a pas de suite", () => {
  assert.equal(creerMoteur(auto).suivante("fin"), null);
});

test("option diffusion lue depuis le parcours", () => {
  assert.equal(diffusionProposee(auto), true);
  const sans = structuredClone(auto);
  for (const e of sans.etapes) delete e.proposerDiffusion;
  assert.equal(diffusionProposee(sans), false);
});

test("le prénom s'insère dans les textes, et disparaît proprement s'il est inconnu", async () => {
  const { personnaliser } = await import("../public/cabine/js/moteur.js");
  assert.equal(personnaliser("Merci {prenom}, c'est dans la boîte !", "Camille"), "Merci Camille, c'est dans la boîte !");
  assert.equal(personnaliser("Merci {prenom}, c'est dans la boîte !", ""), "Merci, c'est dans la boîte !");
  assert.equal(personnaliser("Merci {prenom} !", "  "), "Merci !");
  assert.equal(personnaliser("Sans emplacement", "Léa"), "Sans emplacement");
});

test("le chiffre de tête d'une consigne est isolé pour être affiché en grand", async () => {
  const { decouperConsigne } = await import("../public/cabine/js/moteur.js");
  assert.deepEqual(decouperConsigne("5 questions, une à la fois."), { chiffre: "5", reste: "questions, une à la fois." });
  assert.deepEqual(decouperConsigne("30 s pour répondre."), { chiffre: "30 s", reste: "pour répondre." });
  assert.deepEqual(decouperConsigne("30 secondes maximum."), { chiffre: "30", reste: "secondes maximum." });
  assert.deepEqual(decouperConsigne("Pas de mauvaise réponse."), { chiffre: null, reste: "Pas de mauvaise réponse." });
});
