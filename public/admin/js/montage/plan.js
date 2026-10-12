// @ts-check
// Parlomix : plan de montage. Logique pure (aucun accès au navigateur), testée avec Node.
// Le plan décrit le film à produire : cartes animées, extraits de réponses (blancs coupés), bandeaux, jingle.
// Le moteur de rendu de Parlorama l'exécute aujourd'hui ; un serveur de rendu pourra l'exécuter demain.

/**
 * @typedef {{ couleur: string, couleurBas?: string, texte: string }} FondTheme
 * @typedef {{
 *   marque: string, parole: string, fond: string, texte: string, surMarque: string, surParole: string,
 *   habille?: boolean, bulle?: string, surBulle?: string, policeTitres?: string, policeTexte?: string,
 *   titresLarges?: boolean, majuscules?: boolean, fonds?: Record<string, FondTheme>,
 *   jingle?: Jingle, ouverture?: string, fondOuverture?: string, visuelOuverture?: string
 * }} Theme  couleurs de la campagne ; avec un habillage : polices, bulles, capitales, fonds (fonds des cartes),
 *   jingle et titre d'ouverture du Parlomix par personne (habillage.parlomix)
 * @typedef {"parlobox" | "turbo"} Jingle
 * @typedef {[number, number]} Segment  début et fin en millisecondes dans la vidéo source
 * @typedef {{ id: string, etiquette: string, detail?: string, dureeMs: number, segments: Segment[], sessionId: string, fond?: string, visuel?: string }} Clip
 * @typedef {{ type: "carte", role: "intro" | "transition" | "fin", dureeMs: number, titre: string, sousTitre?: string, jingle: boolean, fond?: string, visuel?: string }} SequenceCarte
 * @typedef {{ type: "clip", reponseId: string, sessionId: string, segments: Segment[], bandeau: string | null, dureeMs: number }} SequenceClip
 * @typedef {SequenceCarte | SequenceClip} Sequence
 * @typedef {"16:9" | "9:16"} Format
 */

export const FORMATS = /** @type {const} */ ({ "16:9": { largeur: 1280, hauteur: 720 }, "9:16": { largeur: 720, hauteur: 1280 } });
export const DUREES = /** @type {const} */ ({ intro: 2200, transition: 1300, fin: 2000 });
/** Au-delà, le fichier devient trop lourd à envoyer depuis le navigateur (limite d'envoi de la plateforme). */
export const CLIPS_MAX = 20;

const DA = { marque: "#3F4C8F", parole: "#F2D27A", fond: "#F1F2F6", texte: "#23263F" };
/** Couleurs par défaut de chaque ambiance de la cabine (mêmes valeurs que cabine.css) ; « conversation » : DA. */
const DA_AMBIANCES = /** @type {Record<string, typeof DA>} */ ({
  pop: { marque: "#FF5C93", parole: "#FFD23F", fond: "#FFF4DA", texte: "#1B1A2E" },
  marine: { marque: "#FF6B3D", parole: "#FFD23F", fond: "#0F2B46", texte: "#F6F1E6" },
});
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Blanc ou encre selon la luminance (même règle que la cabine). */
export function contraste(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * /** @type {number} */ (r) + 0.7152 * /** @type {number} */ (g) + 0.0722 * /** @type {number} */ (b) > 0.4 ? "#23263F" : "#FFFFFF";
}

/** Polices auto-hébergées que l'habillage d'une campagne peut choisir (mêmes que la cabine). */
export const POLICES = /** @type {const} */ ({ fredoka: "Fredoka", gabarito: "Gabarito", michroma: "Michroma", inter: "Inter", "barlow-condensed": "Barlow Condensed", barlow: "Barlow" });
/** Polices de titre très larges : dessinées plus petites et en graisse normale. */
const POLICES_LARGES = new Set(["michroma"]);

/**
 * Thème du film : celui de la campagne (couleurs du client, puis habillage du parcours s'il y en a un),
 * sinon les couleurs de l'ambiance de la cabine (direction artistique Parlobox par défaut). L'habillage apporte aussi polices, capitales, couleur des bulles et
 * fonds : le Parlomix ressemble à la cabine.
 * @param {Record<string, unknown> | null | undefined} couleurs couleurs de la fiche client
 * @param {any} [habillage] habillage du parcours (parcours.habillage)
 * @param {string} [ambiance] ambiance du parcours (« conversation », « pop » ou « marine »)
 * @returns {Theme}
 */
