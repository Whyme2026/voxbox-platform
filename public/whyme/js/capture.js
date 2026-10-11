// @ts-check
// Caméra, micro et enregistrement sur le téléphone du candidat (Why me).
// Des centaines de téléphones différents : on choisit le format que le navigateur sait vraiment enregistrer.
// WebM (VP9/VP8 + Opus) d'abord, comme sur la cabine Parlopop (leçon Geely : le MP4 de Chrome perdait le son sans
// erreur) ; MP4 (H.264 + AAC) seulement si le WebM n'existe pas (Safari sur iPhone). Le serveur normalise tout au
// montage, et chaque prise est contrôlée : présence de voix pendant l'enregistrement, image non noire.

import { creerVumetre } from "../../cabine/js/enregistreur.js";

export { creerVumetre };

const FORMATS = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4",
];

/** Format d'enregistrement retenu, ou null si le navigateur ne sait pas enregistrer. */
export function formatEnregistrement() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  return FORMATS.find((f) => MediaRecorder.isTypeSupported(f)) ?? null;
}

/** Navigateur intégré d'une application (Instagram, Facebook, LinkedIn, TikTok…) : caméra souvent bloquée. */
export function navigateurIntegre() {
  return /Instagram|FBAN|FBAV|FB_IAB|LinkedInApp|Snapchat|TikTok|musical_ly|Line\/|MicroMessenger|GSA\//i.test(navigator.userAgent);
}

/**
 * Ce qui empêcherait l'interview sur ce téléphone, avec la solution à proposer ; null si tout va bien.
 * @returns {string | null}
 */
export function diagnostic() {
  if (!window.isSecureContext) return "Cette page doit être ouverte en https.";
  if (navigateurIntegre()) return "Ouvre ce lien dans Safari ou Chrome : le navigateur de cette application ne donne pas accès à la caméra. (Menu ⋯ en haut à droite, puis « Ouvrir dans le navigateur ».)";
  if (!navigator.mediaDevices?.getUserMedia) return "Ce navigateur ne donne pas accès à la caméra. Ouvre ce lien dans Safari ou Chrome, à jour.";
  if (!formatEnregistrement()) return "Ce navigateur ne sait pas enregistrer de vidéo. Ouvre ce lien dans Safari ou Chrome, à jour.";
  return null;
}

/** Caméra frontale en portrait (3:4, l'image entière du capteur ; le montage en tire le 9:16) et micro. */
export async function ouvrirCamera() {
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 960 },
      height: { ideal: 1280 },
      aspectRatio: { ideal: 3 / 4 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
}

/**
 * Luminosité moyenne de l'image (0 à 255) et contraste haut/bas, sur une vignette : sert au contrôle de lumière
 * (image sombre, contre-jour) et à vérifier qu'une prise n'est pas noire.
 * @param {HTMLVideoElement} video
 */
export function mesurerImage(video) {
  const c = document.createElement("canvas");
  c.width = 36; c.height = 48;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g || !video.videoWidth) return { moyenne: 0, centre: 0, bords: 0 };
  g.drawImage(video, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let total = 0, centre = 0, nc = 0, bords = 0, nb = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      total += l;
      const auCentre = x > c.width * 0.3 && x < c.width * 0.7 && y > c.height * 0.2 && y < c.height * 0.6;
      if (auCentre) { centre += l; nc++; } else { bords += l; nb++; }
    }
  }
  return { moyenne: total / (c.width * c.height), centre: centre / nc, bords: bords / nb };
}

let detecteur = /** @type {any} */ (undefined);

/**
 * Visage détecté par le navigateur quand il sait le faire (FaceDetector) : position et taille relatives.
 * Renvoie undefined si le navigateur n'a pas de détecteur (le contrôle est alors ignoré, pas bloquant).
 * @param {HTMLVideoElement} video
 * @returns {Promise<{ x: number, y: number, largeur: number } | null | undefined>}
 */
export async function detecterVisage(video) {
  const FD = /** @type {any} */ (window).FaceDetector;
  if (!FD) return undefined;
  try {
    detecteur ??= new FD({ fastMode: true, maxDetectedFaces: 1 });
    const visages = await detecteur.detectFaces(video);
    const v = visages[0]?.boundingBox;
    if (!v) return null;
    return { x: (v.x + v.width / 2) / video.videoWidth, y: (v.y + v.height / 2) / video.videoHeight, largeur: v.width / video.videoWidth };
  } catch {
    return undefined;
  }
}

// Un peu plus tolérant que la cabine : micro de téléphone posé à un bras, salle bruyante filtrée par le navigateur.
const SEUIL_VOIX = 0.25;
const VOIX_MIN_MS = 450;

/**
 * Enregistre une réponse d'une durée fixe (le candidat peut arrêter plus tôt).
 * @param {{ flux: MediaStream, vumetre: ReturnType<typeof creerVumetre>, dureeSec: number, surTemps?: (ecoule: number, niveau: number) => void }} o
 * @returns {{ arreter: () => void, resultat: Promise<{ blob: Blob, type: string, dureeMs: number, sonPresent: boolean }> }}
 */
export function enregistrer(o) {
  const mime = formatEnregistrement();
  if (!mime) throw new Error("Enregistrement vidéo impossible sur ce navigateur");
  const rec = new MediaRecorder(o.flux, { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96_000 });
  /** @type {Blob[]} */
  const morceaux = [];
  const debut = performance.now();
  let precedent = debut;
  let voixMs = 0;
  let fini = false;
  let minuteur = 0;
  const arreter = () => {
    if (fini) return;
    fini = true;
    cancelAnimationFrame(minuteur);
    if (rec.state !== "inactive") rec.stop();
  };
  const suivre = () => {
    if (fini) return;
    const t = performance.now();
    const n = o.vumetre.niveau();
    if (n > SEUIL_VOIX) voixMs += t - precedent;
    precedent = t;
    const ecoule = (t - debut) / 1000;
    o.surTemps?.(ecoule, n);
    if (ecoule >= o.dureeSec) return arreter();
    minuteur = requestAnimationFrame(suivre);
  };
  const resultat = new Promise((resolve, reject) => {
    rec.ondataavailable = (e) => { if (e.data.size) morceaux.push(e.data); };
    rec.onerror = (e) => reject(/** @type {any} */ (e).error ?? new Error("Erreur d'enregistrement"));
    rec.onstop = () => {
      const type = (rec.mimeType || mime).split(";")[0];
      resolve({ blob: new Blob(morceaux, { type }), type, dureeMs: Math.round(performance.now() - debut), sonPresent: voixMs >= VOIX_MIN_MS });
    };
  });
  rec.start(1000);
  minuteur = requestAnimationFrame(suivre);
  return { arreter, resultat };
}
