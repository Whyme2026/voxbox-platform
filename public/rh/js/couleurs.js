// @ts-check
// Couleurs d'une feuille de style déduites des trois choisies (principale, fond, texte) : même calcul que
// src/whyme/styles.ts (couleursDepuis, contraste), pour l'aperçu en direct. Un test vérifie qu'ils concordent.

/** @param {string} h */
const versRvb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** @param {number[]} c */
const versHex = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
/** @param {string} a @param {string} b @param {number} t */
const melange = (a, b, t) => { const x = versRvb(a), y = versRvb(b); return versHex(x.map((v, i) => v + (/** @type {number} */ (y[i]) - v) * t)); };

/** @param {string} h */
function luminance(h) {
  const [r, g, b] = versRvb(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * /** @type {number} */ (r) + 0.7152 * /** @type {number} */ (g) + 0.0722 * /** @type {number} */ (b);
}

/** Rapport de contraste WCAG (1 à 21). @param {string} a @param {string} b */
export function contraste(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (/** @type {number} */ (x) + 0.05) / (/** @type {number} */ (y) + 0.05);
}

/** @param {{ accent: string, fond: string, titre: string }} b */
export function couleursDepuis(b) {
  return {
    accent: b.accent.toUpperCase(),
    accentFonce: melange(b.accent, "#000000", 0.25),
    accentPale: melange(b.accent, b.fond, 0.88),
    bulle: melange(b.titre, b.fond, 0.94),
    titre: b.titre.toUpperCase(),
    texte: melange(b.titre, b.fond, 0.22),
    fond: b.fond.toUpperCase(),
    fondFilm: melange(b.accent, b.fond, 0.95),
    discret: melange(b.titre, b.fond, 0.45),
    texteBulle: "#FFFFFF",
  };
}

/** Les mêmes contrôles que le serveur, dits avant d'enregistrer. @param {{ accent: string, fond: string, titre: string }} b */
export function problemesCouleurs(b) {
  /** @type {string[]} */ const p = [];
  if (contraste(b.accent, "#FFFFFF") < 3) p.push("Couleur principale trop claire : le texte blanc des boutons et de la bulle du film ne se lirait pas.");
  if (contraste(b.titre, b.fond) < 4.5) p.push("Le texte ne se lirait pas assez sur ce fond : foncez le texte ou éclaircissez le fond.");
  if (luminance(b.fond) < 0.6) p.push("Le fond doit rester clair.");
  return p;
}
