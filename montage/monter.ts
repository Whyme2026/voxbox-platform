// Montage d'une interview Why me avec ffmpeg, en 9:16 (720 × 1280, H.264 + AAC, MP4 « faststart »).
// Pour chaque question : un plan de 3 secondes qui la rappelle, comme un message reçu (bulle de conversation, avec
// une courte signature sonore de notification), puis la réponse (blancs du début et de la fin coupés, logo why me,
// prénom et âge en bas). Ni ouverture ni fermeture : le film commence et finit sur le candidat.
// Aucune dépendance Node ; ffmpeg et ffprobe doivent être installés (image Docker du service).

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const executer = promisify(execFile);

export interface PlanMontage {
  id: string;
  prenom: string;
  age: number | null;
  evenement: string;
  questions: { id: string; numero: number; carton: string; texte?: string; type: string; dureeMs: number | null; sonPresent: boolean }[];
  format: { largeur: number; hauteur: number };
}

const POLICES = process.env.MONTAGE_POLICES ?? join(import.meta.dirname, "polices");
const GRAS = join(POLICES, "SourceSans3-Bold.ttf");
const DEMI = join(POLICES, "SourceSans3-Semibold.ttf");
const FUCHSIA = "0xC6017C";
const ENCRE = "0x333333";
const FPS = 30;

/** Découpe un texte en lignes d'au plus `max` caractères, sans couper les mots. */
export function couperLignes(texte: string, max: number): string[] {
  const lignes: string[] = [];
  let ligne = "";
  // Typographie française : « ? », « ! », « : », « ; » et « » » restent collés au mot qui précède (espace insécable).
  const prepare = texte.trim().replace(/\s+/g, " ").replace(/ ([?!:;»])/g, "\u00A0$1").replace(/« /g, "«\u00A0");
  for (const mot of prepare.split(" ")) {
    if (!ligne) ligne = mot;
    else if ((ligne + " " + mot).length <= max) ligne += " " + mot;
    else { lignes.push(ligne); ligne = mot; }
  }
  if (ligne) lignes.push(ligne);
  return lignes;
}

/** Repère le début et la fin de la parole à partir de silencedetect (marges : 0,25 s avant, 0,4 s après). */
export function bornesParole(sortieSilence: string, duree: number): { debut: number; fin: number } {
  const debuts = [...sortieSilence.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const fins = [...sortieSilence.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  let debut = 0;
  let fin = duree;
  // Silence d'ouverture : commence à ~0 et se termine avant la parole.
  if (debuts.length && debuts[0]! <= 0.05 && fins.length) debut = Math.max(0, fins[0]! - 0.25);
  // Silence de clôture : le dernier silence qui ne se termine pas (ou se termine à la fin du fichier).
  const dernierDebut = debuts[debuts.length - 1];
  if (dernierDebut !== undefined && dernierDebut > debut && (fins.length < debuts.length || fins[fins.length - 1]! >= duree - 0.05)) {
    fin = Math.min(duree, dernierDebut + 0.4);
  }
  // Garde-fou : jamais moins de 1,5 s, ni un découpage absurde.
  if (fin - debut < 1.5) return { debut: 0, fin: duree };
  return { debut, fin };
}

async function ffprobe(fichier: string): Promise<{ duree: number; audio: boolean; video: boolean }> {
  const { stdout } = await executer("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", fichier]);
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string }[] };
  let duree = Number(info.format?.duration ?? 0);
  if (!Number.isFinite(duree) || duree <= 0) {
    // WebM enregistré par MediaRecorder : durée parfois absente de l'en-tête, on la mesure en décodant.
    const { stderr } = await executer("ffmpeg", ["-hide_banner", "-i", fichier, "-f", "null", "-"], { maxBuffer: 1 << 24 });
    const m = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
    duree = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  }
  return { duree, audio: Boolean(info.streams?.some((s) => s.codec_type === "audio")), video: Boolean(info.streams?.some((s) => s.codec_type === "video")) };
}

/** Échappement d'un chemin dans un graphe de filtres ffmpeg. */
const chemin = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

/** Paramètres d'encodage communs : tous les morceaux sont identiques, la concaténation se fait sans réencodage. */
const SORTIE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", String(FPS),
  "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-video_track_timescale", "15360", "-movflags", "+faststart"];

// ------------------------------------------------------------------ plan « question » (3 s)

export const DUREE_QUESTION = 3;
/** Instant où la bulle de la question arrive (après les points « en train d'écrire »), avec le son. */
const ARRIVEE = 0.75;
const FOND = [0xFA, 0xF7, 0xF9];
const ROSE = [0xC6, 0x01, 0x7C];
const GRIS_BULLE = [0xEC, 0xE6, 0xEA];

