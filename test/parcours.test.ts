import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffusionProposee, envoiVideoPropose, questions, validerParcours, type Parcours } from "../src/parcours/schema.ts";
import { appliquerParcours, appliquerTheme, nomDuTheme, parcoursDe, themeDe } from "../public/admin/js/catalogue.js";

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

test("le parcours de la Fabrique de l'Innovation (PFA) est valide : tutoiement, Barlow, prénom seul, diffusion facultative sur l'écran du prénom", () => {
  const pfa = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-pfa.json"), "utf8"));
  assert.deepEqual(validerParcours(pfa), []);
  assert.equal(questions(pfa).length, 4);
  assert.equal(pfa.tutoiement, true);
  assert.deepEqual(pfa.habillage.polices, { titres: "barlow-condensed", texte: "barlow" });
  const id = pfa.etapes.find((e: any) => e.type === "identification");
  assert.ok(!id.demanderEmail && !id.demanderNom, "public jeune : le prénom seul");
  assert.equal(diffusionProposee(pfa), true, "réseaux sociaux : case facultative sous l'accord (14/10/2026)");
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
  delete pfa.etapes.find((e: any) => e.type === "identification").accord;
  assert.ok(validerParcours(pfa).some((m) => m.includes("consentement")));
});

test("diffusion publique proposée sur l'écran du prénom, seulement avec l'accord sur cet écran", () => {
  const pfa = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-pfa.json"), "utf8"));
  const toi = pfa.etapes.find((e: any) => e.type === "identification");
  assert.equal(toi.proposerDiffusion, true);
  assert.equal(diffusionProposee(pfa), true);
  delete toi.proposerDiffusion;
  assert.equal(diffusionProposee(pfa), false);
  toi.proposerDiffusion = true;
  delete toi.accord;
  assert.equal(diffusionProposee(pfa), false, "sans accord sur l'écran, la case n'a pas de sens");
  assert.ok(validerParcours(pfa).some((m) => m.includes("proposerDiffusion")));
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

test("catalogue : le parcours type « avis neutre » reprend le parcours de démonstration", () => {
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));
  const type = JSON.parse(readFileSync(join(import.meta.dirname, "../public/admin/modeles/parcours/avis-neutre.json"), "utf8"));
  assert.deepEqual(type.etapes, demo.etapes);
});

test("thème de base WhyMe = thème « whyme » du catalogue + parcours type « démo fun », valide", () => {
  const base = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-whyme-base.json"), "utf8"));
  const theme = JSON.parse(readFileSync(join(import.meta.dirname, "../public/admin/modeles/themes/whyme.json"), "utf8"));
  const type = JSON.parse(readFileSync(join(import.meta.dirname, "../public/admin/modeles/parcours/demo-fun.json"), "utf8"));
  assert.deepEqual(appliquerTheme(appliquerParcours({ version: 1, langue: "fr" }, type), theme), base);
  assert.deepEqual(validerParcours(base), []);
  assert.equal(base.theme, "whyme");
  assert.equal(base.ambiance, "vive");
  assert.equal(base.disposition, "centree");
  assert.equal(base.tutoiement, true);
  // Déroulé : accueil sans logo client, prénom et accord, recevoir sa vidéo (avec la diffusion), cadrage, 4 questions, fin.
  assert.deepEqual(base.etapes.map((e: any) => e.type), ["accueil", "identification", "recevoir", "cadrage", "question", "question", "question", "question", "fin"]);
  assert.equal(base.etapes[0].masquerClient, true);
  assert.equal(base.etapes.find((e: any) => e.type === "recevoir").proposerDiffusion, true);
  assert.equal(base.etapes.find((e: any) => e.type === "fin").contact, "contact@parlobox.com");
  assert.ok(base.etapes.every((e: any) => e.fond === undefined), "aucun fond dans le parcours : c'est le thème qui les donne");
  assert.deepEqual(base.habillage.fondsEcrans, { fin: "nuit" });
  const questions = base.etapes.filter((e: any) => e.type === "question");
  assert.ok(questions.every((q: any) => q.compteARebours === 10 && q.intitulePistes === "" && q.mentionTemps?.includes("{lecture}")));
  assert.equal(base.etapes.find((e: any) => e.type === "cadrage").conseils.length, 3);
  // Charte WhyMe : Inter, navy pour la marque, magenta pour le visiteur, aucune capitale forcée.
  assert.deepEqual(base.habillage.polices, { titres: "inter", texte: "inter" });
  assert.equal(base.habillage.couleurs.marque, "#242841");
  assert.equal(base.habillage.couleurs.visiteur, "#C4007A");
  assert.equal(base.habillage.titresMajuscules, false);
});

