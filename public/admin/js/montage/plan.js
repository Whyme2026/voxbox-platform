// @ts-check
// Parlomix : plan de montage. Logique pure (aucun accès au navigateur), testée avec Node.
// Le plan décrit le film à produire : cartes animées, extraits de réponses (blancs coupés), bandeaux, jingle.
// Le moteur de rendu de Parlorama l'exécute aujourd'hui ; un serveur de rendu pourra l'exécuter demain.

/**
 * @typedef {{ marque: string, parole: string, fond: string, texte: string, surMarque: string, surParole: string }} Theme
 * @typedef {[number, number]} Segment  début et fin en millisecondes dans la vidéo source
 * @typedef {{ id: string, etiquette: string, detail?: string, dureeMs: number, segments: Segment[], sessionId: string }} Clip
 * @typedef {{ type: "carte", role: "intro" | "transition" | "fin", dureeMs: number, titre: string, sousTitre?: string, jingle: boolean }} SequenceCarte
 * @typedef {{ type: "clip", reponseId: string, sessionId: string, segments: Segment[], bandeau: string | null, dureeMs: number }} SequenceClip
 * @typedef {SequenceCarte | SequenceClip} Sequence
 * @typedef {"16:9" | "9:16"} Format
 */

export const FORMATS = /** @type {const} */ ({ "16:9": { largeur: 1280, hauteur: 720 }, "9:16": { largeur: 720, hauteur: 1280 } });
export const DUREES = /** @type {const} */ ({ intro: 2200, transition: 1300, fin: 2000 });
/** Au-delà, le fichier devient trop lourd à envoyer depuis le navigateur (limite d'envoi de la plateforme). */
export const CLIPS_MAX = 20;

const DA = { marque: "#3F4C8F", parole: "#F2D27A", fond: "#F1F2F6", texte: "#23263F" };
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Blanc ou encre selon la luminance (même règle que la cabine). */
export function contraste(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * /** @type {number} */ (r) + 0.7152 * /** @type {number} */ (g) + 0.0722 * /** @type {number} */ (b) > 0.4 ? "#23263F" : "#FFFFFF";
}

/**
 * Thème du film : celui de la campagne (couleurs du client), sinon la direction artistique Parlopop.
 * @param {Record<string, unknown> | null | undefined} couleurs
 * @returns {Theme}
 */
export function themeDepuisCouleurs(couleurs) {
  const c = couleurs ?? {};
  const choisir = (/** @type {string} */ cle, /** @type {string} */ defaut) => (typeof c[cle] === "string" && HEX.test(/** @type {string} */ (c[cle])) ? /** @type {string} */ (c[cle]) : defaut);
  const marque = choisir("principale", DA.marque);
  const parole = choisir("secondaire", DA.parole);
  return { marque, parole, fond: choisir("fond", DA.fond), texte: choisir("texte", DA.texte), surMarque: contraste(marque), surParole: contraste(parole) };
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
 * @typedef {{ id: string, prenom: string, cree_le: string, consent_diffusion: boolean, retiree_le: string | null, cabine_id: string | null, cabine_nom: string | null, reponses: ReponseApi[] }} SessionApi
 * @typedef {{ id: string, titre: string, texte: string }} QuestionApi
 * @typedef {{ id: string, sessionId: string, etiquette: string, detail?: string, dureeMs: number }} Choix
 */

/**
 * Réponses d'une personne, dans l'ordre du parcours.
 * @param {SessionApi} session
 * @param {QuestionApi[]} questions
 * @returns {Choix[]}
 */
export function choixParPersonne(session, questions) {
  if (session.retiree_le) return [];
  const titre = (/** @type {string} */ id) => questions.find((q) => q.id === id)?.titre ?? id;
  const texte = (/** @type {string} */ id) => questions.find((q) => q.id === id)?.texte;
  return session.reponses.map((r) => ({ id: r.id, sessionId: session.id, etiquette: titre(r.etape_id), detail: texte(r.etape_id), dureeMs: r.duree_ms ?? 0 }));
}

/**
 * Réponses de plusieurs personnes à une même question, dans une campagne ou dans une seule cabine.
 * Les plus anciennes d'abord (ordre de passage), au plus CLIPS_MAX.
 * @param {SessionApi[]} sessions
 * @param {{ etape: string, cabine?: string | null, diffusionSeulement?: boolean, avecPrenoms?: boolean, max?: number }} o
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
  }));
}

// ------------------------------------------------------------------ le plan

/**
 * Plan du Parlomix. Une carte d'ouverture (avec jingle), puis les réponses séparées par une animation et le
 * jingle, puis une carte de fin.
 * @param {{ type: "personne" | "question", titre: string, sousTitre?: string, signature: string, clips: Clip[], format: Format, theme: Theme, bandeaux?: boolean }} o
 */
export function planParlomix(o) {
  /** @type {Sequence[]} */
  const sequences = [{ type: "carte", role: "intro", dureeMs: DUREES.intro, titre: o.titre, sousTitre: o.sousTitre, jingle: true }];
  o.clips.forEach((c, i) => {
    if (i > 0) {
      sequences.push({
        type: "carte", role: "transition", dureeMs: DUREES.transition,
        titre: c.etiquette, sousTitre: o.type === "personne" ? c.detail : undefined, jingle: true,
      });
    }
    const segments = c.segments.length ? c.segments : /** @type {Segment[]} */ ([[0, c.dureeMs]]);
    sequences.push({
      type: "clip", reponseId: c.id, sessionId: c.sessionId, segments,
      bandeau: o.bandeaux === false ? null : c.etiquette, dureeMs: dureeSegments(segments),
    });
  });
  sequences.push({ type: "carte", role: "fin", dureeMs: DUREES.fin, titre: o.signature, sousTitre: "Parlomix · by whyme", jingle: false });
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

/**
 * Jingle Parlopop : quatre notes de marimba qui montent (sol, do, mi, sol), une petite bulle qui éclate,
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
