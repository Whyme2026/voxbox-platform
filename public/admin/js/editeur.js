// @ts-check
// Éditeur de questions et de parcours (Parlorama). Les étapes sont des cartes qu'on ajoute, déplace, duplique et
// remplit ; la vérification est faite par le serveur (mêmes règles qu'à l'enregistrement) ; l'aperçu ouvre la vraie
// cabine avec le brouillon, sans rien enregistrer. Le fichier JSON reste accessible en mode expert.

import { h } from "./dom.js";

/**
 * @typedef {{ cle: string, libelle: string, type: "texte" | "long" | "nombre" | "case" | "liste" | "options", max?: number, nb?: number, min?: number, maxNb?: number, aide?: string, defaut?: unknown }} Champ
 */

export const TYPES = /** @type {Record<string, { libelle: string, description: string, champs: Champ[] }>} */ ({
  accueil: {
    libelle: "Accueil", description: "Le premier écran : la cabine interpelle le passant.",
    champs: [
      { cle: "surtitre", libelle: "Petite ligne en haut à droite", type: "texte", max: 40 },
      { cle: "titre", libelle: "Titre", type: "long", max: 300, defaut: "Une minute pour dire ce que vous pensez vraiment." },
      { cle: "texte", libelle: "Texte sous le titre", type: "long", max: 300 },
      { cle: "bulles", libelle: "Bulles de la cabine (3 au plus)", type: "liste", nb: 3, max: 120, defaut: ["Bonjour !"] },
      { cle: "bouton", libelle: "Bouton", type: "texte", max: 40, defaut: "Je me lance" },
    ],
  },
  identification: {
    libelle: "Prénom", description: "Le visiteur donne son prénom (et, s'il le souhaite, son e-mail).",
    champs: [
      { cle: "titre", libelle: "Question", type: "long", max: 300, defaut: "Pour commencer, comment vous appelez-vous ?" },
      { cle: "texte", libelle: "Petite bulle sous la question", type: "texte", max: 120, defaut: "Juste le prénom, promis." },
      { cle: "demanderNom", libelle: "Demander aussi le nom (facultatif pour le visiteur)", type: "case" },
      { cle: "demanderEmail", libelle: "Proposer l'e-mail, pour être recontacté (facultatif)", type: "case", defaut: true },
    ],
  },
  consentement: {
    libelle: "Mode d'emploi et accord", description: "Les règles du jeu et l'accord du visiteur. Obligatoire avant la première question.",
    champs: [
      { cle: "texte", libelle: "Bulle d'introduction", type: "texte", max: 160, defaut: "Merci {prenom} ! Avant de commencer, voici le deal." },
      { cle: "titre", libelle: "Titre", type: "long", max: 300, defaut: "Comment ça marche" },
      { cle: "consignes", libelle: "Consignes (6 au plus ; un chiffre en tête s'affiche en grand)", type: "liste", nb: 6, max: 140, defaut: ["5 questions, une à la fois.", "30 s pour répondre."] },
      { cle: "bouton", libelle: "Bouton", type: "texte", max: 40, defaut: "C'est parti" },
      { cle: "proposerDiffusion", libelle: "Proposer l'accord de diffusion publique (réseaux sociaux, site)", type: "case" },
      { cle: "proposerFloutage", libelle: "Proposer de flouter le visage", type: "case", defaut: true },
    ],
  },
  cadrage: {
    libelle: "Cadrage", description: "Le visiteur se voit et se place avant les questions.",
    champs: [
      { cle: "titre", libelle: "Consigne", type: "long", max: 300, defaut: "Placez votre visage au centre" },
      { cle: "proposerFloutage", libelle: "Proposer de flouter le visage", type: "case" },
    ],
  },
  question: {
    libelle: "Question", description: "Une question filmée : le temps de lire, puis la caméra tourne.",
    champs: [
      { cle: "titreCourt", libelle: "Nom court (affiché au-dessus, sert aussi dans Parlorama et les Parlomix)", type: "texte", max: 40, defaut: "Nouvelle question" },
      { cle: "texte", libelle: "Question", type: "long", max: 200, defaut: "Qu'avez-vous pensé de votre visite ?" },
      { cle: "pistes", libelle: "Pistes de réponse (5 au plus)", type: "liste", nb: 5, max: 40 },
      { cle: "coupDePouce", libelle: "Début de phrase pour se lancer", type: "texte", max: 100 },
      { cle: "aide", libelle: "Aide (facultatif)", type: "long", max: 300 },
      { cle: "dureeMaxSec", libelle: "Durée maximale (secondes)", type: "nombre", min: 5, maxNb: 120, defaut: 30 },
      { cle: "compteARebours", libelle: "Temps de lecture avant de filmer (secondes)", type: "nombre", min: 0, maxNb: 10, defaut: 5 },
      { cle: "silenceArretSec", libelle: "Arrêt après ce silence (secondes, 0 = jamais)", type: "nombre", min: 0, maxNb: 15, defaut: 3 },
      { cle: "theme", libelle: "Thème d'analyse (pour regrouper les réponses)", type: "texte", max: 40 },
    ],
  },
  choix: {
    libelle: "Choix", description: "Le visiteur choisit, et le parcours continue selon son choix.",
    champs: [
      { cle: "titre", libelle: "Question", type: "long", max: 300, defaut: "Lequel avez-vous essayé ?" },
      { cle: "options", libelle: "Options (2 à 8) et étape suivante pour chacune", type: "options" },
    ],
  },
  pause: {
    libelle: "Pause avant/après", description: "Le visiteur part (essai, visite) et reprend plus tard avec son prénom.",
    champs: [
      { cle: "titre", libelle: "Titre", type: "long", max: 300, defaut: "Bon essai !" },
      { cle: "texte", libelle: "Texte", type: "long", max: 300 },
      { cle: "bouton", libelle: "Bouton", type: "texte", max: 40, defaut: "À tout à l'heure" },
    ],
  },
  fin: {
    libelle: "Fin", description: "Le remerciement. Toujours la dernière étape.",
    champs: [
      { cle: "titre", libelle: "Titre", type: "long", max: 300, defaut: "Merci {prenom}, c'est dans la boîte !" },
      { cle: "texte", libelle: "Texte", type: "long", max: 300 },
      { cle: "sortie", libelle: "Message de sortie (en grand)", type: "texte", max: 160, defaut: "Vous pouvez sortir de la cabine. Belle fin de journée !" },
      { cle: "retourAccueilSec", libelle: "Retour à l'accueil après (secondes)", type: "nombre", min: 3, maxNb: 60, defaut: 20 },
    ],
  },
});

