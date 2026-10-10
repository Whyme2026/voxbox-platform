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

test("progression : aux embranchements, le chemin le plus court (une suite facultative ne compte pas)", () => {
  const geely = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-geely.json"), "utf8"));
  const m = creerMoteur(geely);
  // Branche « coup d'œil » : 3 questions, même si le visiteur peut revenir après un essai.
  assert.deepEqual(m.progression("a-regard", []), { numero: 1, total: 3 });
  // Revenu après l'essai : ses 3 premières réponses comptent, puis les 3 de l'essai.
  assert.deepEqual(m.progression("b-surprise", ["a-regard", "a-doute", "a-declic"]), { numero: 4, total: 6 });
  assert.deepEqual(m.progression("c-signature", []), { numero: 1, total: 3 });
});

test("visuel « choix » : celui de la dernière option choisie qui en a un", async () => {
  const { visuelDeLEtape } = await import("../public/cabine/js/moteur.js");
  const geely = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-geely.json"), "utf8"));
  const question = { visuel: "choix" };
  assert.equal(visuelDeLEtape(geely, question, []), null);
  assert.equal(visuelDeLEtape(geely, question, [{ etape: "aiguillage", option: "coup-oeil" }]), "e2");
  // Le modèle désigné l'emporte sur l'aiguillage ; une qualification sans visuel ne change rien.
  assert.equal(visuelDeLEtape(geely, question, [{ etape: "aiguillage", option: "coup-oeil" }, { etape: "modele-a", option: "starray" }, { etape: "connu-a", option: "non" }]), "starray");
  assert.equal(visuelDeLEtape(geely, { visuel: "e5" }, []), "e5");
  assert.equal(visuelDeLEtape(geely, {}, [{ etape: "modele-a", option: "e2" }]), null);
});
