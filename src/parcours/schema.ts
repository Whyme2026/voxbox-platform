// Description d'un parcours de cabine : une suite d'étapes typées, stockée en JSON et versionnée.
// Le même moteur sert la cabine, le lien à distance et le QR code.
// Rien ici n'est propre à un secteur : l'automobile n'est qu'un exemple de configuration.

export type TypeEtape = "accueil" | "identification" | "consentement" | "cadrage" | "question" | "choix" | "pause" | "fin";

interface EtapeBase {
  id: string;
  type: TypeEtape;
  /** Étape suivante. Par défaut : l'étape d'après dans la liste. */
  suite?: string;
  /** Fond de l'écran (couleur ou dégradé, couleur du texte), parmi ceux de l'habillage. */
  fond?: string;
  /**
   * Visuel affiché sur l'écran (ex. un produit), parmi ceux de l'habillage. « choix » : le visuel de la dernière
   * option choisie par le visiteur qui en a un (ex. le modèle qu'il vient de désigner).
   */
  visuel?: string;
}

export interface EtapeAccueil extends EtapeBase {
  type: "accueil";
  /** Petite ligne au-dessus du titre (ex. « VIP Experience »). */
  surtitre?: string;
  titre: string;
  texte?: string;
  bouton: string;
  /** Bulles de la cabine qui « parle » au visiteur sur l'écran d'accueil (3 au plus). */
  bulles?: string[];
}

// Dans tous les textes affichés, {prenom} est remplacé par le prénom du visiteur (ou retiré s'il est inconnu).

export interface EtapeIdentification extends EtapeBase {
  type: "identification";
  titre: string;
  /** Petite bulle sous la question (ex. « Juste le prénom, promis. »). */
  texte?: string;
  demanderNom?: boolean;
  demanderEmail?: boolean;
}
export interface EtapeConsentement extends EtapeBase {
  type: "consentement";
  titre: string;
  bouton: string;
  /** Bulle d'introduction (ex. « Merci {prenom} ! Avant de commencer, voici le deal. »). */
  texte?: string;
  /** Consignes affichées avant l'accord (« 5 questions, 30 secondes… »). L'écran sert alors de « mode d'emploi ». */
  consignes?: string[];
  /** Propose au visiteur de flouter son visage (case facultative). */
  proposerFloutage?: boolean;
  /**
   * Propose au visiteur une case facultative « diffusion publique » (réseaux sociaux, site, publicité).
   * Absent ou false : la campagne est en usage interne uniquement, aucune case n'est affichée
   * et le serveur refuse tout consentement de diffusion.
   */
  proposerDiffusion?: boolean;
}
export interface EtapeCadrage extends EtapeBase { type: "cadrage"; titre: string; proposerFloutage?: boolean }
export interface EtapeQuestion extends EtapeBase {
  type: "question";
  texte: string;
  aide?: string;
  dureeMaxSec: number;
  compteARebours?: number;
  /** Arrêt automatique après ce nombre de secondes de silence (0 = désactivé). */
  silenceArretSec?: number;
  /** Thème d'analyse, pour regrouper les réponses dans la restitution. */
  theme?: string;
  /** Nom court affiché au-dessus de la question (ex. « Le coup de cœur »). */
  titreCourt?: string;
  /** Pistes de réponse affichées en étiquettes (5 au plus). */
  pistes?: string[];
  /** Début de phrase pour lancer la réponse (ex. « Pour moi, c'était… »). */
  coupDePouce?: string;
}
export interface OptionChoix {
  id: string; libelle: string; image?: string; suite: string;
  /** Précision sous le libellé (ex. « SUV familial · super hybride »). */
  detail?: string;
  /** Fond de la carte de l'option et visuel affiché dessus, parmi ceux de l'habillage. */
  fond?: string;
  visuel?: string;
}
export interface EtapeChoix extends EtapeBase { type: "choix"; titre: string; options: OptionChoix[] }
export interface EtapePause extends EtapeBase { type: "pause"; titre: string; texte?: string; bouton: string }
export interface EtapeFin extends EtapeBase { type: "fin"; titre: string; texte?: string; sortie?: string; retourAccueilSec?: number }

export type Etape =
  | EtapeAccueil | EtapeIdentification | EtapeConsentement | EtapeCadrage
  | EtapeQuestion | EtapeChoix | EtapePause | EtapeFin;