/** Texte de la bulle : la question telle qu'elle a été posée si elle se lit en 3 secondes, sinon son titre court. */
export function texteBulle(q: { carton: string; texte?: string }): string {
  const t = (q.texte ?? "").trim();
  return t && t.length <= 80 ? t : q.carton;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array): number { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 0xFF]! ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

/** PNG RGBA minimal (node:zlib), pour les formes que drawbox ne sait pas dessiner (coins arrondis, queue de bulle). */
export function png(largeur: number, hauteur: number, rgba: Uint8Array): Uint8Array {
  const brut = new Uint8Array((largeur * 4 + 1) * hauteur);
  for (let y = 0; y < hauteur; y++) brut.set(rgba.subarray(y * largeur * 4, (y + 1) * largeur * 4), y * (largeur * 4 + 1) + 1);
  const morceau = (type: string, donnees: Uint8Array) => {
    const m = new Uint8Array(12 + donnees.length);
    const v = new DataView(m.buffer);
    v.setUint32(0, donnees.length);
    m.set(new TextEncoder().encode(type), 4);
    m.set(donnees, 8);
    v.setUint32(8 + donnees.length, crc32(m.subarray(4, 8 + donnees.length)));
    return m;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, largeur); v.setUint32(4, hauteur); ihdr[8] = 8; ihdr[9] = 6;
  const parties = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), morceau("IHDR", ihdr), morceau("IDAT", new Uint8Array(deflateSync(brut))), morceau("IEND", new Uint8Array())];
  const tout = new Uint8Array(parties.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parties) { tout.set(p, o); o += p.length; }
  return tout;
}

/**
 * Bulle de conversation (rectangle aux coins arrondis + petite queue en bas à gauche), bords adoucis.
 * `points` : trois points « en train d'écrire » au centre au lieu d'un texte.
 */
export function bulle(largeur: number, hauteur: number, couleur: number[], o: { rayon: number; queue: number; points?: number[] }): Uint8Array {
  const H = hauteur + o.queue;
  const px = new Uint8Array(largeur * H * 4);
  const r = o.rayon;
  // Distance signée au rectangle arrondi (négative dedans).
  const dRect = (x: number, y: number) => {
    const qx = Math.abs(x - largeur / 2) - (largeur / 2 - r);
    const qy = Math.abs(y - hauteur / 2) - (hauteur / 2 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  // Queue : triangle sous le coin bas gauche, pointe vers le bas et la gauche.
  const dansQueue = (x: number, y: number) => {
    if (y < hauteur - r || y > H) return false;
    const t = (y - (hauteur - r)) / (H - (hauteur - r));
    const gauche = r * 0.6 - t * r * 0.6;
    const droite = r * 1.9 - t * r * 1.55;
    return x >= gauche && x <= droite;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < largeur; x++) {
      const d = dRect(x + 0.5, y + 0.5);
      let a = Math.min(1, Math.max(0, 0.5 - d));
      if (dansQueue(x + 0.5, y + 0.5)) a = 1;
      if (o.points) {
        for (const cx of o.points) {
          const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - hauteur / 2) - 9;
          if (dd < 0.5) {
            const k = Math.min(1, 0.5 - dd);
            const i = (y * largeur + x) * 4;
            px[i] = 0x8A * k + couleur[0]! * (1 - k); px[i + 1] = 0x7D * k + couleur[1]! * (1 - k); px[i + 2] = 0x86 * k + couleur[2]! * (1 - k); px[i + 3] = 255;
          }
        }
        const i = (y * largeur + x) * 4;
        if (px[i + 3]) continue;
      }
      const i = (y * largeur + x) * 4;
      px[i] = couleur[0]!; px[i + 1] = couleur[1]!; px[i + 2] = couleur[2]!; px[i + 3] = Math.round(a * 255);
    }
  }
  return png(largeur, H, px);
}

/**
 * Signature sonore : deux notes douces et montantes (la5 puis mi6, une quinte : l'intonation d'une question),
 * attaque nette, extinction rapide, discrète (environ -20 dBFS). Évoque un message qui arrive, sans sonnerie.
 */
export function expressionSon(debut: number): string {
  const note = (f: number, t0: number, decroissance: number, gain: number) =>
    `${gain}*between(t,${t0},${t0 + 0.6})*(sin(2*PI*${f}*(t-${t0}))+0.25*sin(4*PI*${f}*(t-${t0})))*exp(-${decroissance}*(t-${t0}))*min(1,(t-${t0})*200)`;
  return `${note(880, debut, 18, 0.11)}+${note(1318.5, debut + 0.11, 11, 0.1)}`;
}

