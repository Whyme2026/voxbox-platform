// Configuration d'une campagne Why me (JSON stocké dans wm_campagnes.config), et textes affichés au candidat.
// Une campagne = un événement : son questionnaire (3 à 5 questions, plus une question d'essai non enregistrée),
// ses familles de postes, ses réglages (âge affiché, âge minimum, durées). Les entreprises proposées sont dans
// wm_campagne_entreprises. Rien n'est propre à un événement dans le code.

import { invalide } from "../http.ts";
import { STYLE_DEFAUT, STYLES } from "./styles.ts";

export interface QuestionWhyme {
  id: string;
  /** Question affichée au candidat. */
  texte: string;
  /** Titre court du carton dans le montage (par défaut : la question). */
  carton?: string;
  /** Durée de réponse (s), 10 par défaut en V0. */
  dureeSec: number;
  /** Temps de lecture avant l'enregistrement (s). */
  lectureSec: number;
}

export interface FamillePostes { id: string; nom: string }

export interface ConfigWhyme {
  /** Nom de l'événement affiché au candidat (« Mondial de l'Auto »). */
  evenement: string;
  /** Organisateur (PFA, école, salon), affiché dans l'accueil et l'e-mail s'il est renseigné. */
  organisateur?: string;
  accueil: { titre: string; message: string };
  familles: FamillePostes[];
  questionEssai: { texte: string; dureeSec: number };
  questions: QuestionWhyme[];
  /** Âge du candidat incrusté dans le montage (décision du 11/10/2026 : oui par défaut, désactivable). */
  ageAffiche: boolean;
  /** En dessous, l'interview est refusée poliment (15 ans par défaut : consentement parental en dessous). */
  ageMinimum: number;
  /** Secondes de l'écran « On garde ? » avant de garder la prise sans geste du candidat. */
  validationAutoSec: number;
  /** Tutoiement (par défaut, comme l'expérience why me) ou vouvoiement du candidat : écrans, textes, e-mails. */
  tutoiement: boolean;
  /** Feuille de style (src/whyme/styles.ts) : téléphone, film monté, e-mails. */
  style: string;
}

export const DUREE_MIN = 5;
export const DUREE_MAX = 60;
export const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Durées de conservation (décisions du 11/10/2026). */
export const ACCES_RECRUTEURS_MOIS = 12;
export const LIEN_PUBLIC_MOIS = 24;

function chaine(v: unknown, nom: string, max: number, requis = true): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (requis) throw invalide(`${nom} : obligatoire`);
    return undefined;
  }
  if (typeof v !== "string") throw invalide(`${nom} : texte attendu`);
  const t = v.trim();
  if (requis && !t) throw invalide(`${nom} : obligatoire`);
  if (t.length > max) throw invalide(`${nom} : ${max} caractères au plus`);
  return t || undefined;
}

function entier(v: unknown, nom: string, min: number, max: number, defaut: number): number {
  if (v === undefined || v === null) return defaut;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw invalide(`${nom} : entier entre ${min} et ${max} attendu`);
  return v;
}

