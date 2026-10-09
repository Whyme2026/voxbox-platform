// @ts-check
// Caméra, micro et enregistrement d'une réponse.
// Leçons Geely : enregistrer en WebM avec le son en Opus (le MP4 de Chrome sur tablette perdait le son
// sans erreur) et vérifier pendant l'enregistrement que le micro capte bien de la voix.

/** Formats essayés dans l'ordre. Le MP4 est volontairement exclu. */
const FORMATS = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

export function formatEnregistrement() {
  if (typeof MediaRecorder === "undefined") return null;
  return FORMATS.find((f) => MediaRecorder.isTypeSupported(f)) ?? null;
}

/**
 * Ouvre caméra et micro. Image complète (pas de recadrage) : les formats 16:9 et 9:16 seront produits côté serveur.
 * @param {"paysage" | "portrait"} orientation
 */
export async function ouvrirCamera(orientation) {
  const paysage = orientation === "paysage";
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: paysage ? 1280 : 720 },
      height: { ideal: paysage ? 720 : 1280 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
}

/**
 * Mesure du niveau sonore en continu (0 à 1), pour l'anneau, la détection de silence et le contrôle du son.
 * @param {MediaStream} flux
 */
export function creerVumetre(flux) {
  const AC = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
  const audio = new AC();
  const source = audio.createMediaStreamSource(flux);
  const analyseur = audio.createAnalyser();
  analyseur.fftSize = 1024;
  source.connect(analyseur);
  const donnees = new Float32Array(analyseur.fftSize);
  return {
    niveau() {
      analyseur.getFloatTimeDomainData(donnees);
      let somme = 0;
      for (const v of donnees) somme += v * v;
      const rms = Math.sqrt(somme / donnees.length);
      // Échelle perceptive grossière : ~0.01 (silence de salle) → 0, ~0.2 (voix forte) → 1.
      return Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-8) + 50) / 40));
    },
    reprendre: () => audio.resume(),
    fermer: () => { source.disconnect(); audio.close(); },
  };
}

const SEUIL_VOIX = 0.30;        // niveau au-dessus duquel on considère que la personne parle
const VOIX_MIN_MS = 600;        // durée de parole cumulée minimale pour valider la présence du son

/**
 * Enregistre une réponse.
 * Options : flux à enregistrer (vidéo éventuellement floutée + piste audio), vumètre, durée maximale,
 * arrêt après N secondes de silence (0 = jamais), rappel à chaque image (niveau sonore, secondes écoulées).
 * @param {{ flux: MediaStream, vumetre: ReturnType<typeof creerVumetre>, dureeMaxSec: number, silenceArretSec?: number, surNiveau?: (niveau: number, ecoule: number) => void }} options
 * @returns {{ arreter: () => void, resultat: Promise<{ blob: Blob, dureeMs: number, sonPresent: boolean, type: string }> }}
 */
export function enregistrer(options) {
  const type = formatEnregistrement();
  if (!type) throw new Error("Ce navigateur ne sait pas enregistrer en WebM");
  const rec = new MediaRecorder(options.flux, { mimeType: type, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96_000 });
  /** @type {Blob[]} */
  const morceaux = [];
  const debut = performance.now();
  let voixMs = 0;
  let aParle = false;
  let silenceDepuis = performance.now();
  let precedent = debut;
  let fini = false;
  /** @type {number} */
  let minuteur = 0;

  const arreter = () => {
    if (fini) return;
    fini = true;
    cancelAnimationFrame(minuteur);
    if (rec.state !== "inactive") rec.stop();
  };

  const surveiller = () => {
    if (fini) return;
    const t = performance.now();
    const n = options.vumetre.niveau();
    if (n > SEUIL_VOIX) {
      voixMs += t - precedent;
      silenceDepuis = t;
      if (voixMs > 300) aParle = true;
    }
    precedent = t;
    const ecoule = (t - debut) / 1000;
    options.surNiveau?.(n, ecoule);
    const silence = options.silenceArretSec ?? 0;
    if (ecoule >= options.dureeMaxSec) return arreter();
    // Arrêt sur silence seulement après que la personne a commencé à parler.
    if (silence > 0 && aParle && (t - silenceDepuis) / 1000 >= silence) return arreter();
    minuteur = requestAnimationFrame(surveiller);
  };

  const resultat = new Promise((resolve, reject) => {
    rec.ondataavailable = (e) => { if (e.data.size) morceaux.push(e.data); };
    rec.onerror = (e) => reject(/** @type {any} */ (e).error ?? new Error("Erreur d'enregistrement"));
    rec.onstop = () => {
      const blob = new Blob(morceaux, { type });
      resolve({ blob, dureeMs: Math.round(performance.now() - debut), sonPresent: voixMs >= VOIX_MIN_MS, type });
    };
  });

  rec.start(1000); // morceaux d'une seconde : rien de perdu si l'onglet est interrompu
  minuteur = requestAnimationFrame(surveiller);
  return { arreter, resultat };
}
