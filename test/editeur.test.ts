import { test } from "node:test";
import assert from "node:assert/strict";
// Code navigateur (JavaScript), testé tel quel : seules les fonctions sans affichage sont appelées.
import { nouvelleEtape, nouvelId, nettoyer, problemesDe, TYPES } from "../public/admin/js/editeur.js";
import { validerParcours } from "../src/parcours/schema.ts";

test("éditeur : un parcours fait d'étapes par défaut est valide tel quel", () => {
  const etapes: any[] = [];
  for (const type of ["accueil", "identification", "consentement", "question", "question", "fin"]) etapes.push(nouvelleEtape(type, etapes));
  assert.deepEqual(etapes.map((e) => e.id), ["accueil-1", "vous-1", "accord-1", "q-1", "q-2", "fin-1"]);
  const config = { version: 1, langue: "fr", etapes: etapes.map(nettoyer) };
  assert.deepEqual(validerParcours(config), []);
});

test("éditeur : chaque type d'étape a une valeur par défaut acceptée par le serveur", () => {
  for (const type of Object.keys(TYPES).filter((t) => t !== "fin")) { // la fin est vérifiée ci-dessus
    const etapes: any[] = [nouvelleEtape("consentement", [])];
    const e = nouvelleEtape(type, etapes);
    if (type === "choix") e.options.forEach((o: any) => { o.suite = "fin-1"; });
    etapes.push(e, { ...nouvelleEtape("question", [...etapes, e]) }, nouvelleEtape("fin", []));
    const pb = validerParcours({ version: 1, langue: "fr", etapes: etapes.map(nettoyer) });
    assert.deepEqual(pb.filter((p) => !p.includes("jamais atteinte")), [], `type ${type}`);
  }
});

test("éditeur : lignes vides retirées, identifiants jamais réutilisés", () => {
  assert.deepEqual(nettoyer({ id: "q-1", type: "question", pistes: ["A", " ", ""], coupDePouce: "", texte: " Bonjour " }), { id: "q-1", type: "question", pistes: ["A"], texte: "Bonjour" });
  assert.equal(nouvelId("question", [{ id: "q-1" }, { id: "q-3" }]), "q-2");
});

test("éditeur : les problèmes signalés par le serveur sont rattachés à la bonne étape", () => {
  const pb = ["étape q-1 : « texte » obligatoire", "étape 3 (q-12) : identifiant en double", "étape choix-1, option a : renvoie vers une étape inconnue ()", "La dernière étape doit être de type « fin »"];
  assert.deepEqual(problemesDe("q-1", pb), ["étape q-1 : « texte » obligatoire"]);
  assert.deepEqual(problemesDe("q-12", pb), ["étape 3 (q-12) : identifiant en double"]);
  assert.deepEqual(problemesDe("choix-1", pb).length, 1);
});
