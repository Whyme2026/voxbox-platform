// Description d'un parcours de cabine : une suite d'étapes typées, stockée en JSON et versionnée.
// Le même moteur sert la cabine, le lien à distance et le QR code.
// Rien ici n'est propre à un secteur : l'automobile n'est qu'un exemple de configuration.

export type TypeEtape = "accueil" | "identification" | "consentement" | "cadrage" | "question" | "choix" | "pause" | "fin";

interface EtapeBase {
  id: string;
  type: TypeEtape;
  /** Étape suivante. Par défaut : l'étape d'après dans la liste. */
  suite?: string;
}

export interface EtapeAccueil extends EtapeBase { type: "accueil"; titre: string; texte?: string; bouton: string }
export interface EtapeIdentification extends EtapeBase {
  type: "identification";
  titre: string;
  demanderNom?: boolean;
  demanderEmail?: boolean;
}
export interface EtapeConsentement extends EtapeBase {
  type: "consentement";
  titre: string;
  bouton: string;
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
}
export interface OptionChoix { id: string; libelle: string; image?: string; suite: string }
export interface EtapeChoix extends EtapeBase { type: "choix"; titre: string; options: OptionChoix[] }
export interface EtapePause extends EtapeBase { type: "pause"; titre: string; texte?: string; bouton: string }
export interface EtapeFin extends EtapeBase { type: "fin"; titre: string; texte?: string; retourAccueilSec?: number }

export type Etape =
  | EtapeAccueil | EtapeIdentification | EtapeConsentement | EtapeCadrage
  | EtapeQuestion | EtapeChoix | EtapePause | EtapeFin;

export interface Parcours {
  version: 1;
  langue: string;
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

  let nbQuestions = 0;
  let consentementVu = false;
  for (const e of etapes) {
    if (!e || typeof e !== "object" || typeof e.id !== "string") continue;
    const ou = `étape ${e.id}`;
    if (e.suite !== undefined) cible(ou, e.suite);
    switch (e.type) {
      case "accueil": case "pause":
        txt(ou, "titre", e.titre); txt(ou, "bouton", e.bouton, 40); break;
      case "identification": case "cadrage": case "fin":
        txt(ou, "titre", e.titre); break;
      case "consentement":
        consentementVu = true; txt(ou, "titre", e.titre); txt(ou, "bouton", e.bouton, 40);
        if (e.proposerDiffusion !== undefined && typeof e.proposerDiffusion !== "boolean") pb.push(`${ou} : « proposerDiffusion » vrai ou faux`);
        break;
      case "question": {
        nbQuestions++;
        if (!consentementVu) pb.push(`${ou} : une question ne peut pas précéder le consentement`);
        txt(ou, "texte", e.texte, 200);
        if (typeof e.dureeMaxSec !== "number" || e.dureeMaxSec < 5 || e.dureeMaxSec > 120) pb.push(`${ou} : durée maximale entre 5 et 120 secondes`);
        if (e.compteARebours !== undefined && (typeof e.compteARebours !== "number" || e.compteARebours < 0 || e.compteARebours > 10)) pb.push(`${ou} : compte à rebours entre 0 et 10 secondes`);
        if (e.silenceArretSec !== undefined && (typeof e.silenceArretSec !== "number" || e.silenceArretSec < 0 || e.silenceArretSec > 15)) pb.push(`${ou} : arrêt sur silence entre 0 et 15 secondes`);
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
          cible(`${ou}, option ${o?.id ?? "?"}`, o?.suite);
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

/** Liste des questions d'un parcours, dans l'ordre de la configuration. */
export function questions(p: Parcours): EtapeQuestion[] {
  return p.etapes.filter((e): e is EtapeQuestion => e.type === "question");
}
