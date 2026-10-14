// @ts-check
// Parlomix : moteur de rendu dans le navigateur (Parlorama). Exécute un plan de montage (plan.js) :
// les réponses sont jouées dans une vidéo cachée et dessinées dans un canevas, les cartes animées aux couleurs
// de la campagne sont dessinées entre elles, le jingle est mêlé au son, et le tout est enregistré.
// Les coupes sont franches : l'enregistrement est mis en pause pendant chaque recherche dans la vidéo source.
// Rien n'est chargé depuis internet.

import { composerJingle, composerJingleTurbo, enveloppe, segmentsParole, recadrage, SONS } from "./plan.js";

/** @typedef {import("./plan.js").Theme} Theme */
/** @typedef {ReturnType<typeof import("./plan.js").planParlomix>} Plan */

/** Formats d'enregistrement essayés dans l'ordre : MP4 (lisible partout), puis WebM. */
const FORMATS = [
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
const IMAGES_PAR_SECONDE = 30;

export function formatsDisponibles() {
  if (typeof MediaRecorder === "undefined") return [];
  return FORMATS.filter((f) => MediaRecorder.isTypeSupported(f));
}

/** Contexte audio unique pour l'analyse (décodage du son des réponses). */
/** @type {AudioContext | null} */ let contexteAnalyse = null;

/**
 * Analyse d'une réponse : durée réelle et passages de parole (les blancs à couper).
 * La durée vient du son décodé : les fichiers enregistrés par la cabine n'annoncent pas leur durée.
 * @param {Blob} blob
 */
export async function analyserReponse(blob) {
  contexteAnalyse ??= new AudioContext();
  try {
    const son = await contexteAnalyse.decodeAudioData(await blob.arrayBuffer());
    const canal = son.getChannelData(0);
    const dureeMs = Math.round(son.duration * 1000);
    return { dureeMs, segments: segmentsParole(enveloppe(canal, son.sampleRate, 20), { dureeMs }) };
  } catch {
    // Son illisible : on garde la vidéo entière, sa durée sera lue à la lecture.
    return { dureeMs: 0, segments: /** @type {[number, number][]} */ ([]) };
  }
}

/**
 * Le film contient-il vraiment du son ? (leçon Geely : un MP4 peut perdre le son sans erreur)
 * @param {Blob} blob
 */
export async function contientDuSon(blob) {
  contexteAnalyse ??= new AudioContext();
  try {
    const son = await contexteAnalyse.decodeAudioData(await blob.arrayBuffer());
    const canal = son.getChannelData(0);
    let crete = 0;
    for (let i = 0; i < canal.length; i += 64) crete = Math.max(crete, Math.abs(/** @type {number} */ (canal[i])));
    return crete > 0.02;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ dessin

const lisse = (/** @type {number} */ t) => t * t * (3 - 2 * t);
/** Arrivée avec un léger rebond (0 → 1, dépasse un peu puis revient). */
function rebond(/** @type {number} */ t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c = 1.7;
  const x = t - 1;
  return 1 + (c + 1) * x ** 3 + c * x ** 2;
}

/** Tracé d'une bulle : coins ronds, un coin presque droit côté queue, et la queue. */
function bulle(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ l, /** @type {number} */ h, /** @type {number} */ r, cote = "gauche") {
  const q = Math.min(r, h / 2);
  const coin = Math.max(4, q * 0.18);
  ctx.beginPath();
  if (cote === "gauche") {
    ctx.roundRect(x, y, l, h, [q, q, q, coin]);
    ctx.moveTo(x + 2, y + h);
    ctx.bezierCurveTo(x - q * 0.15, y + h, x - q * 0.45, y + h, x - q * 0.5, y + h);
    ctx.bezierCurveTo(x - q * 0.1, y + h - q * 0.15, x + 2, y + h - q * 0.45, x + 2, y + h - q * 0.6);
  } else {
    ctx.roundRect(x, y, l, h, [q, q, coin, q]);
    ctx.moveTo(x + l - 2, y + h);
    ctx.bezierCurveTo(x + l + q * 0.15, y + h, x + l + q * 0.45, y + h, x + l + q * 0.5, y + h);
    ctx.bezierCurveTo(x + l + q * 0.1, y + h - q * 0.15, x + l - 2, y + h - q * 0.45, x + l - 2, y + h - q * 0.6);
  }
  ctx.fill();
}

/** Découpe un texte en lignes qui tiennent dans `largeur`. */
function lignes(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {string} */ texte, /** @type {number} */ largeur, max = 3) {
  const mots = texte.split(/\s+/).filter(Boolean);
  /** @type {string[]} */ const res = [];
  let courante = "";
  for (const m of mots) {
    const essai = courante ? `${courante} ${m}` : m;
    if (ctx.measureText(essai).width <= largeur || !courante) courante = essai;
    else { res.push(courante); courante = m; }
  }
  if (courante) res.push(courante);
  if (res.length > max) { res.length = max; res[max - 1] = `${res[max - 1]}…`; }
  return res;
}

/** Barres d'onde (le motif de la marque), animées. */
function onde(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {number} */ cx, /** @type {number} */ cy, /** @type {number} */ taille, /** @type {number} */ t, /** @type {string} */ couleur, nb = 5) {
  const largeur = taille * 0.11;
  const ecart = taille * 0.07;
  const total = nb * largeur + (nb - 1) * ecart;
  ctx.fillStyle = couleur;
  for (let i = 0; i < nb; i++) {
    const h = taille * (0.3 + 0.7 * Math.abs(Math.sin(t * 7 + i * 1.3)));
    ctx.beginPath();
    ctx.roundRect(cx - total / 2 + i * (largeur + ecart), cy - h / 2, largeur, h, largeur / 2);
    ctx.fill();
  }
}

/** Petites bulles pâles qui flottent en fond. */
function decor(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {number} */ W, /** @type {number} */ H, /** @type {number} */ t, /** @type {Theme} */ th) {
  const u = Math.min(W, H);
  const bulles = [[0.82, 0.2, 0.22, th.marque], [0.12, 0.78, 0.16, th.parole], [0.9, 0.82, 0.1, th.parole], [0.18, 0.18, 0.08, th.marque]];
  for (const [i, [x, y, s, c]] of bulles.entries()) {
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = /** @type {string} */ (c);
    const dy = Math.sin(t * 1.6 + i) * u * 0.012;
    const l = /** @type {number} */ (s) * u * 1.2;
    bulle(ctx, /** @type {number} */ (x) * W - l / 2, /** @type {number} */ (y) * H - l * 0.4 + dy, l, l * 0.72, l * 0.22, i % 2 ? "droite" : "gauche");
  }
  ctx.globalAlpha = 1;
}

/** Police d'un titre (habillage : police de la campagne, plus petite et en graisse normale si elle est très large). */
function policeTitre(/** @type {Theme} */ th, /** @type {number} */ taille) {
  const famille = th.policeTitres ? `"${th.policeTitres}"` : "Fredoka";
  return th.titresLarges ? `400 ${Math.round(taille * 0.74)}px ${famille}, sans-serif` : `600 ${Math.round(taille)}px ${famille}, sans-serif`;
}
const policeTexte = (/** @type {Theme} */ th, /** @type {number} */ taille, poids = 500) => `${poids} ${Math.round(taille)}px ${th.policeTexte ? `"${th.policeTexte}"` : "Gabarito"}, sans-serif`;
const casse = (/** @type {Theme} */ th, /** @type {string} */ t) => (th.majuscules ? t.toLocaleUpperCase("fr") : t);

/** Fond d'une carte : son fond (couleur ou dégradé vertical) ; renvoie la couleur du texte posé dessus. */
function fondCarte(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {number} */ W, /** @type {number} */ H, /** @type {Theme} */ th, /** @type {string | undefined} */ fond) {
  const a = fond ? th.fonds?.[fond] : undefined;
  if (a?.couleurBas) {
    const d = ctx.createLinearGradient(0, 0, 0, H);
    d.addColorStop(0, a.couleur);
    d.addColorStop(1, a.couleurBas);
    ctx.fillStyle = d;
  } else {
    ctx.fillStyle = a?.couleur ?? th.fond;
  }
  ctx.fillRect(0, 0, W, H);
  return a?.texte ?? th.texte;
}

/** Bulle de la marque (sa couleur d'habillage si elle en a une, avec une ombre douce si elle est claire). */
function bulleMarque(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {Theme} */ th, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ l, /** @type {number} */ h, /** @type {number} */ r) {
  ctx.save();
  ctx.fillStyle = th.bulle ?? th.marque;
  if (th.bulle && (th.surBulle ?? "#FFFFFF") !== "#FFFFFF") {
    ctx.shadowColor = "rgba(0, 0, 0, .18)";
    ctx.shadowBlur = r * 0.6;
    ctx.shadowOffsetY = r * 0.15;
  }
  bulle(ctx, x, y, l, h, r);
  ctx.restore();
  return th.surBulle ?? th.surMarque;
}

/** Visuel (ex. le modèle), centré sur (cx, cy), qui glisse en arrivant. */
function dessinerVisuel(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {HTMLImageElement | undefined} */ img, /** @type {number} */ cx, /** @type {number} */ cy, /** @type {number} */ largeur, /** @type {number} */ apparition) {
  if (!img || !img.complete || !img.naturalWidth || apparition <= 0) return;
  const hauteur = largeur * (img.naturalHeight / img.naturalWidth);
  ctx.save();
  ctx.globalAlpha *= Math.min(1, apparition);
  ctx.drawImage(img, cx - largeur / 2 - (1 - apparition) * largeur * 0.25, cy - hauteur / 2, largeur, hauteur);
  ctx.restore();
}

/** Fuchsia whyme (« me » de la signature), même valeur que la cabine. */
const FUCHSIA_WHYME = "#C4007A";

/**
 * Logo « parlobox by whyme » : texte seul, Inter, minuscules, « me » de whyme en fuchsia (règle du 14/10/2026,
 * comme la cabine). Dessiné à gauche de x, centré verticalement sur y ; renvoie sa largeur.
 * @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} taille corps de « parlobox »
 * @param {string} encre couleur du texte @param {boolean} [mesurer] ne rien dessiner, seulement mesurer
 */
export function dessinerLogoParlobox(ctx, x, y, taille, encre, mesurer = false) {
  const morceaux = /** @type {const} */ ([
    ["parlobox", `700 ${Math.round(taille)}px "Inter", sans-serif`, encre, 1],
    [" by ", `500 ${Math.round(taille * 0.6)}px "Inter", sans-serif`, encre, 0.62],
    ["why", `700 ${Math.round(taille * 0.82)}px "Inter", sans-serif`, encre, 1],
    ["me", `700 ${Math.round(taille * 0.82)}px "Inter", sans-serif`, FUCHSIA_WHYME, 1],
  ]);
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let l = 0;
  for (const [mot, police, couleur, alpha] of morceaux) {
    ctx.font = police;
    if (!mesurer) { ctx.fillStyle = couleur; ctx.globalAlpha *= alpha; ctx.fillText(mot, x + l, y + taille * 0.36); ctx.globalAlpha /= alpha; }
    l += ctx.measureText(mot).width;
  }
  ctx.restore();
  return l;
}

/**
 * Filigranes, sur chaque image du film (règle du 13/10/2026) : le client en haut à gauche (son logo, sinon son nom),
 * « Parlobox by whyme » en haut à droite. Pastilles blanches translucides : lisibles sur la vidéo comme sur les cartes.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Theme} th
 * @param {HTMLImageElement | null} logo
 */
export function dessinerFiligranes(ctx, th, logo) {
  const { width: W, height: H } = ctx.canvas;
  const u = Math.min(W, H);
  const marge = u * 0.035;
  const h = u * 0.062;
  const pad = h * 0.28;
  const pastille = (/** @type {number} */ x, /** @type {number} */ l) => {
    ctx.fillStyle = "rgba(255, 255, 255, .86)";
    ctx.beginPath();
    ctx.roundRect(x, marge, l, h, h * 0.28);
    ctx.fill();
  };
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  // En haut à gauche : le nom de l'évènement s'il y en a un, seul ; sinon le client (logo, à défaut son nom).
  const nomGauche = th.evenement ?? (logo && logo.complete && logo.naturalWidth ? null : th.client);
  if (nomGauche) {
    ctx.font = policeTitre(th, h * 0.5);
    const nom = casse(th, nomGauche);
    pastille(marge, ctx.measureText(nom).width + 2 * pad);
    ctx.fillStyle = th.texte;
    ctx.fillText(nom, marge + pad, marge + h / 2);
  } else if (logo && logo.complete && logo.naturalWidth) {
    const hl = h - 2 * pad;
    const ll = Math.min(u * 0.3, (logo.naturalWidth / logo.naturalHeight) * hl);
    pastille(marge, ll + 2 * pad);
    ctx.drawImage(logo, marge + pad, marge + pad, ll, ll / (logo.naturalWidth / logo.naturalHeight));
  }
  // La plateforme : son logo « parlobox by whyme ».
  const corps = h * 0.42;
  const ll = dessinerLogoParlobox(ctx, 0, 0, corps, "#303136", true);
  const x = W - marge - (ll + 2 * pad);
  pastille(x, ll + 2 * pad);
  dessinerLogoParlobox(ctx, x + pad, marge + h / 2, corps, "#303136");
  ctx.restore();
}

/**
 * Carte animée (ouverture, transition, fin).
 * @param {CanvasRenderingContext2D} ctx
 * @param {import("./plan.js").SequenceCarte} carte
 * @param {number} t progression de 0 à 1
 * @param {Theme} th
 * @param {HTMLImageElement | null} logo
 * @param {Map<string, HTMLImageElement>} [visuels] visuels de l'habillage, par identifiant
 */
export function dessinerCarte(ctx, carte, t, th, logo, visuels = new Map()) {
  const { width: W, height: H } = ctx.canvas;
  const u = Math.min(W, H);
  const secondes = (t * carte.dureeMs) / 1000;
  const encre = fondCarte(ctx, W, H, th, carte.fond);
  const visuel = carte.visuel ? visuels.get(carte.visuel) : undefined;
  const portrait = H > W;

  if (carte.role === "transition") {
    // Une bulle aux couleurs de la marque surgit, porte le titre, puis s'efface vers la suite ; le visuel glisse dessous.
    if (!th.habille) decor(ctx, W, H, secondes, th);
    const entree = rebond(Math.min(1, t / 0.32));
    const sortie = t > 0.78 ? lisse((t - 0.78) / 0.22) : 0;
    const echelle = entree * (1 - sortie * 0.15);
    const cy = visuel ? H * (portrait ? 0.4 : 0.36) : H / 2;
    ctx.save();
    ctx.globalAlpha = 1 - sortie;
    ctx.translate(W / 2, cy);
    ctx.scale(echelle, echelle);
    // La question en entier dans la bulle (4 lignes au plus), sans son nom court (14/10/2026 : jamais visible dans
    // le film) ; sans question (Parlomix par question : un prénom), le titre seul, en grand.
    const question = carte.sousTitre;
    // Corps de la question agrandi (débrief PFA, 14/10/2026) : lisible d'un coup d'œil, même sur un téléphone.
    ctx.font = policeTitre(th, u * (question ? 0.095 : 0.1));
    const textes = lignes(ctx, casse(th, question ?? carte.titre), W * (portrait ? 0.8 : 0.86), question ? 4 : 2);
    const hl = u * (question ? 0.108 : 0.115);
    const lb = Math.min(W * 0.96, Math.max(...textes.map((x) => ctx.measureText(x).width)) + u * 0.14);
    const hb = textes.length * hl + u * 0.12;
    ctx.fillStyle = bulleMarque(ctx, th, -lb / 2, -hb / 2, lb, hb, u * 0.07);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    textes.forEach((x, i) => ctx.fillText(x, 0, -hb / 2 + u * 0.06 + hl * (i + 0.5)));
    ctx.restore();
    ctx.globalAlpha = 1 - sortie;
    if (visuel) dessinerVisuel(ctx, visuel, W / 2, H * (portrait ? 0.66 : 0.7), Math.min(W * (portrait ? 0.8 : 0.42), u * 0.95), rebond(Math.min(1, Math.max(0, (t - 0.08) / 0.35))));
    onde(ctx, W / 2, visuel ? H * (portrait ? 0.86 : 0.9) : H / 2 + u * 0.27, u * 0.12, secondes, th.parole);
    ctx.globalAlpha = 1;
    dessinerFiligranes(ctx, th, logo);
    return;
  }

  if (carte.role === "fin" && carte.signature) return dessinerSignature(ctx, carte, t, th, logo, encre, visuel);

  // Ouverture et fin : décor, grande bulle, visuel, onde (le client et Parlobox sont en filigrane).
  if (!th.habille) decor(ctx, W, H, secondes, th);
  // Ouverture sur un son fourni : chaque image arrive sur un coup du son (carte.temps, en millisecondes).
  const rep = carte.role === "intro" ? carte.temps : undefined;
  const ms = secondes * 1000;
  const depuis = (/** @type {number} */ debut, /** @type {number} */ duree) => Math.min(1, Math.max(0, (ms - debut) / duree));
  if (rep) effetsSon(ctx, W, H, u, ms, rep);
  const apparition = rep ? rebond(depuis(rep.titre, 260)) : rebond(Math.min(1, t / 0.25));
  const disparition = carte.role === "fin" ? 0 : rep ? lisse(depuis(carte.dureeMs - 450, 450)) : t > 0.85 ? lisse((t - 0.85) / 0.15) : 0;
  ctx.save();
  if (rep) ctx.translate(...secousse(ms, rep.eclats, u));
  ctx.globalAlpha = 1 - disparition;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cy = visuel ? H * (portrait ? 0.32 : 0.34) : H * (portrait ? 0.45 : 0.47);

  ctx.translate(W / 2, cy);
  ctx.scale(apparition, apparition);
  ctx.font = policeTitre(th, u * (carte.role === "fin" ? 0.075 : 0.095));
  const textes = lignes(ctx, casse(th, carte.titre), W * 0.72, 3);
  const hl = u * (carte.role === "fin" ? 0.09 : 0.11);
  const lb = Math.min(W * 0.86, Math.max(...textes.map((x) => ctx.measureText(x).width)) + u * 0.16);
  const hb = textes.length * hl + u * 0.12;
  ctx.fillStyle = bulleMarque(ctx, th, -lb / 2, -hb / 2, lb, hb, u * 0.08);
  textes.forEach((x, i) => ctx.fillText(x, 0, -hb / 2 + u * 0.06 + hl * (i + 0.5)));
  ctx.restore();

  if (carte.sousTitre) {
    ctx.save();
    ctx.globalAlpha = (rep ? lisse(depuis(rep.sousTitre, 220)) : Math.min(1, Math.max(0, (t - 0.15) / 0.2))) * (1 - disparition);
    if (rep) ctx.translate(0, (1 - lisse(depuis(rep.sousTitre, 220))) * u * 0.03);
    ctx.fillStyle = encre;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = policeTexte(th, u * 0.04);
    lignes(ctx, carte.sousTitre, W * 0.8, 2).forEach((x, i) => ctx.fillText(x, W / 2, cy + u * 0.2 + i * u * 0.055));
    ctx.restore();
  }
  ctx.globalAlpha = 1 - disparition;
  if (visuel) dessinerVisuel(ctx, visuel, W / 2, H * (portrait ? 0.62 : 0.68), Math.min(W * (portrait ? 0.8 : 0.42), u * 0.95), rep ? rebond(depuis(rep.visuel, 320)) : rebond(Math.min(1, Math.max(0, (t - 0.12) / 0.3))));
  if (!rep || ms >= rep.titre) onde(ctx, W / 2, H * (portrait ? 0.8 : 0.86), u * 0.1, secondes, th.parole, 7);
  ctx.globalAlpha = 1;
  if (rep) eclairs(ctx, W, H, ms, rep.eclats);
  dessinerFiligranes(ctx, th, logo);
}

/**
 * Écran de fin « signature » (débrief PFA, 14/10/2026) : il boucle le film sur le décor de l'ouverture. Le visuel de
 * l'ouverture (la voiture) revient en glissant, le nom de l'opération s'affiche en grand dans la police des titres,
 * le client au-dessus dans sa pastille, et le logo « parlobox by whyme » (couleurs d'origine, « me » fuchsia) dans une
 * pastille blanche en bas. Les marques sont au centre : pas de filigranes en plus.
 * @param {CanvasRenderingContext2D} ctx @param {import("./plan.js").SequenceCarte} carte @param {number} t
 * @param {Theme} th @param {HTMLImageElement | null} logo @param {string} encre couleur du texte sur ce fond
 * @param {HTMLImageElement | undefined} visuel visuel de l'ouverture
 */
function dessinerSignature(ctx, carte, t, th, logo, encre, visuel) {
  const { width: W, height: H } = ctx.canvas;
  const u = Math.min(W, H);
  const portrait = H > W;
  const ms = t * carte.dureeMs;
  const depuis = (/** @type {number} */ debut, /** @type {number} */ duree) => Math.min(1, Math.max(0, (ms - debut) / duree));
  // Repères verticaux : client, opération, visuel, logo.
  const y = portrait ? { client: 0.2, titre: 0.33, visuel: 0.55, logo: 0.8 } : { client: 0.15, titre: 0.33, visuel: 0.6, logo: 0.86 };
  // Traînée de lumière qui accompagne l'arrivée du visuel, comme le souffle de l'ouverture.
  if (ms < 1000) {
    const k = ms / 1000, x = -W * 0.3 + k * W * 1.6;
    const g = ctx.createLinearGradient(x - u * 0.25, 0, x + u * 0.25, 0);
    g.addColorStop(0, "rgba(255, 255, 255, 0)");
    g.addColorStop(0.5, "rgba(255, 255, 255, .28)");
    g.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.save();
    ctx.setTransform(1, 0, -0.35, 1, H * 0.17, 0);
    ctx.fillStyle = g;
    ctx.fillRect(x - u * 0.25, 0, u * 0.5, H);
    ctx.restore();
  }
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 1. Le client : son logo dans une pastille blanche, sinon son nom.
  const a1 = rebond(depuis(150, 320));
  ctx.save();
  ctx.translate(W / 2, H * y.client);
  ctx.scale(a1, a1);
  const hp = u * 0.11;
  if (logo && logo.complete && logo.naturalWidth) {
    const hl = hp * 0.7, ll = Math.min(W * 0.5, (logo.naturalWidth / logo.naturalHeight) * hl);
    const lp = ll + hp * 0.5;
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath(); ctx.roundRect(-lp / 2, -hp / 2, lp, hp, hp * 0.24); ctx.fill();
    ctx.drawImage(logo, -ll / 2, -hl / 2, ll, ll / (logo.naturalWidth / logo.naturalHeight));
  } else {
    ctx.font = policeTitre(th, hp * 0.55);
    const nom = casse(th, carte.titre);
    const lp = ctx.measureText(nom).width + hp * 0.7;
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath(); ctx.roundRect(-lp / 2, -hp / 2, lp, hp, hp * 0.24); ctx.fill();
    ctx.fillStyle = th.texte;
    ctx.fillText(nom, 0, hp * 0.03);
  }
  ctx.restore();

  // 2. L'opération en grand (« La Fabrique de l'Innovation »), qui monte en place.
  const a2 = lisse(depuis(350, 380));
  ctx.globalAlpha = a2;
  ctx.fillStyle = encre;
  const corps = u * (portrait ? 0.11 : 0.12);
  ctx.font = policeTitre(th, corps);
  const titres = lignes(ctx, casse(th, carte.sousTitre ?? ""), W * (portrait ? 0.86 : 0.84), 2);
  const yt = H * y.titre - ((titres.length - 1) * corps * 1.02) / 2 + (1 - a2) * u * 0.04;
  titres.forEach((x, i) => ctx.fillText(x, W / 2, yt + i * corps * 1.02));
  ctx.globalAlpha = 1;

  // 3. Le visuel de l'ouverture revient : il glisse depuis la gauche et se pose, avec ses traits de vitesse.
  if (visuel && visuel.complete && visuel.naturalWidth) {
    const k = lisse(depuis(0, 900));
    const lv = Math.min(W * (portrait ? 0.78 : 0.4), u * 0.95);
    const hv = lv * (visuel.naturalHeight / visuel.naturalWidth);
    const cx = W / 2 - (1 - k) * (W / 2 + lv);
    ctx.save();
    ctx.globalAlpha = 0.35 * (1 - k) + 0.05;
    ctx.strokeStyle = encre;
    ctx.lineWidth = Math.max(2, u * 0.005);
    ctx.lineCap = "round";
    for (const [dy, l] of [[-0.12, 0.5], [0.05, 0.75], [0.2, 0.4]]) {
      const yy = H * y.visuel + hv * dy, x1 = cx - lv * 0.55;
      ctx.beginPath(); ctx.moveTo(x1 - lv * l * (0.4 + (1 - k)), yy); ctx.lineTo(x1, yy); ctx.stroke();
    }
    ctx.restore();
    ctx.drawImage(visuel, cx - lv / 2, H * y.visuel - hv / 2, lv, hv);
  }

  // 4. Notre logo « parlobox by whyme » dans une pastille blanche : ses couleurs d'origine, lisibles sur tout fond.
  const a4 = rebond(depuis(1000, 380));
  const corpsLogo = u * (portrait ? 0.056 : 0.052);
  const ll = dessinerLogoParlobox(ctx, 0, 0, corpsLogo, "#303136", true);
  const hpl = corpsLogo * 2, lpl = ll + corpsLogo * 1.6;
  ctx.save();
  ctx.translate(W / 2, H * y.logo);
  ctx.scale(a4, a4);
  ctx.shadowColor = "rgba(0, 0, 0, .18)";
  ctx.shadowBlur = u * 0.03;
  ctx.shadowOffsetY = u * 0.006;
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath(); ctx.roundRect(-lpl / 2, -hpl / 2, lpl, hpl, hpl / 2); ctx.fill();
  ctx.shadowColor = "transparent";
  dessinerLogoParlobox(ctx, -ll / 2, 0, corpsLogo, "#303136");
  ctx.restore();
  ctx.restore();
}

/** Petite secousse de l'image sur chaque coup du son (150 ms, amortie). */
function secousse(/** @type {number} */ ms, /** @type {readonly number[]} */ eclats, /** @type {number} */ u) {
  for (const e of eclats) {
    const d = ms - e;
    if (d >= 0 && d < 150) { const a = u * 0.012 * Math.exp(-d / 50); return /** @type {[number, number]} */ ([a * Math.sin(d * 0.9), a * Math.cos(d * 1.3)]); }
  }
  return /** @type {[number, number]} */ ([0, 0]);
}

/** Éclair blanc qui retombe sur chaque coup du son. */
function eclairs(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {number} */ W, /** @type {number} */ H, /** @type {number} */ ms, /** @type {readonly number[]} */ eclats) {
  let a = 0;
  for (const e of eclats) if (ms >= e) a = Math.max(a, 0.55 * Math.exp(-(ms - e) / 90));
  if (a < 0.01) return;
  ctx.save();
  ctx.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/**
 * Pendant le souffle du son (avant le premier coup) : une traînée de lumière traverse l'écran et des lignes
 * « glitch » scintillent, de plus en plus serrées jusqu'à l'impact. Déterministe (même film à chaque rendu).
 */
function effetsSon(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {number} */ W, /** @type {number} */ H, /** @type {number} */ u, /** @type {number} */ ms, /** @type {import("./plan.js").TempsOuverture} */ rep) {
  const [a, b] = rep.souffle;
  if (ms < a || ms > b + 120) return;
  const k = Math.min(1, (ms - a) / (b - a));
  ctx.save();
  // La traînée : bande claire inclinée qui balaie de gauche à droite.
  const x = -W * 0.3 + k * W * 1.6;
  const g = ctx.createLinearGradient(x - u * 0.25, 0, x + u * 0.25, 0);
  g.addColorStop(0, "rgba(255, 255, 255, 0)");
  g.addColorStop(0.5, `rgba(255, 255, 255, ${(0.18 + 0.25 * k).toFixed(3)})`);
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = g;
  ctx.setTransform(1, 0, -0.35, 1, H * 0.17, 0);
  ctx.fillRect(x - u * 0.25, 0, u * 0.5, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Les lignes « glitch » : quelques bandes horizontales, renouvelées toutes les 60 ms.
  const pas = Math.floor(ms / 60);
  let x0 = (pas * 2654435761) >>> 0;
  const alea = () => { x0 = (x0 * 1664525 + 1013904223) >>> 0; return x0 / 4294967296; };
  const nb = 2 + Math.round(k * 6);
  for (let i = 0; i < nb; i++) {
    const y = alea() * H, h = u * (0.004 + alea() * 0.012), l = W * (0.15 + alea() * 0.5);
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.12 + 0.3 * alea() * k).toFixed(3)})`;
    ctx.fillRect(alea() * (W - l), y, l, h);
  }
  ctx.restore();
}

/**
 * Image d'une réponse, recadrée au format du film, avec le bandeau (prénom ou question) pendant les premières secondes.
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLVideoElement} video
 * @param {string | null} bandeau
 * @param {number} ecouleMs temps écoulé depuis le début de la réponse dans le film
 * @param {Theme} th
 * @param {HTMLImageElement | null} [logo] logo du client (filigrane)
 */
export function dessinerReponse(ctx, video, bandeau, ecouleMs, th, logo = null) {
  const { width: W, height: H } = ctx.canvas;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  // Recadrage « remplir » depuis l'image 4:3 de la cabine : en 9:16, une bande verticale ; en 16:9, on retire de la
  // hauteur, surtout en bas, pour garder le visage (placé dans le haut de l'image).
  let { sx, sy, sw, sh } = { sx: 0, sy: 0, sw: vw, sh: vh };
  if (W / H < vw / vh) ({ sx, sy, sw, sh } = recadrage(vw, vh));
  else if (W / H > vw / vh) { sh = Math.round((vw * H) / W); sy = Math.round((vh - sh) * 0.3); }
  // Image non inversée, comme l'enregistrement (seul l'aperçu de la cabine est en miroir).
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  dessinerFiligranes(ctx, th, logo);

  if (!bandeau) return;
  const t = ecouleMs / 1000;
  const visible = t < 0.35 ? rebond(t / 0.35) : t > 3.2 ? 1 - lisse(Math.min(1, (t - 3.2) / 0.4)) : 1;
  if (visible <= 0) return;
  const u = Math.min(W, H);
  ctx.save();
  ctx.font = policeTitre(th, u * 0.055);
  const texte = lignes(ctx, casse(th, bandeau), W * 0.7, 1)[0] ?? "";
  const lb = ctx.measureText(texte).width + u * 0.08;
  const hb = u * 0.1;
  const x = u * 0.06;
  const y = H - hb - u * (H > W ? 0.16 : 0.07);
  ctx.globalAlpha = Math.min(1, visible);
  ctx.translate(x, y + hb);
  ctx.scale(visible, visible);
  ctx.fillStyle = bulleMarque(ctx, th, 0, -hb, lb, hb, hb / 2);
  ctx.textBaseline = "middle";
  ctx.fillText(texte, u * 0.04, -hb / 2);
  ctx.restore();
}

// ------------------------------------------------------------------ rendu

const attendre = (/** @type {EventTarget} */ cible, /** @type {string} */ evenement) => new Promise((ok, ko) => {
  const fin = () => { cible.removeEventListener(evenement, fin); cible.removeEventListener("error", erreur); ok(undefined); };
  const erreur = () => { cible.removeEventListener(evenement, fin); cible.removeEventListener("error", erreur); ko(new Error("Vidéo illisible")); };
  cible.addEventListener(evenement, fin);
  cible.addEventListener("error", erreur);
});

/** Extrait d'un son fourni, en mono, au volume donné, avec une attaque et une fin en fondu (aucun clic). */
function sonFourni(/** @type {AudioContext} */ audio, /** @type {AudioBuffer} */ source, /** @type {number} */ debutMs, /** @type {number} */ finMs, /** @type {number} */ volume) {
  const fe = source.sampleRate;
  const a = Math.round((debutMs / 1000) * fe), b = Math.min(source.length, Math.round((finMs / 1000) * fe));
  const n = Math.max(1, b - a);
  const sortie = audio.createBuffer(1, n, fe);
  const d = sortie.getChannelData(0);
  const canaux = Array.from({ length: source.numberOfChannels }, (_, c) => source.getChannelData(c));
  const entree = debutMs > 0 ? Math.round(0.03 * fe) : 0, fin = Math.round(0.15 * fe);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const c of canaux) v += /** @type {number} */ (c[a + i]);
    const env = Math.min(1, entree ? i / entree : 1, (n - i) / fin);
    d[i] = (v / canaux.length) * volume * env;
  }
  return sortie;
}

/**
 * Fabrique le film d'un plan de montage.
 * @param {{
 *   plan: Plan,
 *   videos: Map<string, Blob>,
 *   logo?: HTMLImageElement | null,
 *   visuels?: Map<string, HTMLImageElement>,
 *   format?: string,
 *   apercu?: HTMLCanvasElement,
 *   surProgression?: (fraction: number) => void,
 *   signal?: AbortSignal,
 * }} o
 * @returns {Promise<{ blob: Blob, type: string, dureeMs: number }>}
 */
export async function fabriquer(o) {
  const { plan } = o;
  const th = plan.theme;
  const type = o.format ?? formatsDisponibles()[0];
  if (!type) throw new Error("Ce navigateur ne sait pas enregistrer de vidéo. Utilisez Chrome à jour.");
  await Promise.all([
    document.fonts.load("600 48px Fredoka"), document.fonts.load("500 24px Gabarito"),
    th.policeTitres ? document.fonts.load(policeTitre(th, 48)) : null, th.policeTexte ? document.fonts.load(policeTexte(th, 24)) : null,
  ]).catch(() => {});
  const visuels = o.visuels ?? new Map();

  const canevas = o.apercu ?? document.createElement("canvas");
  canevas.width = plan.dimensions.largeur;
  canevas.height = plan.dimensions.hauteur;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canevas.getContext("2d", { alpha: false }));

  // Son : réponses + jingle mêlés dans une seule piste.
  const audio = new AudioContext();
  await audio.resume();
  const sortieSon = audio.createMediaStreamDestination();
  // Limiteur sur le mélange : jamais de saturation, même avec une voix très forte.
  const limiteur = audio.createDynamicsCompressor();
  limiteur.threshold.value = -6;
  limiteur.knee.value = 4;
  limiteur.ratio.value = 12;
  limiteur.attack.value = 0.003;
  limiteur.release.value = 0.2;
  const general = audio.createGain();
  general.gain.value = 0.9;
  limiteur.connect(general);
  general.connect(sortieSon);
  // Jingle de la campagne : « parlobox » (le même partout) ou « turbo » (3 s à l'ouverture, version courte ensuite).
  const tampon = (/** @type {Float32Array} */ son) => {
    const b = audio.createBuffer(1, son.length, audio.sampleRate);
    b.copyToChannel(/** @type {Float32Array<ArrayBuffer>} */ (son), 0);
    return b;
  };
  const turbo = th.jingle === "turbo";
  let jingle = tampon(turbo ? composerJingleTurbo(audio.sampleRate, true) : composerJingle(audio.sampleRate));
  let jingleOuverture = turbo ? tampon(composerJingleTurbo(audio.sampleRate)) : jingle;
  // Son fourni (ex. « glitch ») : le fichier pour l'ouverture ; aux transitions, le jingle Parlobox, adouci
  // (13/10/2026 : l'extrait du son fourni était trop violent entre les réponses). S'il ne se charge pas, le jingle
  // Parlobox le remplace : le montage ne s'arrête pas pour un son.
  const fourni = th.jingle === "glitch" ? SONS.glitch : null;
  if (fourni) {
    try {
      const res = await fetch(fourni.fichier, { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const decode = await audio.decodeAudioData(await res.arrayBuffer());
      jingleOuverture = sonFourni(audio, decode, 0, fourni.dureeMs, 0.55);
      jingle = tampon(composerJingle(audio.sampleRate).map((v) => v * fourni.volumeTransition));
    } catch (e) { console.warn("Son d'ouverture indisponible", e); }
  }
  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "auto";
  const volumeReponse = audio.createGain();
  audio.createMediaElementSource(video).connect(volumeReponse);
  volumeReponse.connect(limiteur);

  const flux = canevas.captureStream(IMAGES_PAR_SECONDE);
  for (const piste of sortieSon.stream.getAudioTracks()) flux.addTrack(piste);
  const enregistreur = new MediaRecorder(flux, { mimeType: type, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
  /** @type {Blob[]} */ const morceaux = [];
  enregistreur.ondataavailable = (e) => { if (e.data.size) morceaux.push(e.data); };
  const arrete = new Promise((ok) => { enregistreur.onstop = ok; });

  const urls = new Map([...o.videos].map(([id, b]) => [id, URL.createObjectURL(b)]));
  let fait = 0; // millisecondes du plan déjà rendues
  const progression = (/** @type {number} */ ms) => o.surProgression?.(Math.min(1, (fait + ms) / plan.dureeMs));
  const verifier = () => { if (o.signal?.aborted) throw new DOMException("Montage annulé", "AbortError"); };
  const image = () => new Promise((ok) => requestAnimationFrame(ok));

  try {
    dessinerCarte(ctx, /** @type {any} */ (plan.sequences[0]), 0, th, o.logo ?? null, visuels);
    enregistreur.start(1000);
    for (const seq of plan.sequences) {
      verifier();
      if (seq.type === "carte") {
        if (enregistreur.state === "paused") enregistreur.resume();
        if (seq.jingle) {
          const s = audio.createBufferSource();
          s.buffer = seq.role === "intro" ? jingleOuverture : jingle;
          s.connect(limiteur);
          s.start();
        }
        const debut = performance.now();
        for (;;) {
          const ecoule = performance.now() - debut;
          dessinerCarte(ctx, seq, Math.min(1, ecoule / seq.dureeMs), th, o.logo ?? null, visuels);
          progression(ecoule);
          if (ecoule >= seq.dureeMs) break;
          await image();
          verifier();
        }
        fait += seq.dureeMs;
        continue;
      }

      // Une réponse : chaque passage de parole est joué, l'enregistrement est en pause pendant les recherches.
      const url = urls.get(seq.reponseId);
      if (!url) throw new Error("Vidéo manquante pour une réponse");
      enregistreur.pause();
      if (video.src !== url) { video.src = url; await attendre(video, "loadeddata"); }
      let dansReponse = 0;
      for (const [a, b] of seq.segments) {
        verifier();
        if (enregistreur.state === "recording") enregistreur.pause();
        video.currentTime = a / 1000;
        await attendre(video, "seeked");
        volumeReponse.gain.setValueAtTime(0, audio.currentTime);
        volumeReponse.gain.linearRampToValueAtTime(1, audio.currentTime + 0.04);
        await video.play();
        dessinerReponse(ctx, video, seq.bandeau, dansReponse, th, o.logo ?? null);
        enregistreur.resume();
        const depart = performance.now();
        const fin = b / 1000;
        for (;;) {
          const ecoule = performance.now() - depart;
          dessinerReponse(ctx, video, seq.bandeau, dansReponse + ecoule, th, o.logo ?? null);
          progression(dansReponse + ecoule);
          if (video.ended || video.currentTime >= fin - 0.02) break;
          // Sécurité : jamais plus longtemps que le passage prévu (+1 s).
          if (ecoule > b - a + 1000) break;
          await image();
          verifier();
        }
        volumeReponse.gain.linearRampToValueAtTime(0, audio.currentTime + 0.03);
        await new Promise((ok) => setTimeout(ok, 35));
        video.pause();
        dansReponse += b - a;
      }
      fait += seq.dureeMs;
    }
    // Laisser le dernier jingle et la dernière image s'enregistrer.
    await new Promise((ok) => setTimeout(ok, 250));
    enregistreur.stop();
    await arrete;
  } finally {
    if (enregistreur.state !== "inactive") { enregistreur.stop(); await arrete.catch(() => {}); }
    for (const u of urls.values()) URL.revokeObjectURL(u);
    flux.getTracks().forEach((p) => p.stop());
    video.removeAttribute("src");
    await audio.close().catch(() => {});
  }
  o.surProgression?.(1);
  return { blob: new Blob(morceaux, { type: type.split(";")[0] }), type: /** @type {string} */ (type.split(";")[0]), dureeMs: plan.dureeMs };
}
