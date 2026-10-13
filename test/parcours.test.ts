import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffusionProposee, questions, validerParcours, type Parcours } from "../src/parcours/schema.ts";

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

test("le parcours de démonstration Parlobox est valide", () => {
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));
  assert.deepEqual(validerParcours(demo), []);
  assert.equal(questions(demo).length, 5);
});

test("le parcours de la Fabrique de l'Innovation (PFA) est valide : tutoiement, Barlow, prénom seul, sans diffusion publique", () => {
  const pfa = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-pfa.json"), "utf8"));
  assert.deepEqual(validerParcours(pfa), []);
  assert.equal(questions(pfa).length, 4);
  assert.equal(pfa.tutoiement, true);
  assert.deepEqual(pfa.habillage.polices, { titres: "barlow-condensed", texte: "barlow" });
  const id = pfa.etapes.find((e: any) => e.type === "identification");
  assert.ok(!id.demanderEmail && !id.demanderNom, "public jeune : le prénom seul");
  assert.equal(diffusionProposee(pfa), false, "public jeune : pas de diffusion publique");
});

test("disposition des questions : « cote » par défaut, « centree » pour la PFA, toute autre valeur refusée", () => {
  const pfa = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-pfa.json"), "utf8"));
  assert.equal(pfa.disposition, "centree");
  assert.equal(auto.disposition, undefined);
  pfa.disposition = "gauche";
  assert.ok(validerParcours(pfa).some((m) => m.includes("disposition")));
});

test("l'accord peut être donné sur l'écran du prénom ; sans lui ni étape de consentement, le parcours est refusé", () => {
  const pfa = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-pfa.json"), "utf8"));
  assert.equal(pfa.etapes.find((e: any) => e.type === "identification").accord, true);
  assert.equal(pfa.etapes.some((e: any) => e.type === "consentement"), false);
  assert.deepEqual(validerParcours(pfa), []);
  assert.equal(diffusionProposee(pfa), false, "pas de diffusion publique sans étape de consentement");
  delete pfa.etapes.find((e: any) => e.type === "identification").accord;
  assert.ok(validerParcours(pfa).some((m) => m.includes("consentement")));
});

test("une police inconnue est refusée dans l'habillage", () => {
  const pfa = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-pfa.json"), "utf8"));
  pfa.habillage.polices.titres = "comic-sans";
  assert.ok(validerParcours(pfa).some((m) => m.includes("habillage.polices.titres")));
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

test("ambiance et tutoiement : facultatifs, valeurs contrôlées", () => {
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));
  assert.deepEqual(validerParcours({ ...demo, ambiance: "pop", tutoiement: true }), []);
  assert.deepEqual(validerParcours({ ...demo, ambiance: "conversation", tutoiement: false }), []);
  assert.deepEqual(validerParcours({ ...demo, ambiance: "marine" }), []);
  assert.ok(validerParcours({ ...demo, ambiance: "disco" }).some((p) => p.includes("ambiance")));
  assert.ok(validerParcours({ ...demo, tutoiement: "oui" }).some((p) => p.includes("tutoiement")));
});

test("le parcours « Fabrice » (ambiance pop, tutoiement) est valide", () => {
  const fab = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-fabrice.json"), "utf8"));
  assert.deepEqual(validerParcours(fab), []);
  assert.equal(fab.ambiance, "pop");
  assert.equal(fab.tutoiement, true);
  assert.equal(questions(fab).length, 6);
  assert.equal(diffusionProposee(fab), false);
});

test("le parcours « Alexandre » (ambiance marine, tutoiement, un visuel par écran) est valide", () => {
  const alex = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-alexandre.json"), "utf8"));
  assert.deepEqual(validerParcours(alex), []);
  assert.equal(alex.ambiance, "marine");
  assert.equal(alex.tutoiement, true);
  assert.equal(questions(alex).length, 4);
  const ids = new Set(alex.habillage.visuels.map((v: { id: string }) => v.id));
  for (const e of alex.etapes) if (e.visuel) assert.ok(ids.has(e.visuel), `visuel ${e.visuel} défini`);
});

// ------------------------------------------------------------------ habillage de campagne

const geely = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-geely.json"), "utf8")) as Parcours;
const copieGeely = (): Parcours => structuredClone(geely);