const PREFIXES = /** @type {Record<string, string>} */ ({ question: "q", consentement: "accord", identification: "vous" });

/** Identifiant libre pour une nouvelle étape (il ne change plus ensuite : les réponses y sont rattachées). */
export function nouvelId(/** @type {string} */ type, /** @type {Record<string, any>[]} */ etapes) {
  const base = PREFIXES[type] ?? type;
  let n = 1;
  while (etapes.some((e) => e.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Nouvelle étape remplie avec des valeurs par défaut. */
export function nouvelleEtape(/** @type {string} */ type, /** @type {Record<string, any>[]} */ etapes) {
  /** @type {Record<string, any>} */
  const e = { id: nouvelId(type, etapes), type };
  for (const c of TYPES[type]?.champs ?? []) if (c.defaut !== undefined) e[c.cle] = structuredClone(c.defaut);
  if (type === "choix") e.options = [{ id: "a", libelle: "Option A", suite: "" }, { id: "b", libelle: "Option B", suite: "" }];
  return e;
}

/** Nettoie une étape avant envoi : champs vides retirés, listes sans lignes vides. */
export function nettoyer(/** @type {Record<string, any>} */ e) {
  /** @type {Record<string, any>} */
  const propre = {};
  for (const [k, v] of Object.entries(e)) {
    if (v === "" || v === null || v === undefined) continue;
    if (Array.isArray(v) && k !== "options") {
      const l = v.map((x) => String(x).trim()).filter(Boolean);
      if (l.length) propre[k] = l;
      continue;
    }
    propre[k] = typeof v === "string" ? v.trim() : v;
  }
  return propre;
}

/** Problèmes signalés par le serveur qui concernent une étape (« étape q-1 : … »). */
export function problemesDe(/** @type {string} */ id, /** @type {string[]} */ problemes) {
  return problemes.filter((p) => new RegExp(`^étape (\\d+ \\()?${id.replace(/[-]/g, "\\-")}\\)?( |,|:)`).test(p));
}

/** Ambiance connue de la cabine ; « conversation » par défaut. */
const ambianceConnue = (/** @type {unknown} */ a) => (a === "pop" || a === "marine" ? a : "conversation");

/**
 * Crée l'éditeur.
 * @param {{
 *   config: any,
 *   lectureSeule?: boolean,
 *   valider: (config: any) => Promise<string[]>,
 *   enregistrer: (config: any) => Promise<void>,
 *   apercu: (config: any) => void,
 *   modeles: { libelle: string, charger: () => Promise<any> }[],
 * }} o
 */
export function editeurParcours(o) {
  let langue = o.config?.langue ?? "fr";
  /** Ambiance graphique de la cabine et tutoiement des textes fixes : réglages du parcours entier. */
  let ambiance = ambianceConnue(o.config?.ambiance);
  let tutoiement = o.config?.tutoiement === true;
  /** Habillage de la campagne (polices, couleurs, fonds, visuels) : modifié en mode expert, conservé tel quel ici. */
  /** @type {any} */ let habillage = structuredClone(o.config?.habillage);
  /** @type {Record<string, any>[]} */
  let etapes = structuredClone(o.config?.etapes ?? []);
  /** @type {string[]} */
  let problemes = [];
  let ouverte = /** @type {string | null} */ (null);
  let modifie = false;
  let minuterie = 0;

  const config = () => ({
    version: 1, langue,
    ...(ambiance !== "conversation" ? { ambiance } : {}),
    ...(tutoiement ? { tutoiement: true } : {}),
    ...(habillage ? { habillage } : {}),
    etapes: etapes.map(nettoyer),
  });
  /** Reprend les réglages d'un parcours chargé (JSON, modèle), habillage compris. */
  const reprendre = (/** @type {any} */ c) => {
    langue = c.langue ?? "fr";
    ambiance = ambianceConnue(c.ambiance);
    tutoiement = c.tutoiement === true;
    habillage = structuredClone(c.habillage);
    choixAmbiance.value = ambiance;
    caseTutoiement.checked = tutoiement;
  };
  const liste = h("ol", { class: "editeur-etapes" });
  const choixAmbiance = /** @type {HTMLSelectElement} */ (h("select", { id: "ed-ambiance", disabled: o.lectureSeule === true },
    h("option", { value: "conversation", selected: ambiance === "conversation" }, "Conversation (neutre Parlopop)"),
    h("option", { value: "pop", selected: ambiance === "pop" }, "Pop (festif, esprit BD)"),
    h("option", { value: "marine", selected: ambiance === "marine" }, "Marine (bord de mer, impertinent)")));
  choixAmbiance.addEventListener("change", () => { ambiance = choixAmbiance.value; changer(); });
  const caseTutoiement = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id: "ed-tutoiement", checked: tutoiement, disabled: o.lectureSeule === true }));
  caseTutoiement.addEventListener("change", () => { tutoiement = caseTutoiement.checked; changer(); });
  const reglages = h("div", { class: "pile", style: "gap: 8px" },
    h("label", { class: "champ", for: "ed-ambiance" }, "Ambiance de la cabine", choixAmbiance),
    h("label", { class: "case-admin", for: "ed-tutoiement" }, caseTutoiement, "Tutoyer le visiteur (textes fixes de la cabine)"));
  const verification = h("div", { class: "verification" });
  const enregistrer = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "bouton action", disabled: true }, "Enregistrer la version"));
  const etat = h("span", { class: "etat-editeur" });

  const verifier = () => {
    clearTimeout(minuterie);
    verification.replaceChildren(h("span", { class: "detail-verif" }, "Vérification…"));
    minuterie = window.setTimeout(async () => {
      try { problemes = await o.valider(config()); } catch (e) {
        // Page chargée avant le dernier déploiement : le serveur refuse, il faut recharger (voir admin.js).
        problemes = [/** @type {any} */ (e)?.corps?.erreur === "parlorama_perime" ? /** @type {Error} */ (e).message : "Vérification impossible pour l'instant (connexion)."];
      }
      dessinerVerification();
      dessiner();
    }, 400);
  };
  const changer = () => { modifie = true; etat.textContent = "Modifications non enregistrées"; verifier(); };

  function dessinerVerification() {
    enregistrer.disabled = o.lectureSeule === true || problemes.length > 0 || !modifie;
    verification.replaceChildren(problemes.length
      ? h("div", { class: "pile", style: "gap: 6px" }, h("strong", { class: "verif-ko" }, `${problemes.length} point${problemes.length > 1 ? "s" : ""} à corriger`),
        h("ul", { class: "erreurs" }, ...problemes.slice(0, 12).map((p) => h("li", {}, p))))
      : h("strong", { class: "verif-ok" }, "Parcours valide"));
  }

  /** Champ de formulaire pour une propriété d'étape. */
  function champ(/** @type {Record<string, any>} */ e, /** @type {Champ} */ c) {
    const id = `ed-${e.id}-${c.cle}`;
    const lecture = o.lectureSeule === true;
    if (c.type === "case") {
      const entree = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id, checked: Boolean(e[c.cle]), disabled: lecture }));
      entree.addEventListener("change", () => { e[c.cle] = entree.checked || undefined; changer(); });
      return h("label", { class: "case-admin", for: id }, entree, c.libelle);
    }
    if (c.type === "liste") {
      const valeurs = /** @type {string[]} */ ([...(e[c.cle] ?? [])]);
      const zone = h("div", { class: "pile", style: "gap: 6px" });
      const dessinerListe = () => {
        zone.replaceChildren(...[...valeurs.map((v, i) => {
          const entree = /** @type {HTMLInputElement} */ (h("input", { value: v, maxlength: c.max, disabled: lecture, "aria-label": `${c.libelle}, ligne ${i + 1}` }));
          entree.addEventListener("input", () => { valeurs[i] = entree.value; e[c.cle] = [...valeurs]; changer(); });
          return h("div", { class: "ligne-liste" }, entree,
            lecture ? null : h("button", { type: "button", class: "bouton discret petit", "aria-label": "Retirer cette ligne", onclick: () => { valeurs.splice(i, 1); e[c.cle] = [...valeurs]; dessinerListe(); changer(); } }, "Retirer"));
        }),
        !lecture && valeurs.length < (c.nb ?? 5) ? h("button", { type: "button", class: "bouton discret petit", style: "align-self: flex-start", onclick: () => { valeurs.push(""); e[c.cle] = [...valeurs]; dessinerListe(); } }, "Ajouter une ligne") : null].filter((x) => x !== null));
      };
      dessinerListe();
      return h("div", { class: "champ" }, c.libelle, zone);
    }
    if (c.type === "options") {
      const zone = h("div", { class: "pile", style: "gap: 6px" });
      const dessinerOptions = () => {
        /** @type {{ id: string, libelle: string, suite: string }[]} */
        const opts = e.options ?? (e.options = []);
        zone.replaceChildren(...[...opts.map((op, i) => {
          const libelle = /** @type {HTMLInputElement} */ (h("input", { value: op.libelle, maxlength: 60, disabled: lecture, "aria-label": `Option ${i + 1}` }));
          libelle.addEventListener("input", () => { op.libelle = libelle.value; changer(); });
          const suite = /** @type {HTMLSelectElement} */ (h("select", { disabled: lecture, "aria-label": `Étape après l'option ${i + 1}` },
            h("option", { value: "" }, "Aller à…"),
            ...etapes.filter((x) => x.id !== e.id).map((x) => h("option", { value: x.id, selected: x.id === op.suite }, resume(x)))));
          suite.addEventListener("change", () => { op.suite = suite.value; changer(); });
          return h("div", { class: "ligne-liste" }, libelle, suite,
            lecture || opts.length <= 2 ? null : h("button", { type: "button", class: "bouton discret petit", onclick: () => { opts.splice(i, 1); dessinerOptions(); changer(); } }, "Retirer"));
        }),
        !lecture && (e.options?.length ?? 0) < 8 ? h("button", { type: "button", class: "bouton discret petit", style: "align-self: flex-start", onclick: () => {
          const ids = new Set(e.options.map((/** @type {any} */ x) => x.id));
          let n = e.options.length + 1;
          while (ids.has(`option-${n}`)) n++;
          e.options.push({ id: `option-${n}`, libelle: `Option ${n}`, suite: "" });
          dessinerOptions(); changer();
        } }, "Ajouter une option") : null].filter((x) => x !== null));
      };
      dessinerOptions();
      return h("div", { class: "champ" }, c.libelle, zone);
    }
    const attrs = { id, disabled: lecture, maxlength: c.max, min: c.min, max: c.maxNb };
    const entree = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (c.type === "long"
      ? h("textarea", { ...attrs, rows: 2 }, e[c.cle] ?? "")
      : h("input", { ...attrs, type: c.type === "nombre" ? "number" : "text", value: e[c.cle] ?? null }));
    entree.addEventListener("input", () => {
      e[c.cle] = c.type === "nombre" ? (entree.value === "" ? undefined : Number(entree.value)) : entree.value;
      const titre = document.getElementById(`titre-${e.id}`);
      if (titre) titre.textContent = resume(e);
      changer();
    });
    return h("label", { class: "champ", for: id }, c.libelle, entree);
  }

  /** Fond et visuel de l'écran, quand la campagne a un habillage qui en propose. */
  function habillageEtape(/** @type {Record<string, any>} */ e) {
    const lecture = o.lectureSeule === true;
    /** @type {HTMLElement[]} */ const champs = [];
    const select = (/** @type {string} */ cle, /** @type {string} */ libelle, /** @type {[string, string][]} */ valeurs) => {
      const s = /** @type {HTMLSelectElement} */ (h("select", { disabled: lecture },
        h("option", { value: "" }, "Aucun(e)"), ...valeurs.map(([v, l]) => h("option", { value: v, selected: e[cle] === v }, l))));
      s.addEventListener("change", () => { e[cle] = s.value || undefined; changer(); });
      champs.push(h("label", { class: "champ" }, libelle, s));
    };
    if (habillage?.fonds?.length) select("fond", "Fond de l'écran", habillage.fonds.map((/** @type {any} */ a) => [a.id, a.nom ?? a.id]));
    if (habillage?.visuels?.length) select("visuel", "Visuel de l'écran", [...habillage.visuels.map((/** @type {any} */ v) => [v.id, v.nom ?? v.id]), ["choix", "Celui de la dernière option choisie"]]);
    return champs;
  }

  const resume = (/** @type {Record<string, any>} */ e) => String(e.titreCourt || e.titre || TYPES[e.type]?.libelle || e.type).replaceAll("{prenom}", "[prénom]");

  /** Une étape : en-tête (numéro, type, titre, actions), et son formulaire quand elle est ouverte. */
  function carte(/** @type {Record<string, any>} */ e, /** @type {number} */ i) {
    const def = TYPES[e.type];
    const pb = problemesDe(e.id, problemes);
    const lecture = o.lectureSeule === true;
    const deplacer = (/** @type {number} */ d) => { const j = i + d; if (j < 0 || j >= etapes.length) return; [etapes[i], etapes[j]] = [/** @type {any} */ (etapes[j]), /** @type {any} */ (etapes[i])]; dessiner(); changer(); };
    const tete = h("div", { class: "tete-etape" },
      h("button", { type: "button", class: "ouvrir-etape", "aria-expanded": String(ouverte === e.id), onclick: () => { ouverte = ouverte === e.id ? null : e.id; dessiner(); } },
        h("span", { class: `num${e.type === "question" ? " question" : ""}` }, String(i + 1)),
        h("span", { class: "texte" }, h("strong", { id: `titre-${e.id}` }, resume(e)), h("span", {}, `${def?.libelle ?? e.type} · ${e.id}`)),
        pb.length ? h("span", { class: "pastille", "data-ton": "rouge" }, `${pb.length} à corriger`) : null),
      lecture ? null : h("span", { class: "actions-etape" },
        h("button", { type: "button", class: "bouton discret petit", "aria-label": "Monter", disabled: i === 0, onclick: () => deplacer(-1) }, "↑"),
        h("button", { type: "button", class: "bouton discret petit", "aria-label": "Descendre", disabled: i === etapes.length - 1, onclick: () => deplacer(1) }, "↓"),
        h("button", { type: "button", class: "bouton discret petit", onclick: () => {
          const copie = { ...structuredClone(e), id: nouvelId(e.type, etapes) };
          etapes.splice(i + 1, 0, copie); ouverte = copie.id; dessiner(); changer();
        } }, "Dupliquer"),
        h("button", { type: "button", class: "bouton danger petit", onclick: () => { etapes.splice(i, 1); dessiner(); changer(); } }, "Supprimer")));
    const corps = ouverte === e.id ? h("div", { class: "corps-etape" },
      h("p", { class: "description-etape" }, def?.description ?? ""),
      ...(def?.champs ?? []).map((c) => champ(e, c)),
      ...habillageEtape(e),
      e.type !== "choix" && e.type !== "fin" ? (() => {
        const suite = /** @type {HTMLSelectElement} */ (h("select", { disabled: lecture },
          h("option", { value: "" }, "L'étape suivante dans la liste"),
          ...etapes.filter((x) => x.id !== e.id).map((x) => h("option", { value: x.id, selected: x.id === e.suite }, `Aller à : ${resume(x)}`))));
        suite.addEventListener("change", () => { e.suite = suite.value || undefined; changer(); });
        return h("label", { class: "champ" }, "Ensuite", suite);
      })() : null,
      pb.length ? h("ul", { class: "erreurs" }, ...pb.map((p) => h("li", {}, p))) : null) : null;
    return h("li", { class: `etape-editeur${ouverte === e.id ? " ouverte" : ""}` }, tete, corps);
  }

  const ajout = h("div", { class: "ajout-etape" });
  function dessinerAjout() {
    ajout.replaceChildren(o.lectureSeule ? "" : h("details", {},
      h("summary", { class: "bouton discret" }, "Ajouter une étape"),
      h("div", { class: "types-etapes" }, ...Object.entries(TYPES).map(([type, d]) => h("button", { type: "button", class: "type-etape", onclick: () => {
        const e = nouvelleEtape(type, etapes);
        // Avant la fin si elle existe (la fin reste la dernière étape).
        const fin = etapes.findIndex((x) => x.type === "fin");
        if (fin >= 0 && type !== "fin") etapes.splice(fin, 0, e); else etapes.push(e);
        ouverte = e.id; dessiner(); changer();
      } }, h("strong", {}, d.libelle), h("span", {}, d.description))))));
  }

  function dessiner() {
    liste.replaceChildren(...(etapes.length ? etapes.map(carte) : [h("li", { class: "vide" }, "Aucune étape : partez d'un modèle ou ajoutez une étape.")]));
    dessinerAjout();
  }

  // Mode expert : le fichier JSON complet.
  const zoneJson = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "json-editeur", spellcheck: "false", disabled: o.lectureSeule === true }));
  const appliquerJson = h("button", { type: "button", class: "bouton petit", hidden: o.lectureSeule === true }, "Appliquer ce JSON");
  const expert = h("details", { class: "expert" }, h("summary", {}, "Mode expert : fichier JSON"), zoneJson, appliquerJson);
  expert.addEventListener("toggle", () => { zoneJson.value = JSON.stringify(config(), null, 2); });
  appliquerJson.addEventListener("click", () => {
    try {
      const c = JSON.parse(zoneJson.value);
      if (!Array.isArray(c.etapes)) throw new Error();
      reprendre(c); etapes = c.etapes; ouverte = null; dessiner(); changer();
    } catch { problemes = ["Le texte n'est pas un fichier de parcours JSON valide."]; dessinerVerification(); }
  });

  enregistrer.addEventListener("click", async () => {
    enregistrer.disabled = true;
    try { await o.enregistrer(config()); modifie = false; etat.textContent = "Version enregistrée"; }
    catch (e) { problemes = /** @type {any} */ (e).corps?.problemes ?? [/** @type {Error} */ (e).message]; dessinerVerification(); dessiner(); }
  });

  const modeles = o.lectureSeule || !o.modeles.length ? null : h("div", { class: "pile", style: "gap: 6px" },
    h("span", { class: "detail-verif" }, "Partir d'un modèle (remplace les étapes actuelles) :"),
    ...o.modeles.map((m) => h("button", { type: "button", class: "bouton discret petit", style: "justify-content: flex-start", onclick: async () => {
      const c = await m.charger();
      if (!c) return;
      reprendre(c); etapes = structuredClone(c.etapes); ouverte = null; dessiner(); changer();
    } }, m.libelle)));

  dessiner();
  verifier();
  modifie = false;
  etat.textContent = o.lectureSeule ? "Lecture seule" : "";

  return h("div", { class: "editeur" },
    h("section", { class: "carte pile" },
      h("div", { style: "display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap" },
        h("h2", { style: "margin: 0" }, "Étapes du parcours"),
        h("span", { class: "detail-verif" }, "Dans tous les textes, {prenom} est remplacé par le prénom du visiteur.")),
      liste, ajout, expert),
    h("aside", { class: "carte pile panneau-editeur" },
      h("h2", { style: "margin: 0" }, "Réglages"),
      reglages,
      h("h2", { style: "margin: 0" }, "Vérification"),
      verification,
      h("div", { class: "boutons" },
        h("button", { type: "button", class: "bouton discret", onclick: () => o.apercu(config()) }, "Aperçu dans la cabine"),
        o.lectureSeule ? null : enregistrer),
      etat,
      o.lectureSeule ? null : h("p", { class: "detail-verif", style: "margin: 0" }, "L'aperçu ouvre la vraie cabine dans un nouvel onglet, avec ce brouillon : rien n'y est enregistré. Toute nouvelle version remet la campagne en brouillon (nouvelle validation du client)."),
      modeles));
}
