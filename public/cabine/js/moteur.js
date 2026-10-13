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
   * Questions restant à jouer à partir d'une étape. Aux embranchements, le chemin le plus court est retenu :
   * « question 1 sur 3 » plutôt que de compter une suite facultative (ex. « revenez après l'essai »).
   * Sert à afficher « question 2 sur 4 ».
   * @param {string} depuis
   * @returns {string[]}
   */
  const questionsSurLeChemin = (depuis) => {
    /** @type {Map<string, string[]>} */
    const memo = new Map();
    /** @param {string | null} id @param {Set<string>} enCours @returns {string[] | null} null : boucle */
    const chemin = (id, enCours) => {
      if (!id) return [];
      const deja = memo.get(id);
      if (deja) return deja;
      if (enCours.has(id)) return null;
      enCours.add(id);
      const e = etape(id);
      const suites = e.type === "choix" ? (e.options ?? []).map((o) => o.suite) : [suivante(id)];
      /** @type {string[] | null} */ let meilleur = null;
      for (const s of suites) {
        const c = chemin(s, enCours);
        if (c && (!meilleur || c.length < meilleur.length)) meilleur = c;
      }
      enCours.delete(id);
      if (!meilleur) return null;
      const res = e.type === "question" ? [e.id, ...meilleur] : meilleur;
      memo.set(id, res);
      return res;
    };
    return chemin(depuis, new Set()) ?? [];
  };

  /** Position d'une question dans le parcours complet du visiteur. */
  const progression = (/** @type {string} */ questionId, /** @type {string[]} */ dejaRepondues) => {
    const restantes = questionsSurLeChemin(questionId);
    const numero = dejaRepondues.filter((q) => q !== questionId).length + 1;
    return { numero, total: numero - 1 + restantes.length };
  };

  return { premiere: () => etapes[0]?.id ?? null, etape, suivante, progression, questionsSurLeChemin };
}

/**
 * Remplace {prenom} dans un texte du parcours. Sans prénom, l'emplacement disparaît proprement :
 * « Merci {prenom}, c'est dans la boîte » → « Merci, c'est dans la boîte ».
 * @param {string} texte
 * @param {string} prenom
 */
export function personnaliser(texte, prenom) {
  const p = prenom.trim();
  return p ? texte.replaceAll("{prenom}", p) : texte.replace(/[  ]?\{prenom\}/g, "");
}

/**
 * Sépare le chiffre de tête d'une consigne, affiché en grand : « 30 s pour répondre » → { chiffre: "30 s", reste: "pour répondre" }.
 * @param {string} texte
 * @returns {{ chiffre: string | null, reste: string }}
 */
export function decouperConsigne(texte) {
  const m = /^(\d+(?:[  ]?s(?=[  ]))?)[  ]+(.+)$/s.exec(texte.trim());
  return m ? { chiffre: /** @type {string} */ (m[1]).replace(/[  ]/, " "), reste: /** @type {string} */ (m[2]) } : { chiffre: null, reste: texte.trim() };
}

/** Le parcours propose-t-il la case « diffusion publique » ? */
export function diffusionProposee(/** @type {Parcours} */ p) {
  return p.etapes.some((e) => (e.type === "consentement" && e.proposerDiffusion === true)
    || (e.type === "identification" && e.accord === true && e.proposerDiffusion === true));
}

/**
 * Visuel à afficher sur une étape : le sien, ou pour « choix » celui de la dernière option choisie qui en a un
 * (ex. le modèle que le visiteur vient de désigner). Renvoie l'identifiant du visuel, ou null.
 * @param {Parcours} p
 * @param {{ visuel?: unknown }} etape
 * @param {{ etape: string, option: string }[]} choixFaits dans l'ordre où le visiteur les a faits
 * @returns {string | null}
 */
export function visuelDeLEtape(p, etape, choixFaits) {
  if (typeof etape.visuel !== "string") return null;
  if (etape.visuel !== "choix") return etape.visuel;
  for (let i = choixFaits.length - 1; i >= 0; i--) {
    const c = /** @type {{ etape: string, option: string }} */ (choixFaits[i]);
    const e = p.etapes.find((x) => x.id === c.etape);
    const o = /** @type {{ id: string, visuel?: unknown }[] | undefined} */ (e?.options)?.find((x) => x.id === c.option);
    if (typeof o?.visuel === "string") return o.visuel;
  }
  return null;
}