export function themeDepuisCouleurs(couleurs, habillage = null, ambiance = "conversation") {
  const defaut = DA_AMBIANCES[ambiance] ?? DA;
  const c = { ...(couleurs ?? {}) };
  const hc = habillage?.couleurs ?? {};
  for (const [de, vers] of [["marque", "principale"], ["visiteur", "secondaire"], ["fond", "fond"], ["texte", "texte"]]) {
    if (typeof hc[/** @type {string} */ (de)] === "string" && HEX.test(hc[/** @type {string} */ (de)])) c[/** @type {string} */ (vers)] = hc[/** @type {string} */ (de)];
  }
  const choisir = (/** @type {string} */ cle, /** @type {string} */ defaut) => (typeof c[cle] === "string" && HEX.test(/** @type {string} */ (c[cle])) ? /** @type {string} */ (c[cle]) : defaut);
  const marque = choisir("principale", defaut.marque);
  const parole = choisir("secondaire", defaut.parole);
  /** @type {Theme} */
  const theme = { marque, parole, fond: choisir("fond", defaut.fond), texte: choisir("texte", defaut.texte), surMarque: contraste(marque), surParole: contraste(parole) };
  if (!habillage || typeof habillage !== "object") return theme;
  theme.habille = true;
  if (typeof hc.bulle === "string" && HEX.test(hc.bulle)) { theme.bulle = hc.bulle; theme.surBulle = contraste(hc.bulle); }
  const titres = POLICES[/** @type {keyof typeof POLICES} */ (habillage.polices?.titres)];
  const texte = POLICES[/** @type {keyof typeof POLICES} */ (habillage.polices?.texte)];
  if (titres) theme.policeTitres = titres;
  if (texte) theme.policeTexte = texte;
  if (POLICES_LARGES.has(habillage.polices?.titres)) theme.titresLarges = true;
  if (habillage.titresMajuscules === true) theme.majuscules = true;
  /** @type {Record<string, FondTheme>} */
  const fonds = {};
  for (const a of Array.isArray(habillage.fonds) ? habillage.fonds : []) {
    if (!a || typeof a.id !== "string" || !HEX.test(a.couleur) || !HEX.test(a.texte)) continue;
    fonds[a.id] = { couleur: a.couleur, texte: a.texte, ...(HEX.test(a.couleurBas ?? "") ? { couleurBas: a.couleurBas } : {}) };
  }
  if (Object.keys(fonds).length) theme.fonds = fonds;
  // Parlomix propre à la campagne : jingle et titre d'ouverture (« Le Salon de l'auto de {prenom} »).
  const pm = habillage.parlomix;
  if (pm && typeof pm === "object") {
    if (pm.jingle === "turbo" || pm.jingle === "parlobox") theme.jingle = pm.jingle;
    if (typeof pm.ouverture === "string" && pm.ouverture.trim()) theme.ouverture = pm.ouverture.trim();
    if (typeof pm.fond === "string" && theme.fonds?.[pm.fond]) theme.fondOuverture = pm.fond;
    if (typeof pm.visuel === "string") theme.visuelOuverture = pm.visuel;
  }
  return theme;
}

/** Titre de la carte d'ouverture d'un Parlomix par personne : celui de l'habillage avec son prénom, sinon le prénom. */
export function titreOuverture(/** @type {Theme} */ theme, /** @type {string} */ prenom) {
  if (!theme.ouverture) return prenom;
  return theme.ouverture.replace(/\{prenom\}/g, prenom).replace(/\s+/g, " ").trim();
}

/**
 * Visuel d'une réponse : celui de sa question ; pour « choix », celui de la dernière option choisie par la personne
 * (dans l'ordre du parcours) qui en a un. Même règle que l'écran de la cabine.
 * @param {string | undefined} visuel visuel de la question
 * @param {Record<string, string> | undefined} choixSession { étape → option } de la personne
 * @param {{ id: string, options: { id: string, visuel?: string }[] }[]} etapesChoix
 * @returns {string | undefined}
 */
export function visuelDeReponse(visuel, choixSession, etapesChoix) {
  if (!visuel) return undefined;
  if (visuel !== "choix") return visuel;
  for (const e of [...etapesChoix].reverse()) {
    const o = e.options.find((x) => x.id === choixSession?.[e.id]);
    if (o?.visuel) return o.visuel;
  }
  return undefined;
}

// ------------------------------------------------------------------ les blancs

/**
 * Niveau sonore (0 à 1, même échelle que le vumètre de la cabine) par tranche de `pasMs`.
 * @param {Float32Array} echantillons son mono
 * @param {number} frequence échantillons par seconde
 * @param {number} [pasMs]
 */
