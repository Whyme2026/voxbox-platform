// @ts-check
// Moteur de parcours : logique pure (aucun accès au navigateur), testée avec Node.
// Il dit quelle étape vient ensuite et où l'on en est ; l'affichage est fait par app.js.

/**
 * @typedef {{ id: string, type: string, suite?: string, options?: { id: string, libelle: string, suite: string }[], [k: string]: unknown }} Etape
 * @typedef {{ version: 1, langue: string, etapes: Etape[] }} Parcours
 */

/** @param {Parcours} parcours */
export function creerMoteur(parcours) {
  const etapes = parcours.etapes;
  const index = new Map(etapes.map((e, i) => [e.id, i]));

  /** @param {string} id */
  const etape = (id) => {
    const i = index.get(id);
    if (i === undefined) throw new Error(`Étape inconnue : ${id}`);
    return /** @type {Etape} */ (etapes[i]);
  };

  /**
   * Étape suivante. Pour un choix, `choixId` est obligatoire.
   * @param {string} id
   * @param {string} [choixId]
   * @returns {string | null} null à la fin du parcours
   */
  const suivante = (id, choixId) => {
    const e = etape(id);
    if (e.type === "fin") return null;
    if (e.type === "choix") {
      const o = e.options?.find((x) => x.id === choixId);
      if (!o) throw new Error(`Choix inconnu « ${choixId} » pour l'étape ${id}`);
      return o.suite;
    }
    if (e.suite) return e.suite;
    const i = /** @type {number} */ (index.get(id));
    return etapes[i + 1]?.id ?? null;
  };

  /**
   * Questions restant à jouer à partir d'une étape (en suivant la première option des choix).
   * Sert à afficher « question 2 sur 4 ».
   * @param {string} depuis
   */
  const questionsSurLeChemin = (depuis) => {
    /** @type {string[]} */
    const vues = [];
    /** @type {string | null} */
    let id = depuis;
    let garde = 0;
    while (id && garde++ < etapes.length * 2) {
      const e = etape(id);
      if (e.type === "question") vues.push(e.id);
      id = e.type === "choix" ? (e.options?.[0]?.suite ?? null) : suivante(id);
    }
    return vues;
  };

  /** Position d'une question dans le parcours complet du visiteur. */
  const progression = (/** @type {string} */ questionId, /** @type {string[]} */ dejaRepondues) => {
    const restantes = questionsSurLeChemin(questionId);
    const numero = dejaRepondues.filter((q) => q !== questionId).length + 1;
    return { numero, total: numero - 1 + restantes.length };
  };

  return { premiere: () => etapes[0]?.id ?? null, etape, suivante, progression, questionsSurLeChemin };
}

/** Le parcours propose-t-il la case « diffusion publique » ? */
export function diffusionProposee(/** @type {Parcours} */ p) {
  return p.etapes.some((e) => e.type === "consentement" && e.proposerDiffusion === true);
}