test("le parcours Geely (habillage, trois branches) est valide : trois questions vidéo par branche", () => {
  assert.deepEqual(validerParcours(geely), []);
  assert.equal(questions(geely).length, 9);
  for (const branche of ["a-", "b-", "c-"]) assert.equal(questions(geely).filter((q) => q.id.startsWith(branche)).length, 3);
});

test("habillage : un fond ou un visuel inconnu est signalé, sur une étape comme sur une option", () => {
  const p = copieGeely();
  p.etapes[0]!.fond = "nuit";
  const choix = p.etapes.find((e) => e.type === "choix");
  assert.ok(choix && choix.type === "choix");
  choix.options[0]!.visuel = "fusee";
  const pb = validerParcours(p);
  assert.ok(pb.some((m) => m.includes("fond inconnu (nuit)")));
  assert.ok(pb.some((m) => m.includes("visuel inconnu (fusee)")));
});

test("habillage : « choix » vaut le visuel de la dernière option choisie, sur une étape seulement", () => {
  const p = copieGeely();
  const choix = p.etapes.find((e) => e.type === "choix");
  assert.ok(choix && choix.type === "choix");
  choix.options[0]!.visuel = "choix";
  assert.ok(validerParcours(p).some((m) => m.includes("visuel inconnu (choix)")));
  const v = copieGeely();
  v.habillage!.visuels![0]!.id = "choix";
  assert.ok(validerParcours(v).some((m) => m.includes("réservé")));
});

test("habillage : couleurs, polices et clés inconnues sont contrôlées", () => {
  const p = copieGeely();
  p.habillage!.couleurs!.visiteur = "orange";
  (p.habillage!.polices as any).titres = "comic-sans";
  (p.habillage as any).fond = "#FFFFFF";
  p.habillage!.fonds![0]!.couleurBas = "#12";
  const pb = validerParcours(p);
  assert.ok(pb.some((m) => m.startsWith("habillage.couleurs.visiteur")));
  assert.ok(pb.some((m) => m.startsWith("habillage.polices.titres")));
  assert.ok(pb.some((m) => m.includes("clé inconnue « fond »")));
  assert.ok(pb.some((m) => m.includes("couleurBas")));
});

test("habillage : un visuel ne peut contenir ni script ni ressource externe", () => {
  const svg = (contenu: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${contenu}</svg>`;
  const essai = (contenu: string) => {
    const p = copieGeely();
    p.habillage!.visuels![0]!.svg = svg(contenu);
    return validerParcours(p);
  };
  for (const piege of [
    "<script>alert(1)</script>", '<rect onload="alert(1)"/>', '<image href="https://exemple.fr/x.png"/>',
    '<a href="javascript:alert(1)"><rect/></a>', '<rect fill="url(https://exemple.fr/x)"/>', "<foreignObject><div/></foreignObject>",
    '<use xlink:href="https://exemple.fr/s.svg#a"/>', "<style>@import url(x.css)</style>",
  ]) {
    assert.ok(essai(piege).some((m) => m.includes("ni script")), piege);
  }
  // Dégradés et renvois internes restent permis.
  assert.deepEqual(essai('<defs><linearGradient id="g"><stop offset="0" stop-color="#FFF"/></linearGradient></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/>'), []);
  const p = copieGeely();
  p.habillage!.visuels![0]!.svg = "<div>pas un svg</div>";
  assert.ok(validerParcours(p).some((m) => m.includes("SVG autonome")));
  p.habillage!.visuels![0]!.svg = svg("x".repeat(41_000));
  assert.ok(validerParcours(p).some((m) => m.includes("trop lourd")));
});

test("question : mention du temps sous la question, texte court contrôlé", () => {
  const pfa = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-pfa.json"), "utf8"));
  assert.ok(questions(pfa).every((q: any) => q.mentionTemps === "Tu as {lecture} s pour réfléchir, {duree} s pour répondre."));
  const q = pfa.etapes.find((e: any) => e.type === "question");
  for (const [valeur, ok] of [["", false], ["   ", false], [42, false], ["x".repeat(101), false], ["{lecture} s pour réfléchir, {duree} s pour répondre", true]] as const) {
    q.mentionTemps = valeur;
    assert.equal(validerParcours(pfa).some((p) => p.includes("mentionTemps")), !ok, String(valeur));
  }
});
