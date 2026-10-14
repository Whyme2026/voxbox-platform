// @ts-check
// Thèmes et parcours types (14/10/2026) : la règle qui met de l'ordre dans ce que l'on assemble.
//
//   gabarit    = la cabine elle-même (emplacements, tailles, écrans) : dans le code, unique, jamais par campagne ;
//   thème      = l'allure, la « feuille de style » : ambiance + habillage (polices, couleurs, fonds, visuels, Parlomix) ;
//   parcours   = le déroulé : les étapes et leurs textes, le tutoiement, la disposition des questions ;
//   campagne   = un thème + un parcours, versionnés ensemble et validés par le client.
//
// Changer de thème ne touche pas aux étapes ; partir d'un autre parcours ne touche pas au thème. Logique pure
// (aucun accès au navigateur), testée avec Node.

/** Ce qui, dans un parcours enregistré, relève du thème. */
export const CLES_THEME = /** @type {const} */ (["theme", "ambiance", "habillage"]);
/** Ce qui relève du parcours (le déroulé). */
export const CLES_PARCOURS = /** @type {const} */ (["tutoiement", "disposition", "etapes"]);

/**
 * @typedef {{ id?: string, nom?: string, description?: string, ambiance?: string, habillage?: any }} Theme
 * @typedef {{ id?: string, nom?: string, description?: string, tutoiement?: boolean, disposition?: string, etapes: any[] }} ParcoursType
 */

/** Le thème d'une configuration (pour le copier d'une campagne à l'autre). */
export function themeDe(/** @type {any} */ config) {
  /** @type {Theme} */
  const t = {};
  if (typeof config?.theme === "string") t.id = config.theme;
  if (config?.ambiance) t.ambiance = config.ambiance;
  if (config?.habillage) t.habillage = structuredClone(config.habillage);
  return t;
}

/** Le parcours d'une configuration, sans son thème. */
export function parcoursDe(/** @type {any} */ config) {
  /** @type {ParcoursType} */
  const p = { etapes: structuredClone(config?.etapes ?? []) };
  if (config?.tutoiement === true) p.tutoiement = true;
  if (config?.disposition) p.disposition = config.disposition;
  return p;
}

/**
 * Applique un thème : remplace ambiance et habillage, garde les étapes. Les fonds et visuels que le nouveau thème ne
 * connaît pas sont retirés des étapes et des options (l'écran prend alors le fond par défaut du thème).
 */
export function appliquerTheme(/** @type {any} */ config, /** @type {Theme} */ theme) {
  const c = structuredClone(config ?? {});
  for (const k of CLES_THEME) delete c[k];
  if (theme.id) c.theme = theme.id;
  if (theme.ambiance && theme.ambiance !== "conversation") c.ambiance = theme.ambiance;
  if (theme.habillage) c.habillage = structuredClone(theme.habillage);
  const fonds = new Set((theme.habillage?.fonds ?? []).map((/** @type {any} */ f) => f.id));
  const visuels = new Set((theme.habillage?.visuels ?? []).map((/** @type {any} */ v) => v.id));
  const nettoyer = (/** @type {any} */ x, /** @type {boolean} */ etape) => {
    if (x.fond !== undefined && !fonds.has(x.fond)) delete x.fond;
    if (x.visuel !== undefined && !visuels.has(x.visuel) && !(etape && x.visuel === "choix")) delete x.visuel;
  };
  c.etapes = (c.etapes ?? []).map((/** @type {any} */ e) => {
    nettoyer(e, true);
    if (Array.isArray(e.options)) e.options.forEach((/** @type {any} */ o) => nettoyer(o, false));
    return e;
  });
  return c;
}

/** Part d'un parcours type : remplace les étapes, le tutoiement et la disposition, garde le thème. */
export function appliquerParcours(/** @type {any} */ config, /** @type {ParcoursType} */ type) {
  const c = structuredClone(config ?? {});
  for (const k of CLES_PARCOURS) delete c[k];
  if (type.tutoiement === true) c.tutoiement = true;
  if (type.disposition) c.disposition = type.disposition;
  c.etapes = structuredClone(type.etapes);
  // Les renvois vers des fonds et visuels du thème en place restent valables ; les autres sont retirés.
  return appliquerTheme(c, themeDe(c));
}

/**
 * Nom à afficher pour le thème d'une configuration : celui du catalogue, « Personnalisé » si l'habillage n'a pas
 * d'étiquette de thème, « Parlobox (neutre) » sans habillage ni ambiance.
 * @param {any} config
 * @param {{ id: string, nom: string }[]} themes
 */
export function nomDuTheme(config, themes) {
  const t = themes.find((x) => x.id === config?.theme);
  if (t) return t.nom;
  if (!config?.habillage && (!config?.ambiance || config.ambiance === "conversation")) return themes.find((x) => x.id === "parlobox")?.nom ?? "Parlobox (neutre)";
  return "Propre à la campagne";
}
