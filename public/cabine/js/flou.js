// @ts-check
// Flou doux des visages, directement dans l'image enregistrée.
//
// Rendu : la zone du visage est d'abord fortement réduite (quelques dizaines de pixels), ce qui détruit
// l'information et rend le floutage irréversible, puis agrandie avec un flou gaussien : on obtient un voile
// lisse, sans effet « mosaïque ». Le contour est une ellipse aux bords fondus.
//
// Détection : détecteur de visages intégré au navigateur (FaceDetector) quand il existe, aucun module chargé
// depuis internet. Sans détecteur, ou si aucun visage n'est vu, toute l'image est floutée par sécurité.
// Le floutage définitif côté serveur viendra en complément (semaine 3).

/** @typedef {"doux" | "fort"} NiveauFlou */

/** Réglages par niveau : largeur de réduction (px) et rayon du flou (en part de la largeur du visage). */
export const NIVEAUX = /** @type {const} */ ({
  doux: { reduction: 28, rayon: 0.06 },
  fort: { reduction: 14, rayon: 0.11 },
});

const MARGE_LARGEUR = 1.35;   // la zone floutée déborde du visage détecté
const MARGE_HAUTEUR = 1.6;    // davantage en hauteur : cheveux, menton
const MEMOIRE_MS = 700;       // on garde la dernière position si le détecteur perd le visage un instant
const DETECTION_MS = 120;

/** Le navigateur sait-il détecter les visages sans module externe ? */
export function detectionDisponible() {
  return typeof (/** @type {any} */ (globalThis)).FaceDetector === "function";
}

/**
 * Dessine sur `ctx` une zone floutée elliptique.
 * @param {CanvasRenderingContext2D} ctx contexte de destination (contient déjà l'image)
 * @param {CanvasImageSource} source image d'origine
 * @param {{x:number,y:number,w:number,h:number}} zone
 * @param {NiveauFlou} niveau
 * @param {{ petit: HTMLCanvasElement | OffscreenCanvas, calque: HTMLCanvasElement | OffscreenCanvas }} tampons
 */
export function flouterZone(ctx, source, zone, niveau, tampons) {
  const reglage = NIVEAUX[niveau];
  const { x, y, w, h } = zone;
  if (w < 4 || h < 4) return;

  // 1. Réduction forte : l'information du visage est détruite ici.
  const pw = reglage.reduction;
  const ph = Math.max(2, Math.round(pw * (h / w)));
  const petit = tampons.petit;
  petit.width = pw; petit.height = ph;
  const pctx = /** @type {CanvasRenderingContext2D} */ (petit.getContext("2d"));
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = "high";
  pctx.drawImage(source, x, y, w, h, 0, 0, pw, ph);

  // 2. Agrandissement lissé + flou gaussien sur un calque, puis masque elliptique aux bords fondus.
  const calque = tampons.calque;
  calque.width = Math.ceil(w); calque.height = Math.ceil(h);
  const cctx = /** @type {CanvasRenderingContext2D} */ (calque.getContext("2d"));
  cctx.clearRect(0, 0, w, h);
  const rayon = Math.max(4, Math.round(w * reglage.rayon));
  cctx.filter = `blur(${rayon}px)`;
  cctx.imageSmoothingEnabled = true;
  cctx.imageSmoothingQuality = "high";
  // On déborde du cadre pour que le flou ne s'éclaircisse pas sur les bords.
  cctx.drawImage(petit, -rayon, -rayon, w + 2 * rayon, h + 2 * rayon);
  cctx.filter = "none";

  cctx.globalCompositeOperation = "destination-in";
  const grad = cctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(0.72, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  cctx.save();
  cctx.translate(w / 2, h / 2);
  cctx.scale(1, h / w);
  cctx.translate(-w / 2, -h / 2);
  cctx.fillStyle = grad;
  cctx.fillRect(0, 0, w, w);
  cctx.restore();
  cctx.globalCompositeOperation = "source-over";

  ctx.drawImage(calque, x, y);
}

/** Flou de toute l'image (aucun visage détecté, ou pas de détecteur). */
export function flouterTout(/** @type {CanvasRenderingContext2D} */ ctx, /** @type {CanvasImageSource} */ source, /** @type {number} */ l, /** @type {number} */ h, /** @type {HTMLCanvasElement | OffscreenCanvas} */ petit) {
  petit.width = 48; petit.height = Math.max(2, Math.round(48 * h / l));
  const pctx = /** @type {CanvasRenderingContext2D} */ (petit.getContext("2d"));
  pctx.imageSmoothingQuality = "high";
  pctx.drawImage(source, 0, 0, petit.width, petit.height);
  ctx.save();
  ctx.filter = `blur(${Math.round(l / 40)}px)`;
  ctx.drawImage(petit, -l * 0.05, -h * 0.05, l * 1.1, h * 1.1);
  ctx.restore();
}

/**
 * Flux vidéo flouté prêt à enregistrer : une vidéo source, un canevas, la détection en continu.
 * @param {HTMLVideoElement} video vidéo de la caméra (déjà en lecture)
 * @param {{ niveau?: NiveauFlou, ips?: number }} [options]
 */
export function creerFlou(video, options = {}) {
  const niveau = options.niveau ?? "fort";
  const canevas = document.createElement("canvas");
  const ctx = /** @type {CanvasRenderingContext2D} */ (canevas.getContext("2d", { alpha: false }));
  const tampons = { petit: document.createElement("canvas"), calque: document.createElement("canvas") };
  /** @type {{x:number,y:number,w:number,h:number}[]} */
  let zones = [];
  let vuLe = 0;
  let actif = true;
  let detectionEnCours = false;
  let derniereDetection = 0;
  // API du navigateur absente des types standard.
  const detecteur = detectionDisponible() ? new (/** @type {any} */ (globalThis)).FaceDetector({ fastMode: true, maxDetectedFaces: 4 }) : null;

  const boucle = () => {
    if (!actif) return;
    const l = video.videoWidth, h = video.videoHeight;
    if (l && h) {
      if (canevas.width !== l) { canevas.width = l; canevas.height = h; }
      ctx.drawImage(video, 0, 0, l, h);
      const maintenant = performance.now();
      if (detecteur && !detectionEnCours && maintenant - derniereDetection > DETECTION_MS) {
        detectionEnCours = true;
        derniereDetection = maintenant;
        detecteur.detect(video)
          .then((/** @type {{boundingBox: DOMRectReadOnly}[]} */ visages) => {
            if (visages.length) {
              zones = visages.map(({ boundingBox: b }) => {
                const w = b.width * MARGE_LARGEUR, hh = b.height * MARGE_HAUTEUR;
                return { x: b.x + b.width / 2 - w / 2, y: b.y + b.height * 0.42 - hh / 2, w, h: hh };
              });
              vuLe = performance.now();
            }
          })
          .catch(() => {})
          .finally(() => { detectionEnCours = false; });
      }
      if (zones.length && maintenant - vuLe < MEMOIRE_MS) {
        for (const z of zones) flouterZone(ctx, video, z, niveau, tampons);
      } else {
        flouterTout(ctx, video, l, h, tampons.petit);
      }
    }
    requestAnimationFrame(boucle);
  };
  requestAnimationFrame(boucle);

  return {
    canevas,
    /** Flux vidéo flouté (sans son : ajouter la piste audio de la caméra). */
    flux: () => canevas.captureStream(options.ips ?? 30),
    detection: detecteur ? "navigateur" : "aucune (image entière floutée)",
    arreter: () => { actif = false; },
  };
}