async function planQuestion(dossier: string, i: number, total: number, q: { carton: string; texte?: string; numero: number }, plan: PlanMontage): Promise<string> {
  const { largeur: L, hauteur: H } = plan.format;
  const D = DUREE_QUESTION;
  const texte = texteBulle(q);
  let taille = 56;
  let lignes = couperLignes(texte, 19);
  if (lignes.length > 4) { taille = 46; lignes = couperLignes(texte, 24); }
  const interligne = Math.round(taille * 1.22);
  const marge = 44;
  const largeurBulle = L - 2 * 56;
  const hauteurBulle = lignes.length * interligne + 2 * marge - (interligne - taille);
  const queue = 26;
  const xBulle = 56;
  const yBulle = Math.round(H * 0.47 - hauteurBulle / 2);
  const fBulle = join(dossier, `bulle-${i}.png`);
  await writeFile(fBulle, bulle(largeurBulle, hauteurBulle, ROSE, { rayon: 44, queue }));
  const largeurPoints = 150;
  const hauteurPoints = 84;
  const fPoints = join(dossier, `points-${i}.png`);
  await writeFile(fPoints, bulle(largeurPoints, hauteurPoints, GRIS_BULLE, { rayon: 42, queue: 18, points: [45, 75, 105] }));

  // La bulle monte de 28 px en 0,25 s en apparaissant ; les points s'effacent à son arrivée.
  const glisse = `28*(1-min(max((t-${ARRIVEE})/0.25,0),1))`;
  const fondu = `min(max((t-${ARRIVEE})/0.18,0),1)`;
  const fNum = join(dossier, `num-${i}.txt`);
  await writeFile(fNum, `Question ${q.numero}/${total}`);
  const textes = await Promise.all(lignes.map(async (l, k) => {
    const f = join(dossier, `q${i}-${k}.txt`);
    await writeFile(f, l);
    const y = yBulle + marge + k * interligne;
    return `drawtext=fontfile='${chemin(GRAS)}':textfile='${chemin(f)}':fontsize=${taille}:fontcolor=white:x=${xBulle + marge}:y='${y}+${glisse}':alpha='${fondu}'`;
  }));
  const filtre = [
    `color=c=0x${FOND.map((c) => c.toString(16).padStart(2, "0")).join("")}:s=${L}x${H}:r=${FPS}:d=${D}[fond]`,
    `[1:v]format=rgba,fade=t=in:st=0.12:d=0.15:alpha=1,fade=t=out:st=${ARRIVEE - 0.12}:d=0.12:alpha=1[pts]`,
    `[2:v]format=rgba,fade=t=in:st=${ARRIVEE}:d=0.18:alpha=1[bul]`,
    `[fond][pts]overlay=x=${xBulle}:y=${yBulle}:enable='lt(t,${ARRIVEE})'[a]`,
    `[a][bul]overlay=x=${xBulle}:y='${yBulle}+${glisse}':eval=frame[b]`,
    `[b]drawtext=fontfile='${chemin(DEMI)}':textfile='${chemin(fNum)}':fontsize=34:fontcolor=0x8A7D86:x=${xBulle + 6}:y=${yBulle - 70}:alpha='min(t/0.2,1)',`
      + `drawtext=fontfile='${chemin(GRAS)}':text='why me':fontsize=38:fontcolor=0xC6017C:x=(w-text_w)/2:y=h-120,`
      + `${textes.join(",")},fade=t=out:st=${D - 0.18}:d=0.18,format=yuv420p[v]`,
  ].join(";");
  const sortie = join(dossier, `question-${i}.mp4`);
  await executer("ffmpeg", ["-hide_banner", "-y",
    "-f", "lavfi", "-t", String(D), "-i", `aevalsrc='${expressionSon(ARRIVEE)}|${expressionSon(ARRIVEE)}':s=48000:c=stereo`,
    "-loop", "1", "-t", String(D), "-i", fPoints,
    "-loop", "1", "-t", String(D), "-i", fBulle,
    "-filter_complex", filtre, "-map", "[v]", "-map", "0:a", "-t", String(D), ...SORTIE, sortie], { maxBuffer: 1 << 24 });
  return sortie;
}