test("catalogue : chaque thème et chaque parcours type, combinés, donnent un parcours valide", () => {
  const dossier = join(import.meta.dirname, "../public/admin/modeles");
  const cat = JSON.parse(readFileSync(join(dossier, "catalogue.json"), "utf8"));
  assert.ok(cat.themes.length >= 4 && cat.parcours.length >= 2);
  for (const t of cat.themes) {
    const theme = JSON.parse(readFileSync(join(dossier, "themes", `${t.id}.json`), "utf8"));
    assert.equal(theme.id, t.id);
    assert.ok(Object.keys(theme).every((k) => ["id", "nom", "description", "ambiance", "habillage"].includes(k)), `${t.id} : un thème n'a que l'allure`);
    for (const p of cat.parcours) {
      const type = JSON.parse(readFileSync(join(dossier, "parcours", `${p.id}.json`), "utf8"));
      assert.equal(type.id, p.id);
      assert.ok(type.ambiance === undefined && type.habillage === undefined, `${p.id} : un parcours type n'a pas d'allure`);
      assert.deepEqual(validerParcours(appliquerTheme(appliquerParcours({ version: 1, langue: "fr" }, type), theme)), [], `${t.id} + ${p.id}`);
    }
  }
});

test("catalogue : changer de thème garde les étapes, changer de parcours garde le thème", () => {
  const pfa = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-pfa.json"), "utf8"));
  const whyme = JSON.parse(readFileSync(join(import.meta.dirname, "../public/admin/modeles/themes/whyme.json"), "utf8"));
  const avecWhyme = appliquerTheme(pfa, whyme);
  assert.deepEqual(avecWhyme.etapes.map((e: any) => e.id), pfa.etapes.map((e: any) => e.id));
  assert.equal(avecWhyme.habillage.couleurs.visiteur, "#C4007A");
  assert.equal(avecWhyme.disposition, "centree");
  // Les fonds et visuels propres à la PFA, inconnus du thème WhyMe, sont retirés : le parcours reste valide.
  assert.deepEqual(validerParcours(avecWhyme), []);
  const neutre = JSON.parse(readFileSync(join(import.meta.dirname, "../public/admin/modeles/parcours/avis-neutre.json"), "utf8"));
  const autreParcours = appliquerParcours(avecWhyme, neutre);
  assert.deepEqual(autreParcours.habillage, avecWhyme.habillage);
  assert.equal(autreParcours.theme, "whyme");
  assert.equal(autreParcours.disposition, undefined);
  assert.equal(avecWhyme.habillage.entete, "La Fabrique de l'Innovation", "le nom de l'évènement reste avec la campagne");
  const { entete: _e, ...allure } = avecWhyme.habillage;
  assert.deepEqual(themeDe(autreParcours), { id: "whyme", ambiance: "vive", habillage: allure });
  assert.deepEqual(parcoursDe(pfa).etapes, pfa.etapes);
  assert.equal(nomDuTheme(autreParcours, [{ id: "whyme", nom: "WhyMe" }]), "WhyMe");
  assert.equal(nomDuTheme(pfa, [{ id: "whyme", nom: "WhyMe" }]), "Propre à la campagne");
});

test("écran « recevoir », accueil sans client, contact de fin, fonds par écran : contrôlés", () => {
  const base = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-whyme-base.json"), "utf8"));
  const copie = () => structuredClone(base);
  let p = copie(); p.etapes.find((e: any) => e.type === "recevoir").bouton = "";
  assert.ok(validerParcours(p).some((x) => x.includes("bouton")));
  p = copie(); const [rec] = p.etapes.splice(2, 1); p.etapes.splice(1, 0, rec);
  assert.ok(validerParcours(p).some((x) => x.includes("après l'accord")), "pas d'e-mail avant l'accord");
  p = copie(); p.etapes[0].masquerClient = "oui";
  assert.ok(validerParcours(p).some((x) => x.includes("masquerClient")));
  p = copie(); p.etapes.at(-1).contact = "pas une adresse";
  assert.ok(validerParcours(p).some((x) => x.includes("contact")));
  p = copie(); p.habillage.fondsEcrans = { fin: "inconnu" };
  assert.ok(validerParcours(p).some((x) => x.includes("fondsEcrans.fin")));
  p = copie(); p.habillage.fondsEcrans = { ecran: "nuit" };
  assert.ok(validerParcours(p).some((x) => x.includes("type d'écran inconnu")));
  p = copie(); p.theme = "Pas Valide";
  assert.ok(validerParcours(p).some((x) => x.startsWith("theme")));
  assert.equal(diffusionProposee(base), true, "la diffusion proposée sur l'écran « recevoir » compte");
  assert.equal(envoiVideoPropose(base), true);
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));
  assert.equal(envoiVideoPropose(demo), false);
});

