// Questionnaires types de Why me : la banque de départ d'une campagne (accueil, ton, feuille de style, question d'essai,
// questions, familles de métiers, réglages). Ceux ci-dessous sont livrés avec Why me ; l'équipe RH en ajoute dans
// l'espace RH (table wm_modeles), souvent depuis une campagne réussie. Un questionnaire type ne porte ni événement ni
// organisateur : ils viennent de la campagne à laquelle on l'applique.

import type { D1Database } from "../types.ts";
import type { ConfigWhyme } from "./config.ts";

/** Configuration d'un questionnaire type : celle d'une campagne, sans événement ni organisateur. */
export type ConfigModele = Omit<ConfigWhyme, "evenement" | "organisateur">;

export interface ModeleWhyme {
  id: string;
  nom: string;
  description: string;
  config: ConfigModele;
  integre: boolean;
}

const REGLAGES = { ageAffiche: true, ageMinimum: 15, validationAutoSec: 5 } as const;
const q = (id: string, texte: string, carton: string, dureeSec = 10) => ({ id, texte, carton, dureeSec, lectureSec: 10 });

export const MODELES: readonly ModeleWhyme[] = [
  {
    id: "base",
    nom: "Why me de base (jeunes, tutoiement)",
    description: "Le questionnaire d'origine : quatre questions sur la personne, pas sur le CV. Familles de métiers de l'industrie.",
    integre: true,
    config: {
      accueil: {
        titre: "Plus qu'un CV. Quelqu'un.",
        message: "Bienvenue dans la JobBox ! Ta personnalité ne se résume pas à une liste de compétences : montre-la aux entreprises en moins de deux minutes.",
      },
      familles: [
        { id: "rechercher", nom: "Rechercher & Concevoir" }, { id: "preparer", nom: "Préparer & Organiser" },
        { id: "produire", nom: "Produire & Réaliser" }, { id: "installer", nom: "Installer & Maintenir" },
        { id: "developper", nom: "Développer & Programmer" }, { id: "commercialiser", nom: "Acheter & Commercialiser" },
        { id: "recycler", nom: "Réemployer & Recycler" }, { id: "gerer", nom: "Gérer & Administrer" },
      ],
      questionEssai: { texte: "Pour t'échauffer : dis bonjour et ton prénom", dureeSec: 6 },
      questions: [
        q("q-toi", "Ton prénom et ce que tu aimes (matières, loisirs, passions…)", "Toi, en deux mots"),
        q("q-autres", "Ce que tu préfères chez les autres (qualités, défauts…) ?", "Ce que tu aimes chez les autres"),
        q("q-decouverte", "Quelle est ta dernière découverte ? (appli, livre, sport, film…)", "Ta dernière découverte"),
        q("q-mot", "Un dernier mot : ton talent, ce qui doit donner envie de te rencontrer ?", "Pourquoi toi ?"),
      ],
      ...REGLAGES, tutoiement: true, style: "bulles",
    },
  },
  {
    id: "gout",
    nom: "Métiers du goût et de l'alimentation",
    description: "Pour les marques alimentaires, épices, restauration : la gourmandise comme porte d'entrée. Feuille de style Épices.",
    integre: true,
    config: {
      accueil: {
        titre: "Plus qu'un CV. Une saveur.",
        message: "Bienvenue dans la JobBox ! Ici, pas de piège ni de note : quelques questions pour que les entreprises découvrent qui tu es, en moins de deux minutes.",
      },
      familles: [
        { id: "production", nom: "Production & Cuisine" }, { id: "qualite", nom: "Qualité & Sécurité alimentaire" },
        { id: "achats", nom: "Achats & Approvisionnement" }, { id: "logistique", nom: "Logistique" },
        { id: "vente", nom: "Vente & Commerce" }, { id: "marketing", nom: "Marketing & Communication" },
      ],
      questionEssai: { texte: "Pour t'échauffer : dis bonjour et ton prénom", dureeSec: 6 },
      questions: [
        q("q-toi", "Ton prénom, et le plat qui te met de bonne humeur ?", "Toi, en deux mots"),
        q("q-epice", "Quelle épice te ressemble le plus, et pourquoi ?", "Ton épice"),
        q("q-fierte", "Une chose que tu as faite et dont tu es fier ou fière ?", "Ta fierté"),
        q("q-mot", "Un dernier mot : pourquoi on devrait te rencontrer ?", "Pourquoi toi ?"),
      ],
      ...REGLAGES, tutoiement: true, style: "epices",
    },
  },
  {
    id: "alternance",
    nom: "Alternance et stages",
    description: "Étudiants et lycéens qui cherchent une alternance ou un stage : leurs études, un projet, ce qu'ils veulent apprendre.",
    integre: true,
    config: {
      accueil: {
        titre: "Ton alternance commence ici.",
        message: "Bienvenue dans la JobBox ! En moins de deux minutes, montre aux entreprises qui tu es et ce que tu as envie d'apprendre.",
      },
      familles: [
        { id: "technique", nom: "Technique & Production" }, { id: "numerique", nom: "Numérique & Informatique" },
        { id: "commerce", nom: "Commerce & Vente" }, { id: "gestion", nom: "Gestion & Administration" },
        { id: "communication", nom: "Communication & Marketing" },
      ],
      questionEssai: { texte: "Pour t'échauffer : dis bonjour et ton prénom", dureeSec: 6 },
      questions: [
        q("q-toi", "Ton prénom, ce que tu étudies, et ce qui t'y a amené ?", "Toi et tes études"),
        q("q-projet", "Un projet, un job ou une activité dont tu es fier ou fière ?", "Ton projet"),
        q("q-apprendre", "Ce que tu as le plus envie d'apprendre en entreprise ?", "Ce que tu veux apprendre"),
        q("q-mot", "Un dernier mot : pourquoi te choisir ?", "Pourquoi toi ?"),
      ],
      ...REGLAGES, tutoiement: true, style: "bulles",
    },
  },
  {
    id: "experimentes",
    nom: "Profils expérimentés (vouvoiement)",
    description: "Salariés en reconversion ou en évolution, cadres : vouvoiement et questions sur le parcours et les envies.",
    integre: true,
    config: {
      accueil: {
        titre: "Plus qu'un CV. Quelqu'un.",
        message: "Bienvenue dans la JobBox ! Votre parcours ne se résume pas à une liste de postes : en moins de deux minutes, montrez aux entreprises qui vous êtes.",
      },
      familles: [
        { id: "technique", nom: "Technique & Ingénierie" }, { id: "exploitation", nom: "Production & Exploitation" },
        { id: "commercial", nom: "Commercial & Relation client" }, { id: "support", nom: "Fonctions support" },
        { id: "management", nom: "Management & Direction" },
      ],
      questionEssai: { texte: "Pour vous échauffer : dites bonjour et votre prénom", dureeSec: 6 },
      questions: [
        q("q-vous", "Présentez-vous en quelques mots : votre parcours, ce qui vous anime.", "Vous, en deux mots", 15),
        q("q-reussite", "Une réussite dont vous êtes particulièrement fier ou fière ?", "Votre réussite", 15),
        q("q-collegues", "Que diraient de vous vos collègues ?", "Vu par vos collègues"),
        q("q-envie", "Ce que vous cherchez dans votre prochain poste ?", "Votre prochain poste", 15),
        q("q-mot", "Un dernier mot : pourquoi vous ?", "Pourquoi vous ?"),
      ],
      ...REGLAGES, ageAffiche: false, ageMinimum: 18, tutoiement: false, style: "bulles",
    },
  },
];

interface LigneModele { id: string; nom: string; description: string; config: string }

/** Les questionnaires types : livrés d'abord, puis ceux de l'espace RH par nom. */
export async function tousLesModeles(db: D1Database): Promise<ModeleWhyme[]> {
  const r = await db.prepare("SELECT id, nom, description, config FROM wm_modeles ORDER BY nom").all<LigneModele>();
  return [...MODELES, ...r.results.map((l) => ({ id: l.id, nom: l.nom, description: l.description, config: JSON.parse(l.config), integre: false }))];
}

/** Retire ce qui appartient à la campagne (événement, organisateur) d'une configuration validée. */
export function versModele(c: ConfigWhyme): ConfigModele {
  const { evenement: _e, organisateur: _o, ...reste } = c;
  return reste;
}