export function enveloppe(echantillons, frequence, pasMs = 20) {
  const taille = Math.max(1, Math.round((frequence * pasMs) / 1000));
  const n = Math.ceil(echantillons.length / taille);
  const niveaux = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let somme = 0;
    const fin = Math.min(echantillons.length, (i + 1) * taille);
    for (let j = i * taille; j < fin; j++) somme += /** @type {number} */ (echantillons[j]) ** 2;
    const rms = Math.sqrt(somme / Math.max(1, fin - i * taille));
    niveaux[i] = Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-8) + 50) / 40));
  }
  return niveaux;
}

/**
 * Passages où la personne parle : les blancs du début et de la fin disparaissent, les silences de plus de
 * `silenceMaxMs` au milieu sont raccourcis. Sans voix détectée, la réponse est gardée entière.
 * @param {ArrayLike<number>} niveaux
 * @param {{ pasMs?: number, seuil?: number, silenceMaxMs?: number, margeAvantMs?: number, margeApresMs?: number, dureeMs?: number }} [o]
 * @returns {Segment[]}
 */
export function segmentsParole(niveaux, o = {}) {
  const pas = o.pasMs ?? 20;
  const seuil = o.seuil ?? 0.3;
  const silenceMax = o.silenceMaxMs ?? 700;
  const avant = o.margeAvantMs ?? 150;
  const apres = o.margeApresMs ?? 300;
  const duree = o.dureeMs ?? niveaux.length * pas;
  /** @type {Segment[]} */
  const bruts = [];
  let debut = -1;
  for (let i = 0; i <= niveaux.length; i++) {
    const parle = i < niveaux.length && /** @type {number} */ (niveaux[i]) >= seuil;
    if (parle && debut < 0) debut = i;
    if (!parle && debut >= 0) { bruts.push([debut * pas, i * pas]); debut = -1; }
  }
  // Un bruit isolé de moins de 80 ms n'est pas de la parole.
  const voix = bruts.filter(([a, b]) => b - a >= 80);
  if (!voix.length) return [[0, duree]];
  /** @type {Segment[]} */
  const fusion = [];
  for (const s of voix) {
    const der = fusion[fusion.length - 1];
    if (der && s[0] - der[1] <= silenceMax) der[1] = s[1];
    else fusion.push([s[0], s[1]]);
  }
  /** @type {Segment[]} */
  const marges = fusion.map(([a, b]) => [Math.max(0, a - avant), Math.min(duree, b + apres)]);
  /** @type {Segment[]} */
  const fin = [];
  for (const s of marges) {
    const der = fin[fin.length - 1];
    if (der && s[0] <= der[1]) der[1] = Math.max(der[1], s[1]);
    else fin.push(s);
  }
  return fin;
}

export const dureeSegments = (/** @type {Segment[]} */ s) => s.reduce((n, [a, b]) => n + (b - a), 0);

// ------------------------------------------------------------------ choisir les réponses

/**
 * @typedef {{ id: string, etape_id: string, duree_ms: number | null, son_present: boolean | null }} ReponseApi
 * @typedef {{ id: string, prenom: string, cree_le: string, consent_diffusion: boolean, retiree_le: string | null, cabine_id: string | null, cabine_nom: string | null, reponses: ReponseApi[], choix?: Record<string, string> }} SessionApi
 * @typedef {{ id: string, titre: string, texte: string, fond?: string, visuel?: string }} QuestionApi
 * @typedef {{ id: string, options: { id: string, visuel?: string }[] }} EtapeChoixApi
 * @typedef {{ id: string, sessionId: string, etiquette: string, detail?: string, dureeMs: number, fond?: string, visuel?: string }} Choix
 */

/**
 * Réponses d'une personne, dans l'ordre du parcours.
 * Avec un habillage : le fond de chaque question et le visuel de la personne (ex. le modèle qu'elle a désigné).
 * @param {SessionApi} session
 * @param {QuestionApi[]} questions
 * @param {EtapeChoixApi[]} [etapesChoix]
 * @returns {Choix[]}
 */
export function choixParPersonne(session, questions, etapesChoix = []) {
  if (session.retiree_le) return [];
  return session.reponses.map((r) => {
    const q = questions.find((x) => x.id === r.etape_id);
    return {
      id: r.id, sessionId: session.id, etiquette: q?.titre ?? r.etape_id, detail: q?.texte, dureeMs: r.duree_ms ?? 0,
      ...habillageClip(q, session, etapesChoix),
    };
  });
}