test("ambiance et tutoiement : facultatifs, valeurs contrôlées", () => {
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));
  assert.deepEqual(validerParcours({ ...demo, ambiance: "pop", tutoiement: true }), []);
  assert.deepEqual(validerParcours({ ...demo, ambiance: "conversation", tutoiement: false }), []);
  assert.deepEqual(validerParcours({ ...demo, ambiance: "marine" }), []);
  assert.deepEqual(validerParcours({ ...demo, ambiance: "vive" }), []);
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

test("habillage.entete : ligne de la campagne à côté du logo du client, 60 caractères au plus", () => {
  const pfa = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-pfa.json"), "utf8"));
  assert.equal(pfa.habillage.entete, "La Fabrique de l'Innovation");
  assert.deepEqual(validerParcours(pfa), []);
  for (const mauvais of ["", "   ", 12, "x".repeat(61)]) {
    const p = structuredClone(pfa);
    p.habillage.entete = mauvais;
    assert.ok(validerParcours(p).some((m) => m.startsWith("habillage.entete")), `refusé : ${JSON.stringify(mauvais)}`);
  }
});

test("nom de l'évènement : propre à la campagne, il survit au changement de thème et ne se copie pas avec le thème", () => {
  const config = { version: 1, langue: "fr", theme: "x", habillage: { entete: "Salon 2026", couleurs: { marque: "#112233" } }, etapes: [] };
  const nouveau = { id: "y", habillage: { couleurs: { marque: "#445566" }, entete: "Autre évènement" } };
  const c = appliquerTheme(config, nouveau);
  assert.equal(c.habillage.entete, "Salon 2026");
  assert.equal(c.habillage.couleurs.marque, "#445566");
  assert.equal(themeDe(config).habillage.entete, undefined);
  assert.equal(themeDe({ habillage: { entete: "Salon 2026" } }).habillage, undefined, "un habillage réduit à l'évènement n'est pas un thème");
  assert.equal(appliquerTheme({ habillage: { entete: "Salon 2026" }, etapes: [] }, { id: "parlobox" }).habillage.entete, "Salon 2026", "thème neutre : l'évènement reste");
  assert.equal(nomDuTheme({ habillage: { entete: "Salon 2026" } }, [{ id: "parlobox", nom: "Parlobox (neutre)" }]), "Parlobox (neutre)");
});

test("thème « Salon de l'auto » : l'habillage de la Fabrique de l'Innovation, sans le nom de l'évènement", () => {
  const pfa = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-pfa.json"), "utf8"));
  const theme = JSON.parse(readFileSync(join(import.meta.dirname, "../public/admin/modeles/themes/salon-auto.json"), "utf8"));
  assert.equal(theme.nom, "Salon de l'auto");
  assert.equal(theme.habillage.entete, undefined, "le nom de l'évènement appartient à la campagne");
  assert.deepEqual(theme.habillage.parlomix, { ouverture: "Le Salon de l'auto de {prenom}", jingle: "turbo", fond: "fabrique", visuel: "voiture-blanche", signature: "La Fabrique de l'Innovation" });
  // Appliqué au parcours PFA : les étapes gardent leurs rayons et leur voiture, l'évènement reste, tout est valide.
  const c = appliquerTheme(pfa, theme);
  assert.deepEqual(validerParcours(c), []);
  assert.equal(c.etapes[0].visuel, "rayons");
  assert.equal(c.etapes.at(-1).visuel, "voiture-blanche");
  assert.equal(c.habillage.entete, "La Fabrique de l'Innovation");
  const catalogue = JSON.parse(readFileSync(join(import.meta.dirname, "../public/admin/modeles/catalogue.json"), "utf8"));
  assert.equal(nomDuTheme(c, catalogue.themes), "Salon de l'auto");
});