/**
 * Ambiance graphique de la cabine.
 * - « conversation » (par défaut) : direction artistique neutre Parlopop, fonds clairs et bulles douces ;
 * - « pop » : version festive (bande dessinée, contours épais, trames, couleurs vives), pour les animations ludiques.
 * Les couleurs de la marque cliente restent prioritaires dans les deux cas.
 */
export type Ambiance = "conversation" | "pop";
export const AMBIANCES: readonly Ambiance[] = ["conversation", "pop"];

/**
 * Habillage d'une campagne : ce qui donne à la cabine et aux Parlomix l'allure de la marque, sans code propre
 * à une marque ni à un secteur. Tout est facultatif : sans habillage, direction artistique Parlopop
 * (et couleurs de la fiche client). S'ajoute à l'ambiance générale (« conversation » ou « pop »).
 */
export const POLICES = ["fredoka", "gabarito", "michroma", "inter"] as const;
export type Police = (typeof POLICES)[number];
/** Fond d'un écran : une couleur, ou un dégradé vertical de `couleur` à `couleurBas` ; `texte` = couleur du texte posé dessus. */
export interface Fond { id: string; nom?: string; couleur: string; couleurBas?: string; texte: string }
/** Visuel vectoriel (SVG autonome), affiché comme une image : aucun script ni ressource externe. */
export interface Visuel { id: string; nom: string; svg: string }
export interface Habillage {
  polices?: { titres?: Police; texte?: Police };
  /** Titres et questions en capitales. */
  titresMajuscules?: boolean;
  /**
   * marque : boutons secondaires, cases, repères ; bulle : fond des bulles de la marque (par défaut, marque) ;
   * visiteur : bulles du visiteur et actions ; fond et texte : écran sans fond particulier.
   * Remplacent les couleurs de la fiche client pour cette campagne.
   */
  couleurs?: { marque?: string; bulle?: string; visiteur?: string; fond?: string; texte?: string };
  fonds?: Fond[];
  visuels?: Visuel[];
}

export interface Parcours {
  version: 1;
  langue: string;
  /** Ambiance graphique (par défaut « conversation »). */
  ambiance?: Ambiance;
  /** Textes fixes de la cabine au tutoiement (par défaut : vouvoiement). Les textes légaux restent au vouvoiement. */
  tutoiement?: boolean;
  habillage?: Habillage;
  etapes: Etape[];
}