/** Fond et visuel d'un extrait (seulement s'ils existent : le plan reste léger). */
function habillageClip(/** @type {QuestionApi | undefined} */ q, /** @type {SessionApi} */ s, /** @type {EtapeChoixApi[]} */ etapesChoix) {
  const visuel = visuelDeReponse(q?.visuel, s.choix, etapesChoix);
  return { ...(q?.fond ? { fond: q.fond } : {}), ...(visuel ? { visuel } : {}) };
}

/**
 * Réponses de plusieurs personnes à une même question, dans une campagne ou dans une seule cabine.
 * Les plus anciennes d'abord (ordre de passage), au plus CLIPS_MAX.
 * @param {SessionApi[]} sessions
 * @param {{ etape: string, cabine?: string | null, diffusionSeulement?: boolean, avecPrenoms?: boolean, max?: number, question?: QuestionApi, etapesChoix?: EtapeChoixApi[] }} o
 * @returns {Choix[]}
 */
export function choixParQuestion(sessions, o) {
  const retenues = sessions
    .filter((s) => !s.retiree_le && (!o.cabine || s.cabine_id === o.cabine) && (!o.diffusionSeulement || s.consent_diffusion))
    .slice()
    .sort((a, b) => a.cree_le.localeCompare(b.cree_le))
    .flatMap((s) => s.reponses.filter((r) => r.etape_id === o.etape).map((r) => ({ r, s })));
  return retenues.slice(-(o.max ?? CLIPS_MAX)).map(({ r, s }, i) => ({
    id: r.id, sessionId: s.id, etiquette: o.avecPrenoms === false ? `Avis n° ${i + 1}` : s.prenom, dureeMs: r.duree_ms ?? 0,
    ...habillageClip(o.question, s, o.etapesChoix ?? []),
  }));
}

// ------------------------------------------------------------------ le plan

/**
 * Plan du Parlomix. Une carte d'ouverture (avec jingle), puis les réponses séparées par une animation et le
 * jingle, puis une carte de fin.
 * @param {{ type: "personne" | "question", titre: string, sousTitre?: string, signature: string, clips: Clip[], format: Format, theme: Theme, bandeaux?: boolean }} o
 */
export function planParlomix(o) {
  // Habillage : l'ouverture prend le fond de la première réponse (et, pour une personne, son visuel) ;
  // chaque transition annonce la réponse suivante dans son fond, avec son visuel.
  const premier = o.clips[0];
  const habit = (/** @type {Clip | undefined} */ c, avecVisuel = true) => ({
    ...(c?.fond ? { fond: c.fond } : {}), ...(avecVisuel && c?.visuel ? { visuel: c.visuel } : {}),
  });
  // Le jingle « turbo » dure 3 s : l'ouverture dure autant que lui.
  const intro = o.theme.jingle === "turbo" ? DUREE_TURBO_MS : DUREES.intro;
  // L'habillage peut imposer le fond et le visuel de l'ouverture (ex. le dégradé et la voiture de la campagne).
  const ouverture = { ...habit(premier, o.type === "personne"),
    ...(o.theme.fondOuverture ? { fond: o.theme.fondOuverture } : {}), ...(o.theme.visuelOuverture ? { visuel: o.theme.visuelOuverture } : {}) };
  /** @type {Sequence[]} */
  const sequences = [{ type: "carte", role: "intro", dureeMs: intro, titre: o.titre, sousTitre: o.sousTitre, jingle: true, ...ouverture }];
  o.clips.forEach((c, i) => {
    if (i > 0) {
      sequences.push({
        type: "carte", role: "transition", dureeMs: DUREES.transition,
        titre: c.etiquette, sousTitre: o.type === "personne" ? c.detail : undefined, jingle: true, ...habit(c),
      });
    }
    const segments = c.segments.length ? c.segments : /** @type {Segment[]} */ ([[0, c.dureeMs]]);
    sequences.push({
      type: "clip", reponseId: c.id, sessionId: c.sessionId, segments,
      bandeau: o.bandeaux === false ? null : c.etiquette, dureeMs: dureeSegments(segments),
    });
  });
  sequences.push({ type: "carte", role: "fin", dureeMs: DUREES.fin, titre: o.signature, sousTitre: "Parlomix · by whyme", jingle: false, ...habit(premier, false) });
  return {
    version: 1,
    type: o.type,
    format: o.format,
    dimensions: FORMATS[o.format],
    theme: o.theme,
    sequences,
    dureeMs: sequences.reduce((n, s) => n + s.dureeMs, 0),
    sessions: [...new Set(o.clips.map((c) => c.sessionId))],
  };
}

