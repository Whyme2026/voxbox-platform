import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { questions, validerParcours, type Parcours } from "../src/parcours/schema.ts";

const auto = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-automobile.json"), "utf8")) as Parcours;
const copie = (): Parcours => structuredClone(auto);

test("le parcours automobile de référence est valide", () => {
  assert.deepEqual(validerParcours(auto), []);
  assert.equal(questions(auto).length, 4);
});

test("un objet quelconque est refusé", () => {
  assert.ok(validerParcours(null).length > 0);
  assert.ok(validerParcours([]).length > 0);
  assert.ok(validerParcours({ version: 1, langue: "fr", etapes: [] }).length > 0);
});

test("un choix qui renvoie vers une étape inconnue est signalé", () => {
  const p = copie();
  const choix = p.etapes.find((e) => e.type === "choix");
  assert.ok(choix && choix.type === "choix");
  choix.options[0]!.suite = "nulle-part";
  assert.ok(validerParcours(p).some((m) => m.includes("étape inconnue")));
});

test("une question avant le consentement est refusée", () => {
  const p = copie();
  const q = p.etapes.findIndex((e) => e.type === "question");
  const [question] = p.etapes.splice(q, 1);
  p.etapes.splice(1, 0, question!);
  assert.ok(validerParcours(p).some((m) => m.includes("précéder le consentement")));
});

test("une durée de réponse hors bornes est refusée", () => {
  const p = copie();
  const q = p.etapes.find((e) => e.type === "question");
  assert.ok(q && q.type === "question");
  q.dureeMaxSec = 600;
  assert.ok(validerParcours(p).some((m) => m.includes("durée maximale")));
});

test("les identifiants en double sont signalés", () => {
  const p = copie();
  p.etapes[1]!.id = p.etapes[0]!.id;
  assert.ok(validerParcours(p).some((m) => m.includes("en double")));
});

test("une étape jamais atteinte est signalée", () => {
  const p = copie();
  // Le choix saute directement à la fin : la pause et les questions d'après deviennent inatteignables.
  const choix = p.etapes.find((e) => e.type === "choix");
  assert.ok(choix && choix.type === "choix");
  for (const o of choix.options) o.suite = "fin";
  assert.ok(validerParcours(p).some((m) => m.includes("jamais atteinte")));
});

test("le parcours doit finir par une étape de fin", () => {
  const p = copie();
  p.etapes.pop();
  assert.ok(validerParcours(p).some((m) => m.includes("« fin »")));
});

test("le parcours de démonstration Parlopop est valide", () => {
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));
  assert.deepEqual(validerParcours(demo), []);
  assert.equal(questions(demo).length, 5);
});

test("pistes et coup de pouce sont bornés", () => {
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));
  const q = demo.etapes.find((e: any) => e.type === "question");
  q.pistes = ["a", "b", "c", "d", "e", "f"];
  q.coupDePouce = "x".repeat(200);
  const pb = validerParcours(demo);
  assert.ok(pb.some((m) => m.includes("pistes")));
  assert.ok(pb.some((m) => m.includes("coupDePouce")));
});

test("les bulles d'accueil sont limitées à 3 textes courts", () => {
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));
  demo.etapes[0].bulles = ["a", "b", "c", "d"];
  assert.ok(validerParcours(demo).some((p) => p.includes("bulles")));
  demo.etapes[0].bulles = ["x".repeat(121)];
  assert.ok(validerParcours(demo).some((p) => p.includes("bulles")));
});

test("le modèle « parcours neutre » de l'éditeur est identique au parcours de démonstration", () => {
  const demo = readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8");
  const modele = readFileSync(join(import.meta.dirname, "../public/admin/modeles/parcours-neutre.json"), "utf8");
  assert.deepEqual(JSON.parse(modele), JSON.parse(demo));
});