async function reponse(dossier: string, i: number, source: string, plan: PlanMontage): Promise<{ fichier: string; duree: number }> {
  const { largeur: L, hauteur: H } = plan.format;
  const info = await ffprobe(source);
  if (!info.video) throw new Error(`Prise ${i + 1} : pas d'image`);
  let debut = 0;
  let fin = info.duree;
  if (info.audio) {
    const { stderr } = await executer("ffmpeg", ["-hide_banner", "-i", source, "-af", "silencedetect=noise=-38dB:d=0.5", "-vn", "-f", "null", "-"], { maxBuffer: 1 << 24 });
    ({ debut, fin } = bornesParole(stderr, info.duree));
  }
  const duree = Math.max(0.5, fin - debut);
  const nomAge = plan.age ? `${plan.prenom}, ${plan.age} ans` : plan.prenom;
  const fNom = join(dossier, `nom.txt`);
  await writeFile(fNom, nomAge);
  const fLogo = join(dossier, `logo.txt`);
  await writeFile(fLogo, "why me");
  const video = [
    // Image entière ramenée au 9:16 : on remplit puis on recadre au centre (visage centré au cadrage).
    `scale=${L}:${H}:force_original_aspect_ratio=increase`, `crop=${L}:${H}`, `fps=${FPS}`, "setsar=1",
    // Petit logo en haut à gauche, prénom (et âge) en bas, sur un bandeau blanc.
    `drawtext=fontfile='${chemin(GRAS)}':textfile='${chemin(fLogo)}':fontsize=40:fontcolor=white:x=36:y=40:box=1:boxcolor=${FUCHSIA}@0.92:boxborderw=14`,
    `drawtext=fontfile='${chemin(DEMI)}':textfile='${chemin(fNom)}':fontsize=44:fontcolor=${ENCRE}:x=36:y=h-150:box=1:boxcolor=white@0.94:boxborderw=18`,
    `fade=t=in:st=0:d=0.15`, `fade=t=out:st=${(duree - 0.2).toFixed(2)}:d=0.2`,
  ].join(",");
  const audio = info.audio
    ? ["-af", `aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.1,afade=t=out:st=${(duree - 0.2).toFixed(2)}:d=0.2`]
    : [];
  const sortie = join(dossier, `reponse-${i}.mp4`);
  await executer("ffmpeg", ["-hide_banner", "-y", "-ss", debut.toFixed(2), "-t", duree.toFixed(2), "-i", source,
    ...(info.audio ? [] : ["-f", "lavfi", "-t", duree.toFixed(2), "-i", "anullsrc=r=48000:cl=stereo"]),
    "-vf", video, ...audio, ...(info.audio ? [] : ["-map", "0:v", "-map", "1:a"]), ...SORTIE, sortie], { maxBuffer: 1 << 24 });
  if (!info.audio) console.warn(`Montage ${plan.id} : prise ${i + 1} sans piste son`);
  return { fichier: sortie, duree };
}

export interface ResultatMontage { mp4: Uint8Array; miniature: Uint8Array; dureeMs: number }

/**
 * Monte l'interview. `sources[i]` est le fichier de la prise de la question i (dans l'ordre du plan).
 * Tout se passe dans un dossier temporaire, effacé à la fin (rien ne reste sur le disque du service).
 */
export async function monter(plan: PlanMontage, sources: string[]): Promise<ResultatMontage> {
  const dossier = await mkdtemp(join(tmpdir(), "whyme-"));
  try {
    const morceaux: string[] = [];
    const total = plan.questions.length;
    let dureeTotale = 0;
    for (const [i, q] of plan.questions.entries()) {
      morceaux.push(await planQuestion(dossier, i, total, q, plan));
      const r = await reponse(dossier, i, sources[i]!, plan);
      morceaux.push(r.fichier);
      dureeTotale += DUREE_QUESTION + r.duree;
    }

    const liste = join(dossier, "liste.txt");
    await writeFile(liste, morceaux.map((m) => `file '${m.replace(/'/g, "'\\''")}'`).join("\n"));
    const film = join(dossier, "montage.mp4");
    await executer("ffmpeg", ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", liste, "-c", "copy", "-movflags", "+faststart", film]);

    // Miniature : une image de la première réponse, juste après le premier plan « question ».
    const miniature = join(dossier, "miniature.jpg");
    await executer("ffmpeg", ["-hide_banner", "-y", "-ss", String(DUREE_QUESTION + 0.8), "-i", film, "-frames:v", "1", "-vf", "scale=360:640", "-q:v", "5", miniature]);

    const verif = await ffprobe(film);
    if (!verif.audio) throw new Error("Montage sans piste son");
    return { mp4: await readFile(film), miniature: await readFile(miniature), dureeMs: Math.round((verif.duree || dureeTotale) * 1000) };
  } finally {
    await rm(dossier, { recursive: true, force: true });
  }
}
