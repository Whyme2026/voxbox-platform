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