/**
 * Recadrage 9:16 dans une image 16:9, centré sur le visage (ou au centre), sans sortir de l'image.
 * @param {number} largeur @param {number} hauteur @param {number} [centreX] position horizontale du visage (0 à 1)
 */
export function recadrage(largeur, hauteur, centreX = 0.5) {
  const sw = Math.min(largeur, Math.round((hauteur * 9) / 16));
  const sx = Math.round(Math.max(0, Math.min(largeur - sw, centreX * largeur - sw / 2)));
  return { sx, sy: 0, sw, sh: hauteur };
}

// ------------------------------------------------------------------ le jingle

/** Durée du jingle « turbo » d'ouverture, en millisecondes. */
export const DUREE_TURBO_MS = 3000;

/** Bruit blanc reproductible (même jingle à chaque montage). */
function bruit(graine = 1) {
  let x = graine >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2147483648 - 1; };
}

/**
 * Jingle « turbo », pour les campagnes automobiles (habillage.parlomix.jingle = "turbo"). Version longue (3 s,
 * ouverture) : un moteur qui monte en régime, un souffle, un arpège électro sur une grosse caisse à 150 battements
 * par minute, puis un accord final qui retombe. Version courte (0,9 s, entre les réponses) : souffle, quatre notes,
 * accord. Fabriqué par le code : il appartient à WhyMe, aucun droit à payer.
 * @param {number} [frequence] échantillons par seconde
 * @param {boolean} [court] version courte des transitions
 * @returns {Float32Array} son mono, crête à 0,6
 */
export function composerJingleTurbo(frequence = 48000, court = false) {
  const duree = court ? 0.9 : DUREE_TURBO_MS / 1000;
  const n = Math.round(duree * frequence);
  const son = new Float32Array(n);
  const ajouter = (/** @type {number} */ i, /** @type {number} */ v) => { if (i >= 0 && i < n) son[i] = /** @type {number} */ (son[i]) + v; };
  const alea = bruit(7);
  // Le moteur : dents de scie dont le régime monte (70 → 230 Hz), filtrées de plus en plus clair.
  const finMoteur = court ? 0 : 0.95;
  let phase = 0, filtre = 0;
  for (let i = 0; i < Math.round(finMoteur * frequence); i++) {
    const t = i / frequence, k = t / finMoteur;
    const f = 70 * Math.pow(230 / 70, k * k);
    phase = (phase + f / frequence) % 1;
    const scie = 2 * phase - 1 + 0.3 * Math.sin(2 * Math.PI * 23 * t); // petit tremblement du moteur
    const coupure = 0.02 + 0.25 * k;
    filtre += coupure * (scie - filtre);
    ajouter(i, 0.55 * Math.min(1, t / 0.05) * (0.4 + 0.6 * k) * filtre);
  }
  // Le souffle : bruit filtré qui passe.
  const souffle = court ? 0 : 0.85;
  let fs = 0;
  for (let i = 0; i < Math.round(0.35 * frequence); i++) {
    const t = i / frequence;
    fs += 0.25 * (alea() - fs);
    ajouter(Math.round(souffle * frequence) + i, 0.45 * Math.sin(Math.PI * Math.min(1, t / 0.35)) * fs);
  }
  // La grosse caisse : sinus qui plonge (120 → 45 Hz).
  const caisse = (/** @type {number} */ t0, gain = 0.8) => {
    let ph = 0;
    for (let i = 0; i < Math.round(0.22 * frequence); i++) {
      const t = i / frequence;
      ph += (2 * Math.PI * (45 + 75 * Math.exp(-t * 30))) / frequence;
      ajouter(Math.round(t0 * frequence) + i, gain * Math.sin(ph) * Math.exp(-t * 14));
    }
  };
  // Une note d'arpège : onde carrée adoucie, attaque nette, chute rapide.
  const note = (/** @type {number} */ t0, /** @type {number} */ f, longueur = 0.12, gain = 0.22) => {
    for (let i = 0; i < Math.round(longueur * frequence); i++) {
      const t = i / frequence;
      const v = Math.sin(2 * Math.PI * f * t) + 0.33 * Math.sin(2 * Math.PI * 3 * f * t) + 0.2 * Math.sin(2 * Math.PI * 5 * f * t);
      ajouter(Math.round(t0 * frequence) + i, gain * Math.min(1, t / 0.003) * Math.exp(-t * 18) * v);
    }
  };
  const charleston = (/** @type {number} */ t0) => {
    for (let i = 0; i < Math.round(0.04 * frequence); i++) ajouter(Math.round(t0 * frequence) + i, 0.12 * alea() * Math.exp(-i / frequence * 90));
  };
  // Arpège mi mineur, en doubles croches à 150 battements par minute (0,1 s), grosse caisse à chaque temps.
  const arpege = [659.25, 783.99, 987.77, 1318.51];
  const debutArpege = court ? 0.05 : 1.0;
  const pas = court ? 4 : 14;
  for (let k = 0; k < pas; k++) {
    const t0 = debutArpege + k * 0.1;
    note(t0, /** @type {number} */ (arpege[k % 4]) * (k >= 8 ? 1.12246 : 1));
    if (k % 4 === 0) caisse(t0);
    if (k % 2 === 1) charleston(t0);
  }
  // L'accord final (mi majeur), soutenu puis éteint en fondu.
  const finale = debutArpege + pas * 0.1;
  caisse(finale, 0.9);
  for (const f of [329.63, 415.3, 493.88, 659.25]) note(finale, f, duree - finale, 0.16);
  // Fondu de fin et normalisation.
  const fondu = Math.round(0.25 * frequence);
  for (let i = Math.max(0, n - fondu); i < n; i++) son[i] = /** @type {number} */ (son[i]) * ((n - i) / fondu);
  let crete = 0;
  for (const v of son) crete = Math.max(crete, Math.abs(v));
  if (crete > 0) for (let i = 0; i < n; i++) son[i] = (/** @type {number} */ (son[i]) / crete) * 0.6;
  return son;
}

