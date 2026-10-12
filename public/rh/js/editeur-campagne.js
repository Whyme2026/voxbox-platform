// @ts-check
// Éditeur de campagne Why me (espace RH) : l'équivalent, pour l'interview candidat, de l'éditeur de parcours de
// Parlorama. Événement, accueil, question d'essai, questions (3 à 5, à ajouter, déplacer, dupliquer), familles de
// métiers, entreprises proposées, réglages. Vérification par le serveur (mêmes règles qu'à l'enregistrement),
// aperçu en direct sur un téléphone (écran du candidat et plan « question » du film), aperçu complet du parcours
// dans un nouvel onglet sans rien enregistrer, questionnaires types (appliquer, enregistrer) et le fichier JSON en mode
// expert. Sert aussi à modifier un questionnaire type (pourModele : ni événement ni entreprises).

import { h } from "../../admin/js/dom.js";

/** Au-delà, la bulle du film affiche le titre court (même règle que montage/monter.ts, texteBulle). */
export const BULLE_MAX = 80;
const QUESTIONS_MIN = 3;
const QUESTIONS_MAX = 5;

/** Identifiant libre en minuscules, chiffres et tirets (il ne change plus : les réponses y sont rattachées). */
export function identifiant(/** @type {string} */ base, /** @type {Set<string>} */ pris) {
  const racine = base.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "q";
  let id = racine;
  for (let n = 2; pris.has(id); n++) id = `${racine}-${n}`;
  return id;
}

/** Texte de la bulle du plan « question » dans le film. */
export const texteBulle = (/** @type {{ texte?: string, carton?: string }} */ q) => {
  const t = (q.texte ?? "").trim();
  return t && t.length <= BULLE_MAX ? t : (q.carton ?? "").trim() || t;
};

/**
 * @param {{
 *   config: any,
 *   entreprises: { id: string, nom: string }[],
 *   choisies: string[],
 *   lectureSeule: boolean,
 *   valider: (config: any) => Promise<string[]>,
 *   enregistrer: (config: any, entreprises: string[]) => Promise<void>,
 *   apercu: (config: any, entreprises: string[]) => Promise<void>,
 *   styles: { id: string, nom: string, description: string, couleurs: Record<string, string>, motif: string | null }[],
 *   modeles?: { id: string, nom: string, description: string, config: any }[],
 *   enregistrerModele?: (nom: string, config: any) => Promise<void>,
 *   pourModele?: boolean,
 *   apresEnregistrement?: () => void,
 * }} o
 */
