// @ts-check
// Clavier dessiné dans la page. Aucun champ de saisie natif : ni clavier système, ni saisie automatique,
// ni suggestions reprenant ce qu'a tapé le visiteur précédent (problème constaté sur Geely).

const LIGNES_LETTRES = [
  ["a", "z", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["q", "s", "d", "f", "g", "h", "j", "k", "l", "m"],
  ["w", "x", "c", "v", "b", "n", "é", "è", "-", "'"],
];
const LIGNE_ACCENTS = ["à", "â", "ç", "ê", "ë", "î", "ï", "ô", "ù", "ü"];
const LIGNE_EMAIL = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const LIGNE_EMAIL_FIN = ["@", ".", "_", "-", ".com", ".fr"];
const LIGNE_CODE = ["2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * @typedef {"nom" | "email" | "code"} ModeClavier
 * @typedef {{ valeur: string, max: number, mode: ModeClavier, element: HTMLElement, onChange?: (v: string) => void }} Champ
 */

/**
 * Crée un clavier dans `conteneur`. Les champs sont de simples éléments affichant la valeur.
 * @param {HTMLElement} conteneur
 */
export function creerClavier(conteneur) {
  /** @type {Champ | null} */
  let champ = null;
  let majuscule = true;
  let accents = false;

  const afficherChamp = () => {
    if (!champ) return;
    champ.element.textContent = champ.valeur;
    champ.element.dataset.vide = champ.valeur ? "non" : "oui";
    champ.onChange?.(champ.valeur);
  };

  /** @param {string} t */
  const taper = (t) => {
    if (!champ) return;
    let car = t;
    if (champ.mode === "nom" && majuscule && /^\p{L}$/u.test(t)) car = t.toLocaleUpperCase("fr");
    if (champ.mode === "code") car = t.toUpperCase();
    if ((champ.valeur + car).length > champ.max) return;
    champ.valeur += car;
    // Majuscule automatique en début de mot pour les prénoms et noms composés.
    majuscule = champ.mode === "nom" && (car === " " || car === "-");
    afficherChamp();
    dessiner();
  };

  const effacer = () => {
    if (!champ) return;
    champ.valeur = champ.valeur.slice(0, -1);
    majuscule = champ.mode === "nom" && (champ.valeur === "" || / |-$/.test(champ.valeur));
    afficherChamp();
    dessiner();
  };

  /** @param {string} libelle @param {() => void} action @param {string} [classe] @param {string} [aria] */
  const touche = (libelle, action, classe = "", aria) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `touche ${classe}`.trim();
    b.textContent = libelle;
    if (aria) b.setAttribute("aria-label", aria);
    // pointerdown : réaction immédiate au doigt, sans délai de clic.
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); action(); });
    return b;
  };

  const dessiner = () => {
    conteneur.replaceChildren();
    if (!champ) return;
    const mode = champ.mode;
    const ajouterLigne = (/** @type {HTMLElement[]} */ touches) => {
      const l = document.createElement("div");
      l.className = "clavier-ligne";
      l.append(...touches);
      conteneur.append(l);
    };
    const lettre = (/** @type {string} */ c) => {
      const aff = mode === "code" || (mode === "nom" && majuscule && /^\p{L}$/u.test(c)) ? c.toLocaleUpperCase("fr") : c;
      return touche(aff, () => taper(c));
    };

    if (mode === "code") {
      ajouterLigne(LIGNE_CODE.map(lettre));
      for (const l of LIGNES_LETTRES) ajouterLigne(l.filter((c) => /^[a-z]$/.test(c) && !"oi".includes(c)).map(lettre));
      ajouterLigne([touche("Effacer", effacer, "large", "Effacer le dernier caractère")]);
      return;
    }
    if (mode === "email") ajouterLigne(LIGNE_EMAIL.map(lettre));
    if (accents && mode === "nom") ajouterLigne(LIGNE_ACCENTS.map(lettre));
    for (const l of LIGNES_LETTRES) ajouterLigne(l.filter((c) => mode !== "email" || !"éè'".includes(c)).map(lettre));
    const derniere = [];
    if (mode === "nom") {
      derniere.push(touche(majuscule ? "abc" : "ABC", () => { majuscule = !majuscule; dessiner(); }, "", "Majuscules"));
      derniere.push(touche(accents ? "Accents ✓" : "Accents", () => { accents = !accents; dessiner(); }));
      derniere.push(touche("Espace", () => taper(" "), "large"));
    } else {
      derniere.push(...LIGNE_EMAIL_FIN.map((c) => touche(c, () => taper(c))));
    }
    derniere.push(touche("Effacer", effacer, "", "Effacer le dernier caractère"));
    ajouterLigne(derniere);
  };

  return {
    /**
     * Rattache le clavier à un champ.
     * @param {HTMLElement} element
     * @param {{ mode: ModeClavier, max?: number, valeur?: string, onChange?: (v: string) => void }} options
     */
    ouvrir(element, options) {
      champ = { element, mode: options.mode, max: options.max ?? 40, valeur: options.valeur ?? "", onChange: options.onChange };
      majuscule = options.mode === "nom" && champ.valeur === "";
      accents = false;
      afficherChamp();
      dessiner();
    },
    fermer() { champ = null; conteneur.replaceChildren(); },
    valeur: () => champ?.valeur ?? "",
  };
}