/**
 * Jingle Parlobox : quatre notes de marimba qui montent (sol, do, mi, sol), une petite bulle qui éclate,
 * une queue de réverbération légère. Fabriqué par le code : il appartient à WhyMe, aucun droit à payer.
 * @param {number} [frequence] échantillons par seconde
 * @returns {Float32Array} son mono, crête à 0,6
 */
export function composerJingle(frequence = 48000) {
  const duree = 1.1;
  const n = Math.round(duree * frequence);
  const son = new Float32Array(n);
  const notes = [[0, 783.99], [0.085, 1046.5], [0.17, 1318.5], [0.28, 1567.98]];
  for (const [t0, f] of notes) {
    const debut = Math.round(/** @type {number} */ (t0) * frequence);
    for (let i = debut; i < n; i++) {
      const t = (i - debut) / frequence;
      const attaque = Math.min(1, t / 0.004);
      const corps = Math.exp(-t * 9);
      // Marimba : fondamentale, un peu de quatrième harmonique qui s'éteint vite.
      const v = Math.sin(2 * Math.PI * /** @type {number} */ (f) * t) + 0.18 * Math.sin(2 * Math.PI * /** @type {number} */ (f) * 4 * t) * Math.exp(-t * 40);
      son[i] = /** @type {number} */ (son[i]) + 0.32 * attaque * corps * v;
    }
  }
  // La bulle : un « pop » bref dont la hauteur monte.
  const pop = Math.round(0.4 * frequence);
  let phase = 0;
  for (let i = pop; i < Math.min(n, pop + Math.round(0.07 * frequence)); i++) {
    const t = (i - pop) / frequence;
    phase += (2 * Math.PI * (500 + 9000 * t)) / frequence;
    son[i] = /** @type {number} */ (son[i]) + 0.35 * Math.sin(phase) * Math.exp(-t * 60) * Math.min(1, t / 0.002);
  }
  // Réverbération légère : deux échos amortis.
  for (const [retard, gain] of [[0.11, 0.22], [0.23, 0.12]]) {
    const d = Math.round(/** @type {number} */ (retard) * frequence);
    for (let i = n - 1; i >= d; i--) son[i] = /** @type {number} */ (son[i]) + /** @type {number} */ (gain) * /** @type {number} */ (son[i - d]);
  }
  // Fondu de fin et normalisation.
  const fondu = Math.round(0.15 * frequence);
  for (let i = n - fondu; i < n; i++) son[i] = /** @type {number} */ (son[i]) * ((n - i) / fondu);
  let crete = 0;
  for (const v of son) crete = Math.max(crete, Math.abs(v));
  if (crete > 0) for (let i = 0; i < n; i++) son[i] = (/** @type {number} */ (son[i]) / crete) * 0.6;
  return son;
}