export function editeurCampagne(o) {
  /** @type {any} */
  let c = structuredClone(o.config);
  c.accueil ??= { titre: "", message: "" };
  c.questionEssai ??= { texte: "", dureeSec: 6 };
  c.familles ??= [];
  c.questions ??= [];
  c.tutoiement ??= true;
  c.style ??= "bulles";
  if (o.pourModele) c.evenement ||= "Votre événement";
  const choisies = new Set(o.choisies);
  const lecture = o.lectureSeule;
  /** @type {string[]} */ let problemes = [];
  let modifie = false;
  let minuterie = 0;
  /** Écran montré dans le téléphone : "accueil", "essai", ou l'index d'une question. */
  /** @type {string | number} */ let vue = "accueil";
  let ouverte = /** @type {number | null} */ (null);

  const verification = h("div", { class: "verification" });
  const etat = h("span", { class: "etat-editeur" }, lecture ? "Lecture seule : repassez la campagne en brouillon pour la modifier." : "");
  const boutonEnregistrer = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "bouton action", disabled: true, hidden: lecture }, "Enregistrer le questionnaire"));
  const telephone = h("div", { class: "telephone", "aria-label": "Aperçu sur le téléphone du candidat" });
  const film = h("div", { class: "film-question", "aria-label": "Plan « question » dans le film" });
  const zoneQuestions = h("ol", { class: "editeur-etapes" });
  const zoneFamilles = h("div", { class: "pile", style: "gap:6px" });

  const config = () => ({
    ...c,
    organisateur: c.organisateur || undefined,
    familles: c.familles.filter((/** @type {any} */ f) => f.nom?.trim()),
    questions: c.questions.map((/** @type {any} */ q) => ({ ...q, carton: q.carton?.trim() || undefined })),
  });

  const verifier = () => {
    if (lecture) { verification.replaceChildren(h("span", { class: "detail-verif" }, "Lecture seule.")); return; }
    clearTimeout(minuterie);
    verification.replaceChildren(h("span", { class: "detail-verif" }, "Vérification…"));
    minuterie = window.setTimeout(async () => {
      try { problemes = await o.valider(config()); } catch { problemes = ["Vérification impossible pour l'instant (connexion)."]; }
      dessinerVerification();
    }, 350);
  };
  const changer = () => { modifie = true; etat.textContent = "Modifications non enregistrées"; verifier(); dessinerTelephone(); };

  function dessinerVerification() {
    boutonEnregistrer.disabled = lecture || problemes.length > 0 || !modifie;
    // Les entreprises ne bloquent pas l'enregistrement : elles ne sont exigées qu'à l'ouverture de la campagne.
    const sansEntreprise = choisies.size || o.pourModele ? null : h("p", { class: "detail-verif", style: "margin:4px 0 0" }, "Aucune entreprise cochée : il en faudra au moins une pour ouvrir la campagne.");
    verification.replaceChildren(problemes.length
      ? h("div", { class: "pile", style: "gap:6px" }, h("strong", { class: "verif-ko" }, `${problemes.length} point${problemes.length > 1 ? "s" : ""} à corriger`),
        h("ul", { class: "erreurs" }, ...problemes.map((p) => h("li", {}, p))))
      : h("strong", { class: "verif-ok" }, "Questionnaire valide"), ...(sansEntreprise ? [sansEntreprise] : []));
  }

  /** Champ texte, texte long ou nombre lié à obj[cle]. */
  function champ(/** @type {any} */ obj, /** @type {string} */ cle, /** @type {string} */ libelle, /** @type {{ type?: "texte" | "long" | "nombre", max?: number, min?: number, maxNb?: number, aide?: string, surSaisie?: () => void }} */ opt = {}) {
    const attrs = { disabled: lecture, maxlength: opt.max, min: opt.min, max: opt.maxNb };
    const entree = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (opt.type === "long"
      ? h("textarea", { ...attrs, rows: 2 }, obj[cle] ?? "")
      : h("input", { ...attrs, type: opt.type === "nombre" ? "number" : "text", value: obj[cle] ?? null }));
    entree.addEventListener("input", () => {
      obj[cle] = opt.type === "nombre" ? (entree.value === "" ? undefined : Number(entree.value)) : entree.value;
      opt.surSaisie?.();
      changer();
    });
    return h("label", { class: "champ" }, libelle, entree, opt.aide ? h("span", { class: "detail-verif" }, opt.aide) : null);
  }

  function caseACocher(/** @type {any} */ obj, /** @type {string} */ cle, /** @type {string} */ libelle) {
    const e = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: Boolean(obj[cle]), disabled: lecture }));
    e.addEventListener("change", () => { obj[cle] = e.checked; changer(); });
    return h("label", { class: "case-admin" }, e, libelle);
  }

  // ---------------------------------------------------------------- questions

  function carteQuestion(/** @type {any} */ q, /** @type {number} */ i) {
    const n = c.questions.length;
    const deplacer = (/** @type {number} */ d) => {
      const j = i + d;
      if (j < 0 || j >= n) return;
      [c.questions[i], c.questions[j]] = [c.questions[j], c.questions[i]];
      ouverte = j; vue = j; dessinerQuestions(); changer();
    };
    const titre = h("strong", {}, q.texte || "Nouvelle question");
    const longue = (q.texte ?? "").trim().length > BULLE_MAX;
    const avert = h("span", { class: "pastille", "data-ton": "jaune", hidden: !(longue && !q.carton?.trim()) }, "Titre court conseillé");
    const tete = h("div", { class: "tete-etape" },
      h("button", { type: "button", class: "ouvrir-etape", "aria-expanded": String(ouverte === i), onclick: () => { ouverte = ouverte === i ? null : i; vue = i; dessinerQuestions(); dessinerTelephone(); } },
        h("span", { class: "num question" }, String(i + 1)),
        h("span", { class: "texte" }, titre, h("span", {}, `${q.lectureSec ?? 10} s de lecture · ${q.dureeSec ?? 10} s de réponse`)), avert),
      lecture ? null : h("span", { class: "actions-etape" },
        h("button", { type: "button", class: "bouton discret petit", "aria-label": "Monter", disabled: i === 0, onclick: () => deplacer(-1) }, "↑"),
        h("button", { type: "button", class: "bouton discret petit", "aria-label": "Descendre", disabled: i === n - 1, onclick: () => deplacer(1) }, "↓"),
        h("button", { type: "button", class: "bouton discret petit", disabled: n >= QUESTIONS_MAX, onclick: () => {
          const pris = new Set(c.questions.map((/** @type {any} */ x) => x.id));
          c.questions.splice(i + 1, 0, { ...structuredClone(q), id: identifiant(q.id, pris) });
          ouverte = i + 1; vue = i + 1; dessinerQuestions(); changer();
        } }, "Dupliquer"),
        h("button", { type: "button", class: "bouton danger petit", disabled: n <= QUESTIONS_MIN, onclick: () => {
          c.questions.splice(i, 1); ouverte = null; vue = "accueil"; dessinerQuestions(); changer();
        } }, "Supprimer")));
    const surTexte = () => {
      titre.textContent = q.texte || "Nouvelle question";
      avert.hidden = !((q.texte ?? "").trim().length > BULLE_MAX && !q.carton?.trim());
    };
    const corps = ouverte === i ? h("div", { class: "corps-etape" },
      champ(q, "texte", "Question posée au candidat", { type: "long", max: 200, surSaisie: surTexte }),
      champ(q, "carton", "Titre court (dans le film si la question dépasse 80 caractères, et pour les recruteurs)", { max: 60, surSaisie: surTexte,
        aide: "Ex. « Pourquoi toi ? ». Laissé vide, la question entière s'affiche dans la bulle du film." }),
      h("div", { class: "grille deux" },
        champ(q, "lectureSec", "Temps de lecture (s)", { type: "nombre", min: 3, maxNb: 30 }),
        champ(q, "dureeSec", "Durée de réponse (s)", { type: "nombre", min: 5, maxNb: 60 })),
      h("p", { class: "detail-verif" }, `Identifiant : ${q.id} (fixé à la création : les réponses y sont rattachées).`)) : null;
    return h("li", { class: `etape-editeur${ouverte === i ? " ouverte" : ""}` }, tete, corps);
  }

  function dessinerQuestions() {
    zoneQuestions.replaceChildren(...c.questions.map(carteQuestion));
    ajoutQuestion.hidden = lecture || c.questions.length >= QUESTIONS_MAX;
  }
  const ajoutQuestion = h("button", { type: "button", class: "bouton discret", onclick: () => {
    const pris = new Set(c.questions.map((/** @type {any} */ x) => x.id));
    c.questions.push({ id: identifiant(`q-${c.questions.length + 1}`, pris), texte: "", dureeSec: 10, lectureSec: 10 });
    ouverte = c.questions.length - 1; vue = ouverte; dessinerQuestions(); changer();
  } }, "Ajouter une question");

  // ---------------------------------------------------------------- familles de métiers

  function dessinerFamilles() {
    zoneFamilles.replaceChildren(...c.familles.map((/** @type {any} */ f, /** @type {number} */ i) => {
      const e = /** @type {HTMLInputElement} */ (h("input", { value: f.nom ?? "", maxlength: 60, disabled: lecture, "aria-label": `Famille ${i + 1}` }));
      e.addEventListener("input", () => {
        f.nom = e.value;
        // Identifiant tiré du nom tant que la famille est neuve (les candidats déjà inscrits y sont rattachés sinon).
        if (f.neuve) { const pris = new Set(c.familles.filter((/** @type {any} */ x) => x !== f).map((/** @type {any} */ x) => x.id)); f.id = identifiant(e.value || "famille", pris); }
        changer();
      });
      return h("div", { class: "ligne-liste" }, e, lecture ? null : h("button", { type: "button", class: "bouton discret petit", onclick: () => { c.familles.splice(i, 1); dessinerFamilles(); changer(); } }, "Retirer"));
    }),
    lecture || c.familles.length >= 16 ? "" : h("button", { type: "button", class: "bouton discret petit", style: "align-self:flex-start", onclick: () => {
      const pris = new Set(c.familles.map((/** @type {any} */ x) => x.id));
      c.familles.push({ id: identifiant("famille", pris), nom: "", neuve: true }); dessinerFamilles();
    } }, "Ajouter une famille"));
  }

  // ---------------------------------------------------------------- téléphone (aperçu en direct)

  /** Durée estimée du film (ouverture, plans « question », réponses à durée pleine) pour l'aperçu de l'ouverture. */
  const dureeEstimee = () => 3 + c.questions.reduce((/** @type {number} */ s, /** @type {any} */ q) => s + 3 + (Number(q.dureeSec) || 10), 0);
  const lisible = (/** @type {number} */ sec) => sec < 60 ? `${sec} secondes` : `${Math.floor(sec / 60)} minute${sec >= 120 ? "s" : ""}${sec % 60 ? ` ${String(sec % 60).padStart(2, "0")}` : ""}`;
  const T = (/** @type {string} */ tu, /** @type {string} */ vous) => (c.tutoiement === false ? vous : tu);

  const habiller = (/** @type {HTMLElement} */ el, /** @type {"tel" | "film"} */ quoi) => habillerAvec(el, o.styles.find((x) => x.id === c.style) ?? o.styles[0], quoi);

  function dessinerTelephone() {
    const marque = h("div", { class: "tel-haut" }, h("span", { class: "tel-marque" }, "why me"), h("span", {}, c.evenement || ""));
    const onglets = h("div", { class: "tel-onglets" },
      ...[["accueil", "Accueil"], ["essai", "Essai"], ...c.questions.map((/** @type {any} */ _q, /** @type {number} */ i) => [i, `Q${i + 1}`])].map(([v, l]) =>
        h("button", { type: "button", "aria-pressed": String(vue === v), onclick: () => { vue = v; dessinerTelephone(); } }, String(l))));
    if (vue === "accueil") {
      telephone.replaceChildren(marque, h("div", { class: "tel-corps" },
        h("h3", {}, c.accueil.titre || "Plus qu'un CV. Quelqu'un."),
        h("p", { class: "tel-bulle" }, c.accueil.message || ""),
        h("p", { class: "tel-bulle" }, T("Sois toi-même : pas de piège, pas de note. Juste toi, en vidéo, pour les entreprises que tu choisis.", "Soyez vous-même : pas de piège, pas de note. Juste vous, en vidéo, pour les entreprises que vous choisissez.")),
        c.organisateur ? h("p", { class: "tel-petit" }, `Avec ${c.organisateur}`) : null,
        h("div", { class: "tel-chiffres" }, h("span", {}, h("strong", {}, String(c.questions.length)), "questions"),
          h("span", {}, h("strong", {}, `${c.questions[0]?.dureeSec ?? 10} s`), "par réponse")),
        h("span", { class: "tel-bouton" }, "C'est parti !")));
    } else {
      const q = vue === "essai" ? { texte: c.questionEssai.texte || "Pour t'échauffer : dis bonjour et ton prénom", lectureSec: 3 } : c.questions[Number(vue)] ?? {};
      telephone.replaceChildren(h("div", { class: "tel-camera" },
        h("div", { class: "tel-bandeau" }, h("span", { class: "tel-etape" }, vue === "essai" ? "Essai (non enregistré)" : `Question ${Number(vue) + 1}/${c.questions.length}`),
          h("p", {}, q.texte || "…")),
        h("span", { class: "tel-silhouette", "aria-hidden": "true" }),
        h("span", { class: "tel-chrono" }, `${q.lectureSec ?? 10}`)));
    }
    telephone.prepend(onglets);
    habiller(telephone, "tel");
    // Film : l'ouverture (onglets Accueil et Essai) ou le plan « question » sélectionné, tels qu'ils seront montés.
    if (typeof vue !== "number") {
      film.replaceChildren(
        h("span", { class: "film-num" }, `JobBox · ${c.evenement || "…"}`),
        h("span", { class: "film-bulle ouverture" }, `Découvrez Camille en ${lisible(dureeEstimee())}`),
        h("span", { class: "film-logo" }, "why me"),
        h("span", { class: "film-legende" }, "Ouverture (prénom et durée réels du film)"));
    } else {
      const qf = c.questions[vue];
      film.replaceChildren(
        h("span", { class: "film-num" }, `Question ${vue + 1}/${c.questions.length}`),
        h("span", { class: "film-bulle" }, qf ? texteBulle(qf) || "…" : "…"),
        h("span", { class: "film-logo" }, "why me"),
        h("span", { class: "film-legende" }, `Plan « question » ${vue + 1}`));
    }
    habiller(film, "film");
  }

  // ---------------------------------------------------------------- entreprises

  const zoneEntreprises = h("div", { class: "grille-cases" }, ...o.entreprises.map((e) => {
    const b = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: choisies.has(e.id), disabled: lecture }));
    b.addEventListener("change", () => { if (b.checked) choisies.add(e.id); else choisies.delete(e.id); changer(); });
    return h("label", { class: "case-admin" }, b, e.nom);
  }));

  // ---------------------------------------------------------------- mode expert, actions

  const zoneJson = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "json-editeur", spellcheck: "false", disabled: lecture }));
  const appliquer = h("button", { type: "button", class: "bouton petit", hidden: lecture }, "Appliquer ce JSON");
  const expert = h("details", { class: "expert" }, h("summary", {}, "Mode expert : fichier JSON"), zoneJson, appliquer);
  expert.addEventListener("toggle", () => { zoneJson.value = JSON.stringify(config(), null, 2); });
  appliquer.addEventListener("click", () => {
    try { reprendre(JSON.parse(zoneJson.value)); } catch { problemes = ["Le texte n'est pas un JSON valide."]; dessinerVerification(); }
  });
  const reprendre = (/** @type {any} */ nouvelle) => {
    c = structuredClone(nouvelle);
    c.accueil ??= { titre: "", message: "" }; c.questionEssai ??= { texte: "", dureeSec: 6 }; c.familles ??= []; c.questions ??= [];
    c.tutoiement ??= true; c.style ??= "bulles";
    ouverte = null; vue = "accueil";
    dessinerTout(); changer();
  };

  boutonEnregistrer.addEventListener("click", async () => {
    boutonEnregistrer.disabled = true;
    try { await o.enregistrer(config(), [...choisies]); modifie = false; etat.textContent = "Enregistré"; o.apresEnregistrement?.(); }
    catch (e) { problemes = [/** @type {Error} */ (e).message]; dessinerVerification(); }
  });

  const sections = h("div", { class: "pile" });
  function dessinerTout() {
    dessinerQuestions(); dessinerFamilles(); dessinerTelephone();
    sections.replaceChildren(
      h("section", { class: "carte pile" }, h("h2", { style: "margin:0" }, o.pourModele ? "Accueil" : "Événement et accueil"),
        o.pourModele ? h("p", { class: "detail-verif", style: "margin:0" }, "L'événement et l'organisateur viennent de la campagne à laquelle on applique ce questionnaire.") : h("div", { class: "grille deux" },
          champ(c, "evenement", "Événement (affiché au candidat)", { max: 80 }),
          champ(c, "organisateur", "Organisateur (facultatif, ex. « la PFA »)", { max: 80 })),
        champ(c.accueil, "titre", "Titre de l'accueil", { max: 80 }),
        champ(c.accueil, "message", "Message d'accueil", { type: "long", max: 400 })),
      h("section", { class: "carte pile" }, h("h2", { style: "margin:0" }, "Ton et feuille de style"),
        h("div", { class: "grille deux" },
          (() => {
            const sel = /** @type {HTMLSelectElement} */ (h("select", { disabled: lecture },
              h("option", { value: "tu", selected: c.tutoiement !== false }, "Tutoiement (« Installe ton téléphone »)"),
              h("option", { value: "vous", selected: c.tutoiement === false }, "Vouvoiement (« Installez votre téléphone »)")));
            sel.addEventListener("change", () => { c.tutoiement = sel.value === "tu"; changer(); });
            return h("label", { class: "champ" }, "S'adresser au candidat", sel,
              h("span", { class: "detail-verif" }, "Tous les écrans et e-mails suivent. Vos propres textes (accueil, questions) ne sont pas convertis : écrivez-les dans le même registre."));
          })(),
          (() => {
            const sel = /** @type {HTMLSelectElement} */ (h("select", { disabled: lecture }, ...o.styles.map((st) => h("option", { value: st.id, selected: st.id === c.style }, st.nom))));
            const desc = h("span", { class: "detail-verif" }, (o.styles.find((x) => x.id === c.style) ?? o.styles[0])?.description ?? "");
            sel.addEventListener("change", () => { c.style = sel.value; desc.textContent = (o.styles.find((x) => x.id === c.style))?.description ?? ""; changer(); });
            return h("label", { class: "champ" }, "Feuille de style", sel, desc, h("a", { href: "#/styles", class: "detail-verif" }, "Voir et créer des feuilles de style ›"));
          })())),
      o.pourModele ? "" : h("section", { class: "carte pile" }, h("h2", { style: "margin:0" }, "Entreprises proposées au candidat"),
        h("p", { class: "detail-verif", style: "margin:0" }, "Le candidat choisit parmi elles celles qui recevront sa candidature. Au moins une pour ouvrir la campagne."),
        o.entreprises.length ? zoneEntreprises : h("p", { class: "vide" }, h("span", {}, "Aucune entreprise : créez-les d'abord dans "), h("a", { href: "#/entreprises" }, "Entreprises et recruteurs"), ".")),
      h("section", { class: "carte pile" }, h("h2", { style: "margin:0" }, "Question d'essai"),
        h("p", { class: "detail-verif", style: "margin:0" }, "Pour se lancer et vérifier le son : jamais enregistrée ni envoyée."),
        h("div", { class: "grille deux" },
          champ(c.questionEssai, "texte", "Question", { max: 200 }),
          champ(c.questionEssai, "dureeSec", "Durée (s)", { type: "nombre", min: 5, maxNb: 30 }))),
      h("section", { class: "carte pile" },
        h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap" },
          h("h2", { style: "margin:0" }, `Questions (${c.questions.length})`), h("span", { class: "detail-verif" }, "De 3 à 5. Une reprise possible par question.")),
        zoneQuestions, ajoutQuestion),
      h("section", { class: "carte pile" }, h("h2", { style: "margin:0" }, "Familles de métiers"),
        h("p", { class: "detail-verif", style: "margin:0" }, "Le candidat en choisit une ; les recruteurs filtrent dessus. Aucune : l'étape est sautée."), zoneFamilles),
      h("section", { class: "carte pile" }, h("h2", { style: "margin:0" }, "Réglages"),
        caseACocher(c, "ageAffiche", "Afficher l'âge du candidat dans le film (« Laurent, 52 ans »)"),
        h("div", { class: "grille deux" },
          champ(c, "ageMinimum", "Âge minimum", { type: "nombre", min: 14, maxNb: 30 }),
          champ(c, "validationAutoSec", "« On garde » automatique après (s)", { type: "nombre", min: 3, maxNb: 15 }))),
      expert);
  }
  dessinerTout();
  verifier();

  return h("div", { class: "editeur" },
    sections,
    h("aside", { class: "carte pile panneau-editeur" },
      h("h2", { style: "margin:0" }, "Sur le téléphone"), telephone,
      h("h2", { style: "margin:0" }, "Dans le film"), film,
      h("h2", { style: "margin:0" }, "Vérification"), verification,
      h("div", { class: "boutons" },
        h("button", { type: "button", class: "bouton discret", onclick: () => o.apercu(config(), [...choisies]).catch((e) => { problemes = [e.message]; dessinerVerification(); }) }, "Essayer le parcours"),
        boutonEnregistrer),
      etat,
      h("p", { class: "detail-verif", style: "margin:0" }, "« Essayer le parcours » ouvre l'interview complète dans un nouvel onglet, caméra comprise, avec ce brouillon : rien n'y est enregistré."),
      lecture || o.pourModele ? null : outilsModeles()));

  /** Questionnaires types : en appliquer un (l'événement et l'organisateur de la campagne restent), ou garder celui-ci. */
  function outilsModeles() {
    const liste = o.modeles ?? [];
    const choix = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Questionnaire type" }, h("option", { value: "" }, "Choisir un questionnaire type…"), ...liste.map((m) => h("option", { value: m.id }, m.nom))));
    const appliquer = h("button", { type: "button", class: "bouton discret petit", onclick: () => {
      const m = liste.find((x) => x.id === choix.value);
      if (!m) return;
      reprendre({ ...structuredClone(m.config), evenement: c.evenement, organisateur: c.organisateur });
      etat.textContent = `Questionnaire « ${m.nom} » appliqué : enregistrez pour le garder`;
    } }, "Appliquer");
    const nom = /** @type {HTMLInputElement} */ (h("input", { maxlength: 80, placeholder: "ex. Salon de l'alternance", "aria-label": "Nom du questionnaire type" }));
    const garder = h("button", { type: "button", class: "bouton discret petit", onclick: async () => {
      if (!nom.value.trim()) { nom.focus(); etat.textContent = "Donnez un nom au questionnaire type."; return; }
      try { await o.enregistrerModele?.(nom.value.trim(), config()); nom.value = ""; } catch (e) { problemes = [/** @type {Error} */ (e).message]; dessinerVerification(); }
    } }, "Enregistrer comme questionnaire type");
    return h("details", { class: "outils-modeles" }, h("summary", {}, "Questionnaires types"),
      h("p", { class: "detail-verif" }, "Remplacer les questions, l'accueil, le ton et la feuille de style par un questionnaire type (les entreprises cochées restent) :"),
      h("div", { class: "ligne-outil" }, choix, appliquer),
      o.enregistrerModele ? h("p", { class: "detail-verif" }, "Ou garder ce questionnaire pour d'autres campagnes :") : null,
      o.enregistrerModele ? h("div", { class: "ligne-outil colonne" }, nom, garder) : null,
      h("a", { href: "#/modeles", class: "detail-verif" }, "Voir tous les questionnaires types ›"));
  }
}

/**
 * Couleurs et motif d'une feuille de style sur un aperçu (téléphone ou plan du film), dans l'éditeur et sur la page
 * des feuilles de style.
 * @param {HTMLElement} el
 * @param {{ couleurs: Record<string, string>, motif: string | null } | undefined} st
 * @param {"tel" | "film"} quoi
 */
export function habillerAvec(el, st, quoi) {
  if (!st) return;
  const k = st.couleurs;
  el.style.setProperty("--vox", k.accent);
  el.style.setProperty("--tel-fond", k.fond);
  el.style.setProperty("--tel-pale", k.accentPale);
  el.style.setProperty("--tel-bulle", k.bulle);
  el.style.setProperty("--tel-titre", k.titre);
  el.style.setProperty("--tel-texte", k.texte);
  el.style.setProperty("--film-fond", k.fondFilm);
  el.style.setProperty("--film-discret", k.discret);
  el.querySelectorAll(":scope > .motif-tel, :scope > .motif-film").forEach((m) => m.remove());
  if (st.motif && /^[a-z0-9-]+$/.test(st.motif)) el.append(h("img", { class: `motif-${quoi}`, src: `/whyme/motifs/${st.motif}.svg`, alt: "" }));
}