/** Valide et normalise une configuration. Lève une erreur 400 lisible au premier problème. */
export function validerConfig(brut: unknown): ConfigWhyme {
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) throw invalide("Configuration : objet JSON attendu");
  const c = brut as Record<string, any>;
  const accueil = c.accueil ?? {};
  const essai = c.questionEssai ?? {};

  const familles: FamillePostes[] = [];
  if (c.familles !== undefined) {
    if (!Array.isArray(c.familles) || c.familles.length > 16) throw invalide("Familles de postes : liste de 16 au plus");
    for (const [i, f] of c.familles.entries()) {
      const id = chaine(f?.id, `Famille ${i + 1}, identifiant`, 40)!;
      if (!ID.test(id)) throw invalide(`Famille ${i + 1} : identifiant en minuscules, chiffres et tirets`);
      if (familles.some((x) => x.id === id)) throw invalide(`Famille « ${id} » en double`);
      familles.push({ id, nom: chaine(f?.nom, `Famille ${i + 1}, nom`, 60)! });
    }
  }

  if (!Array.isArray(c.questions) || c.questions.length < 3 || c.questions.length > 5) throw invalide("Questions : 3 à 5 questions");
  const questions: QuestionWhyme[] = c.questions.map((q: any, i: number) => {
    const id = chaine(q?.id, `Question ${i + 1}, identifiant`, 40)!;
    if (!ID.test(id)) throw invalide(`Question ${i + 1} : identifiant en minuscules, chiffres et tirets`);
    return {
      id,
      texte: chaine(q?.texte, `Question ${i + 1}`, 200)!,
      carton: chaine(q?.carton, `Question ${i + 1}, carton`, 60, false),
      dureeSec: entier(q?.dureeSec, `Question ${i + 1}, durée`, DUREE_MIN, DUREE_MAX, 10),
      lectureSec: entier(q?.lectureSec, `Question ${i + 1}, lecture`, 3, 30, 10),
    };
  });
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) throw invalide(`Question « ${q.id} » en double`);
    ids.add(q.id);
  }

  return {
    evenement: chaine(c.evenement, "Événement", 80)!,
    organisateur: chaine(c.organisateur, "Organisateur", 80, false),
    accueil: {
      titre: chaine(accueil.titre, "Accueil, titre", 80, false) ?? "Plus qu'un CV. Quelqu'un.",
      message: chaine(accueil.message, "Accueil, message", 400, false)
        ?? "Ta personnalité ne se résume pas à une liste de compétences. Montre-la en moins de deux minutes.",
    },
    familles,
    questionEssai: {
      texte: chaine(essai.texte, "Question d'essai", 200, false) ?? "Pour t'échauffer : dis bonjour et ton prénom",
      dureeSec: entier(essai.dureeSec, "Question d'essai, durée", DUREE_MIN, 30, 10),
    },
    questions,
    ageAffiche: c.ageAffiche === undefined ? true : Boolean(c.ageAffiche),
    ageMinimum: entier(c.ageMinimum, "Âge minimum", 14, 30, 15),
    validationAutoSec: entier(c.validationAutoSec, "Validation automatique", 3, 15, 5),
    tutoiement: c.tutoiement === undefined ? true : Boolean(c.tutoiement),
    style: (() => {
      const id = c.style === undefined || c.style === null || c.style === "" ? STYLE_DEFAUT : c.style;
      if (typeof id !== "string" || !STYLES.some((x) => x.id === id)) throw invalide(`Feuille de style inconnue : ${String(id)}`);
      return id;
    })(),
  };
}

export interface Responsable { nom: string; contact: string }

/** Responsable du service rendu directement au candidat (page vidéo publique). */
export const WHYNOT: Responsable = { nom: "WhyNot (WhyMe)", contact: "hello@whyme.jobs" };

export interface TextesWhyme {
  candidature: string;
  public: string;
  informationAge: string | null;
}

/**
 * Textes de consentement (à la première personne : c'est le candidat qui accepte ; la note sur l'âge suit le
 * tutoiement ou le vouvoiement de la campagne). Générés à partir de la configuration
 * et des entreprises : la preuve du consentement renvoie à leur empreinte. À faire relire par un avocat ou un DPO.
 */
export function genererTextes(config: ConfigWhyme): TextesWhyme {
  return {
    candidature:
      "J'accepte que ma candidature (identité, e-mail, CV s'il y en a un, et ma vidéo montée) soit transmise aux " +
      `entreprises que j'ai choisies, qui pourront la consulter et la télécharger pendant ${ACCES_RECRUTEURS_MOIS} mois pour me recontacter. ` +
      "Chaque entreprise est responsable de ce qu'elle fait de ma candidature ; WhyNot (WhyMe) l'héberge pour elles, en Europe. " +
      "Les vidéos brutes de chaque réponse sont effacées dès que le montage est prêt. Personne ne note ni n'analyse automatiquement ma vidéo.",
    public:
      "Je veux aussi une page vidéo à moi, accessible à toute personne qui a le lien ou le QR code (pour mon CV, LinkedIn…). " +
      `Elle reste en ligne ${LIEN_PUBLIC_MOIS} mois, et je peux la supprimer à tout moment depuis l'e-mail que je recevrai. ` +
      `Responsable : ${WHYNOT.nom}, ${WHYNOT.contact}.`,
    informationAge: config.ageAffiche
      ? config.tutoiement === false
        ? "Votre prénom et votre âge apparaîtront sur la vidéo envoyée aux recruteurs."
        : "Ton prénom et ton âge apparaîtront sur la vidéo envoyée aux recruteurs."
      : null,
  };
}

export async function empreinteTextes(t: TextesWhyme): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([t.candidature, t.public, t.informationAge])));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Ajoute des mois à une date ISO (fin du mois si le jour n'existe pas). */
export function ajouterMois(iso: string, mois: number): string {
  const d = new Date(iso);
  const jour = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + mois);
  const dernier = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(jour, dernier));
  return d.toISOString();
}
