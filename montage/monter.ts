// Montage d'une interview Why me avec ffmpeg, en 9:16 (720 × 1280, H.264 + AAC, MP4 « faststart »).
// Ordre : ouverture (why me + prénom) → pour chaque question : carton fuchsia (« Question n/N » + titre court),
// puis la réponse (blancs du début et de la fin coupés, logo why me, prénom et âge en bas) → fermeture.
// Aucune dépendance Node ; ffmpeg et ffprobe doivent être installés (image Docker du service).

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const executer = promisify(execFile);

export interface PlanMontage {
  id: string;
  prenom: string;
  age: number | null;
  evenement: string;
  questions: { id: string; numero: number; carton: string; type: string; dureeMs: number | null; sonPresent: boolean }[];
  format: { largeur: number; hauteur: number };
}

const POLICES = process.env.MONTAGE_POLICES ?? join(import.meta.dirname, "polices");
const GRAS = join(POLICES, "SourceSans3-Bold.ttf");
const DEMI = join(POLICES, "SourceSans3-Semibold.ttf");
const NORMAL = join(POLICES, "SourceSans3-Regular.ttf");
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

/** Un texte par ligne, centré horizontalement, autour de `centreY`. */
async function lignesCentrees(dossier: string, nom: string, lignes: string[], o: { police: string; taille: number; couleur: string; centreY: number; interligne: number }): Promise<string[]> {
  const filtres: string[] = [];
  const hauteurBloc = lignes.length * o.interligne;
  for (const [i, l] of lignes.entries()) {
    const f = join(dossier, `${nom}-${i}.txt`);
    await writeFile(f, l);
    const y = Math.round(o.centreY - hauteurBloc / 2 + i * o.interligne);
    filtres.push(`drawtext=fontfile='${chemin(o.police)}':textfile='${chemin(f)}':fontsize=${o.taille}:fontcolor=${o.couleur}:x=(w-text_w)/2:y=${y}`);
  }
  return filtres;
}

async function carton(dossier: string, nom: string, plan: PlanMontage, o: { fond: string; duree: number; filtres: string[] }): Promise<string> {
  const sortie = join(dossier, `${nom}.mp4`);
  const { largeur: L, hauteur: H } = plan.format;
  const fondu = `fade=t=in:st=0:d=0.25,fade=t=out:st=${(o.duree - 0.25).toFixed(2)}:d=0.25`;
  await executer("ffmpeg", ["-hide_banner", "-y",
    "-f", "lavfi", "-i", `color=c=${o.fond}:s=${L}x${H}:r=${FPS}:d=${o.duree}`,
    "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`,
    "-vf", [...o.filtres, fondu].join(","), "-t", String(o.duree), "-shortest", ...SORTIE, sortie]);
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
    const { hauteur: H } = plan.format;
    const morceaux: string[] = [];
    const total = plan.questions.length;

    morceaux.push(await carton(dossier, "ouverture", plan, {
      fond: "white", duree: 2.2,
      filtres: [
        ...(await lignesCentrees(dossier, "o-logo", ["why me"], { police: GRAS, taille: 120, couleur: FUCHSIA, centreY: H * 0.40, interligne: 130 })),
        ...(await lignesCentrees(dossier, "o-prenom", couperLignes(plan.prenom, 18), { police: GRAS, taille: 72, couleur: ENCRE, centreY: H * 0.55, interligne: 84 })),
        ...(await lignesCentrees(dossier, "o-devise", ["Plus qu'un CV. Quelqu'un."], { police: NORMAL, taille: 40, couleur: "0x5E5E5E", centreY: H * 0.64, interligne: 48 })),
      ],
    }));

    let dureeTotale = 2.2;
    for (const [i, q] of plan.questions.entries()) {
      morceaux.push(await carton(dossier, `carton-${i}`, plan, {
        fond: FUCHSIA, duree: 2.4,
        filtres: [
          ...(await lignesCentrees(dossier, `c${i}-num`, [`Question ${q.numero}/${total}`], { police: DEMI, taille: 40, couleur: "white@0.85", centreY: H * 0.36, interligne: 50 })),
          ...(await lignesCentrees(dossier, `c${i}-titre`, couperLignes(q.carton, 18), { police: GRAS, taille: 76, couleur: "white", centreY: H * 0.5, interligne: 88 })),
        ],
      }));
      const r = await reponse(dossier, i, sources[i]!, plan);
      morceaux.push(r.fichier);
      dureeTotale += 2.4 + r.duree;
    }

    morceaux.push(await carton(dossier, "fermeture", plan, {
      fond: FUCHSIA, duree: 1.8,
      filtres: await lignesCentrees(dossier, "f-logo", ["why me"], { police: GRAS, taille: 120, couleur: "white", centreY: H * 0.48, interligne: 130 }),
    }));
    dureeTotale += 1.8;

    const liste = join(dossier, "liste.txt");
    await writeFile(liste, morceaux.map((m) => `file '${m.replace(/'/g, "'\\''")}'`).join("\n"));
    const film = join(dossier, "montage.mp4");
    await executer("ffmpeg", ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", liste, "-c", "copy", "-movflags", "+faststart", film]);

    // Miniature : une image de la première réponse (après l'ouverture et le premier carton).
    const miniature = join(dossier, "miniature.jpg");
    await executer("ffmpeg", ["-hide_banner", "-y", "-ss", "5.6", "-i", film, "-frames:v", "1", "-vf", "scale=360:640", "-q:v", "5", miniature]);

    const verif = await ffprobe(film);
    if (!verif.audio) throw new Error("Montage sans piste son");
    return { mp4: await readFile(film), miniature: await readFile(miniature), dureeMs: Math.round((verif.duree || dureeTotale) * 1000) };
  } finally {
    await rm(dossier, { recursive: true, force: true });
  }
}