const TYPES: readonly TypeEtape[] = ["accueil", "identification", "consentement", "cadrage", "question", "choix", "pause", "fin"];
const ID_VALIDE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Renvoie la liste des problèmes du parcours ; liste vide = parcours valide. */
export function validerParcours(brut: unknown): string[] {
  const pb: string[] = [];
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return ["Le parcours doit être un objet JSON"];
  const p = brut as Partial<Parcours>;
  if (p.version !== 1) pb.push("version : 1 attendu");
  if (typeof p.langue !== "string" || !/^[a-z]{2}(-[A-Z]{2})?$/.test(p.langue)) pb.push("langue : code du type « fr » attendu");
  if (p.ambiance !== undefined && !AMBIANCES.includes(p.ambiance)) pb.push(`ambiance : ${AMBIANCES.join(" ou ")} attendu`);
  if (p.tutoiement !== undefined && typeof p.tutoiement !== "boolean") pb.push("tutoiement : vrai ou faux");
  if (!Array.isArray(p.etapes) || p.etapes.length === 0) return [...pb, "etapes : liste non vide attendue"];

  const ids = new Set<string>();
  const etapes = p.etapes as Partial<Etape>[];
  etapes.forEach((e, i) => {
    const ou = `étape ${i + 1}${e?.id ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object") { pb.push(`${ou} : objet attendu`); return; }
    if (typeof e.id !== "string" || !ID_VALIDE.test(e.id)) pb.push(`${ou} : identifiant invalide (minuscules, chiffres, - ou _)`);
    else if (ids.has(e.id)) pb.push(`${ou} : identifiant en double`);
    else ids.add(e.id);
    if (!TYPES.includes(e.type as TypeEtape)) pb.push(`${ou} : type inconnu`);
  });

  const cible = (ou: string, id: unknown) => {
    if (typeof id !== "string" || !ids.has(id)) pb.push(`${ou} : renvoie vers une étape inconnue (${String(id)})`);
  };
  const txt = (ou: string, champ: string, v: unknown, max = 300) => {
    if (typeof v !== "string" || !v.trim()) pb.push(`${ou} : « ${champ} » obligatoire`);
    else if (v.length > max) pb.push(`${ou} : « ${champ} » trop long (${max} caractères maximum)`);
  };

  const liste = (ou: string, champ: string, v: unknown, max: number, longueur: number) => {
    if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || !x.trim() || x.length > longueur)) {
      pb.push(`${ou} : « ${champ} » : ${max} textes au plus, de ${longueur} caractères au plus`);
    }
  };

  const { fonds, visuels } = validerHabillage(p.habillage, pb);
  const refs = (ou: string, x: { fond?: unknown; visuel?: unknown }, etape = true) => {
    if (x.fond !== undefined && (typeof x.fond !== "string" || !fonds.has(x.fond))) pb.push(`${ou} : fond inconnu (${String(x.fond)})`);
    const visuelChoisi = etape && x.visuel === VISUEL_DU_CHOIX;
    if (x.visuel !== undefined && !visuelChoisi && (typeof x.visuel !== "string" || !visuels.has(x.visuel))) pb.push(`${ou} : visuel inconnu (${String(x.visuel)})`);
  };

  let nbQuestions = 0;
  let consentementVu = false;
  for (const e of etapes) {
    if (!e || typeof e !== "object" || typeof e.id !== "string") continue;
    const ou = `étape ${e.id}`;
    if (e.suite !== undefined) cible(ou, e.suite);
    refs(ou, e);
    switch (e.type) {
      case "accueil":
        txt(ou, "titre", e.titre); txt(ou, "bouton", e.bouton, 40);
        if (e.surtitre !== undefined) txt(ou, "surtitre", e.surtitre, 40);
        if (e.bulles !== undefined) liste(ou, "bulles", e.bulles, 3, 120);
        break;
      case "pause":
        txt(ou, "titre", e.titre); txt(ou, "bouton", e.bouton, 40); break;
      case "identification":
        txt(ou, "titre", e.titre);
        if (e.texte !== undefined) txt(ou, "texte", e.texte, 120);
        break;
      case "cadrage":
        txt(ou, "titre", e.titre); break;
      case "fin":
        txt(ou, "titre", e.titre);
        if (e.sortie !== undefined) txt(ou, "sortie", e.sortie, 160);
        break;
      case "consentement":
        consentementVu = true; txt(ou, "titre", e.titre); txt(ou, "bouton", e.bouton, 40);
        if (e.texte !== undefined) txt(ou, "texte", e.texte, 160);
        if (e.consignes !== undefined) liste(ou, "consignes", e.consignes, 6, 140);
        if (e.proposerFloutage !== undefined && typeof e.proposerFloutage !== "boolean") pb.push(`${ou} : « proposerFloutage » vrai ou faux`);
        if (e.proposerDiffusion !== undefined && typeof e.proposerDiffusion !== "boolean") pb.push(`${ou} : « proposerDiffusion » vrai ou faux`);
        break;
      case "question": {
        nbQuestions++;
        if (!consentementVu) pb.push(`${ou} : une question ne peut pas précéder le consentement`);
        txt(ou, "texte", e.texte, 200);
        if (typeof e.dureeMaxSec !== "number" || e.dureeMaxSec < 5 || e.dureeMaxSec > 120) pb.push(`${ou} : durée maximale entre 5 et 120 secondes`);
        if (e.compteARebours !== undefined && (typeof e.compteARebours !== "number" || e.compteARebours < 0 || e.compteARebours > 10)) pb.push(`${ou} : compte à rebours entre 0 et 10 secondes`);
        if (e.silenceArretSec !== undefined && (typeof e.silenceArretSec !== "number" || e.silenceArretSec < 0 || e.silenceArretSec > 15)) pb.push(`${ou} : arrêt sur silence entre 0 et 15 secondes`);
        if (e.titreCourt !== undefined) txt(ou, "titreCourt", e.titreCourt, 40);
        if (e.pistes !== undefined) liste(ou, "pistes", e.pistes, 5, 40);
        if (e.coupDePouce !== undefined) txt(ou, "coupDePouce", e.coupDePouce, 100);
        break;
      }
      case "choix": {
        txt(ou, "titre", e.titre);
        if (!Array.isArray(e.options) || e.options.length < 2 || e.options.length > 8) { pb.push(`${ou} : entre 2 et 8 options`); break; }
        const optIds = new Set<string>();
        for (const o of e.options) {
          if (!o || typeof o.id !== "string" || !ID_VALIDE.test(o.id) || optIds.has(o.id)) pb.push(`${ou} : option à identifiant invalide ou en double`);
          else optIds.add(o.id);
          txt(ou, "libelle", o?.libelle, 60);
          if (o?.detail !== undefined) txt(ou, "detail", o.detail, 80);
          cible(`${ou}, option ${o?.id ?? "?"}`, o?.suite);
          if (o) refs(`${ou}, option ${o.id ?? "?"}`, o, false);
        }
        break;
      }
    }
  }

  if (nbQuestions === 0) pb.push("Le parcours doit contenir au moins une question");
  if (!consentementVu) pb.push("Le parcours doit contenir une étape de consentement");
  const derniere = etapes[etapes.length - 1];
  if (derniere?.type !== "fin") pb.push("La dernière étape doit être de type « fin »");
  if (pb.length === 0) pb.push(...verifierAtteignabilite(etapes as Etape[]));
  return pb;
}

const COULEUR = /^#[0-9a-fA-F]{6}$/;
/** Valeur réservée de `visuel` sur une étape : le visuel de la dernière option choisie. */
export const VISUEL_DU_CHOIX = "choix";
const SVG_MAX = 40_000;
const VISUELS_MAX_TOTAL = 240_000;
/** Ce qu'un visuel ne doit jamais contenir : scripts, contenus étrangers, liens vers l'extérieur. */
const SVG_INTERDIT = /<script|<foreignobject|<iframe|<image|javascript:|\son[a-z]+\s*=|href\s*=\s*(?!["']?#)|url\(\s*(?!["']?#)|@import/i;

/**
 * Vérifie l'habillage et renvoie les identifiants de fonds et de visuels connus (pour les renvois des étapes).
 * Un visuel est un SVG autonome : il est affiché comme une image (aucun script n'y tourne), et on refuse en plus
 * tout ce qui pourrait charger une ressource ou exécuter du code.
 */
export function validerHabillage(brut: unknown, pb: string[]): { fonds: Set<string>; visuels: Set<string> } {
  const fonds = new Set<string>();
  const visuels = new Set<string>();
  if (brut === undefined) return { fonds, visuels };
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) { pb.push("habillage : objet attendu"); return { fonds, visuels }; }
  const h = brut as Record<string, unknown>;
  const connues = new Set(["polices", "titresMajuscules", "couleurs", "fonds", "visuels"]);
  for (const k of Object.keys(h)) if (!connues.has(k)) pb.push(`habillage : clé inconnue « ${k} »`);
  const couleur = (ou: string, v: unknown) => { if (typeof v !== "string" || !COULEUR.test(v)) pb.push(`${ou} : couleur au format #RRGGBB attendue`); };

  if (h.polices !== undefined) {
    const p = h.polices as Record<string, unknown>;
    if (!p || typeof p !== "object" || Array.isArray(p)) pb.push("habillage.polices : objet attendu");
    else for (const [k, v] of Object.entries(p)) {
      if (k !== "titres" && k !== "texte") pb.push(`habillage.polices : clé inconnue « ${k} »`);
      else if (!POLICES.includes(v as Police)) pb.push(`habillage.polices.${k} : ${POLICES.join(", ")}`);
    }
  }
  if (h.titresMajuscules !== undefined && typeof h.titresMajuscules !== "boolean") pb.push("habillage.titresMajuscules : vrai ou faux");
  if (h.couleurs !== undefined) {
    const c = h.couleurs as Record<string, unknown>;
    if (!c || typeof c !== "object" || Array.isArray(c)) pb.push("habillage.couleurs : objet attendu");
    else for (const [k, v] of Object.entries(c)) {
      if (!["marque", "bulle", "visiteur", "fond", "texte"].includes(k)) pb.push(`habillage.couleurs : clé inconnue « ${k} »`);
      else couleur(`habillage.couleurs.${k}`, v);
    }
  }
  if (h.fonds !== undefined) {
    if (!Array.isArray(h.fonds) || h.fonds.length > 8) pb.push("habillage.fonds : 8 fonds au plus");
    else for (const a of h.fonds as Partial<Fond>[]) {
      const ou = `habillage, fond ${a?.id ?? "?"}`;
      if (!a || typeof a.id !== "string" || !ID_VALIDE.test(a.id) || fonds.has(a.id)) { pb.push(`${ou} : identifiant invalide ou en double`); continue; }
      fonds.add(a.id);
      couleur(`${ou}, couleur`, a.couleur);
      couleur(`${ou}, texte`, a.texte);
      if (a.couleurBas !== undefined) couleur(`${ou}, couleurBas`, a.couleurBas);
      if (a.nom !== undefined && (typeof a.nom !== "string" || a.nom.length > 40)) pb.push(`${ou} : nom de 40 caractères au plus`);
    }
  }
  if (h.visuels !== undefined) {
    if (!Array.isArray(h.visuels) || h.visuels.length > 12) pb.push("habillage.visuels : 12 visuels au plus");
    else {
      let total = 0;
      for (const v of h.visuels as Partial<Visuel>[]) {
        const ou = `habillage, visuel ${v?.id ?? "?"}`;
        if (!v || typeof v.id !== "string" || !ID_VALIDE.test(v.id) || visuels.has(v.id) || v.id === VISUEL_DU_CHOIX) { pb.push(`${ou} : identifiant invalide, réservé ou en double`); continue; }
        visuels.add(v.id);
        if (typeof v.nom !== "string" || !v.nom.trim() || v.nom.length > 40) pb.push(`${ou} : nom obligatoire (40 caractères au plus)`);
        if (typeof v.svg !== "string") { pb.push(`${ou} : « svg » obligatoire`); continue; }
        total += v.svg.length;
        if (v.svg.length > SVG_MAX) pb.push(`${ou} : SVG trop lourd (${SVG_MAX} caractères au plus)`);
        else if (!/^<svg[\s>]/.test(v.svg.trim()) || !v.svg.includes('xmlns="http://www.w3.org/2000/svg"')) pb.push(`${ou} : un SVG autonome est attendu (balise <svg xmlns="http://www.w3.org/2000/svg">)`);
        else if (SVG_INTERDIT.test(v.svg)) pb.push(`${ou} : le SVG ne doit contenir ni script, ni lien ou ressource externe`);
      }
      if (total > VISUELS_MAX_TOTAL) pb.push(`habillage.visuels : ${VISUELS_MAX_TOTAL} caractères au plus en tout`);
    }
  }
  return { fonds, visuels };
}

/** Toutes les étapes doivent être atteignables depuis la première, et toutes doivent mener à une fin. */
function verifierAtteignabilite(etapes: Etape[]): string[] {
  const index = new Map(etapes.map((e, i) => [e.id, i]));
  const suivantes = (e: Etape, i: number): string[] => {
    if (e.type === "fin") return [];
    if (e.type === "choix") return e.options.map((o) => o.suite);
    const s = e.suite ?? etapes[i + 1]?.id;
    return s ? [s] : [];
  };
  const vues = new Set<string>();
  const pile = [etapes[0]!.id];
  while (pile.length) {
    const id = pile.pop()!;
    if (vues.has(id)) continue;
    vues.add(id);
    const i = index.get(id)!;
    pile.push(...suivantes(etapes[i]!, i));
  }
  const pb = etapes.filter((e) => !vues.has(e.id)).map((e) => `étape ${e.id} : jamais atteinte`);
  for (const [i, e] of etapes.entries()) {
    if (e.type !== "fin" && suivantes(e, i).length === 0) pb.push(`étape ${e.id} : aucune suite`);
  }
  return pb;
}

/** La campagne propose-t-elle le consentement facultatif de diffusion publique ? */
export function diffusionProposee(p: Parcours): boolean {
  return p.etapes.some((e) => e.type === "consentement" && e.proposerDiffusion === true);
}

/** Étapes « choix » d'un parcours (qualification, embranchement), dans l'ordre de la configuration. */
export function choix(p: Parcours): EtapeChoix[] {
  return p.etapes.filter((e): e is EtapeChoix => e.type === "choix");
}

/** Liste des questions d'un parcours, dans l'ordre de la configuration. */
export function questions(p: Parcours): EtapeQuestion[] {
  return p.etapes.filter((e): e is EtapeQuestion => e.type === "question");
}
