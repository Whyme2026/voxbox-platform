// Feuilles de style de Why me : l'allure d'une campagne (couleurs, motif) sur le téléphone du candidat, dans le film
// monté (plan d'ouverture et plans « question »), sur la page vidéo publique et dans les e-mails. Comme l'habillage
// des campagnes Parlobox, une marque change d'allure par configuration, jamais par du code propre à elle.
// Deux sortes de feuilles :
// - intégrées (ci-dessous) : « Bulles » (par défaut, charte why me) et « Épices » ; non modifiables ;
// - créées dans l'espace RH (table wm_styles) : trois couleurs choisies (principale, fond, texte), le reste en est
//   déduit (couleursDepuis), et un motif parmi MOTIFS. Une campagne y renvoie par l'identifiant (config.style) : modifier
//   la feuille change toutes ses campagnes.

import type { D1Database } from "../types.ts";
import { invalide } from "../http.ts";

export interface CouleursStyle {
  /** Couleur d'accent : boutons, liens, bulle des questions dans le film. */
  accent: string;
  accentFonce: string;
  /** Fond doux des encadrés (chiffres, vigilance, options choisies). */
  accentPale: string;
  /** Fond des bulles de conversation sur le téléphone. */
  bulle: string;
  titre: string;
  texte: string;
  fond: string;
  /** Fond des plans « ouverture » et « question » du film. */
  fondFilm: string;
  /** Petits textes du film (« Question 1/4 »). */
  discret: string;
  /** Texte dans la bulle du film. */
  texteBulle: string;
}

export interface StyleWhyme {
  id: string;
  nom: string;
  description: string;
  couleurs: CouleursStyle;
  /** Illustration ajoutée au téléphone et au film (montage/motifs/<motif>.svg et public/whyme/motifs/). */
  motif: string | null;
  /** Feuille livrée avec Why me (non modifiable, non supprimable). */
  integre?: boolean;
}

/** Dessins disponibles : un fichier SVG par motif, dans montage/motifs/ (film) et public/whyme/motifs/ (téléphone). */
export const MOTIFS: readonly { id: string; nom: string }[] = [
  { id: "piment", nom: "Piment rouge" },
  { id: "feuille", nom: "Feuille verte" },
  { id: "etoile", nom: "Étoile dorée" },
];

export const STYLES: readonly StyleWhyme[] = [
  {
    id: "bulles",
    nom: "Bulles (par défaut)",
    description: "La charte why me : fuchsia, fonds clairs, bulles de conversation.",
    couleurs: {
      accent: "#C6017C", accentFonce: "#9E0063", accentPale: "#FCE8F3", bulle: "#F6F5F3",
      titre: "#333333", texte: "#5E5E5E", fond: "#FFFFFF", fondFilm: "#FAF7F9", discret: "#8A7D86", texteBulle: "#FFFFFF",
    },
    motif: null,
    integre: true,
  },
  {
    id: "epices",
    nom: "Épices",
    description: "Rouge piment, safran et cannelle sur fond crème, avec un piment rouge. Pour les marques du goût et des épices.",
    couleurs: {
      accent: "#C8102E", accentFonce: "#8E0B1F", accentPale: "#FDE9DC", bulle: "#FFF1E0",
      titre: "#3B1F12", texte: "#6B4A36", fond: "#FFFBF5", fondFilm: "#FFF4E3", discret: "#A0643A", texteBulle: "#FFFFFF",
    },
    motif: "piment",
    integre: true,
  },
];

export const STYLE_DEFAUT = "bulles";
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Feuille intégrée ; à défaut, Bulles. Pour une feuille créée dans l'espace RH, voir chargerStyle. */
export function styleParId(id: string | undefined | null): StyleWhyme {
  return STYLES.find((s) => s.id === id) ?? STYLES.find((s) => s.id === STYLE_DEFAUT)!;
}

// ------------------------------------------------------------------ couleurs déduites
// Même calcul côté navigateur (public/rh/js/couleurs.js) pour l'aperçu en direct ; un test vérifie qu'ils concordent.

const versRvb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const versHex = (c: number[]) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
/** Mélange : t = 0 donne a, t = 1 donne b. */
const melange = (a: string, b: string, t: number) => { const x = versRvb(a), y = versRvb(b); return versHex(x.map((v, i) => v + (y[i]! - v) * t)); };
function luminance(h: string): number {
  const [r, g, b] = versRvb(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Rapport de contraste WCAG (1 à 21). */
export function contraste(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

export interface CouleursDeBase { accent: string; fond: string; titre: string }

/** Les dix couleurs d'une feuille à partir des trois choisies : principale, fond et texte. */
export function couleursDepuis(b: CouleursDeBase): CouleursStyle {
  return {
    accent: b.accent.toUpperCase(),
    accentFonce: melange(b.accent, "#000000", 0.25),
    accentPale: melange(b.accent, b.fond, 0.88),
    bulle: melange(b.titre, b.fond, 0.94),
    titre: b.titre.toUpperCase(),
    texte: melange(b.titre, b.fond, 0.22),
    fond: b.fond.toUpperCase(),
    fondFilm: melange(b.accent, b.fond, 0.95),
    discret: melange(b.titre, b.fond, 0.45),
    texteBulle: "#FFFFFF",
  };
}

/** Contrôle des trois couleurs : lisibles sur le téléphone (boutons à texte blanc, texte sur le fond). */
export function verifierCouleurs(d: Record<string, unknown>): CouleursDeBase {
  const lire = (cle: keyof CouleursDeBase, libelle: string) => {
    const v = d[cle];
    if (typeof v !== "string" || !HEX.test(v)) throw invalide(`${libelle} : couleur attendue au format #RRVVBB`);
    return v.toUpperCase();
  };
  const b = { accent: lire("accent", "Couleur principale"), fond: lire("fond", "Couleur de fond"), titre: lire("titre", "Couleur du texte") };
  if (contraste(b.accent, "#FFFFFF") < 3) throw invalide("Couleur principale trop claire : le texte blanc des boutons et de la bulle du film ne se lirait pas. Choisissez une teinte plus soutenue.");
  if (contraste(b.titre, b.fond) < 4.5) throw invalide("Le texte ne se lirait pas assez sur ce fond : foncez le texte ou éclaircissez le fond.");
  if (luminance(b.fond) < 0.6) throw invalide("Le fond doit rester clair (les écrans sont pensés pour un fond clair).");
  return b;
}

// ------------------------------------------------------------------ feuilles enregistrées

interface LigneStyle { id: string; nom: string; description: string; couleurs: string; motif: string | null }
const depuisLigne = (l: LigneStyle): StyleWhyme => ({ id: l.id, nom: l.nom, description: l.description, couleurs: JSON.parse(l.couleurs), motif: l.motif, integre: false });

/** Toutes les feuilles : intégrées d'abord, puis celles de l'espace RH par nom. */
export async function tousLesStyles(db: D1Database): Promise<StyleWhyme[]> {
  const r = await db.prepare("SELECT id, nom, description, couleurs, motif FROM wm_styles ORDER BY nom").all<LigneStyle>();
  return [...STYLES, ...r.results.map(depuisLigne)];
}

/** La feuille d'une campagne ; Bulles si elle a disparu (ne casse jamais un parcours ni un montage). */
export async function chargerStyle(db: D1Database, id: string | undefined | null): Promise<StyleWhyme> {
  const integre = STYLES.find((s) => s.id === id);
  if (integre || !id) return styleParId(id);
  const l = await db.prepare("SELECT id, nom, description, couleurs, motif FROM wm_styles WHERE id = ?").bind(id).first<LigneStyle>();
  return l ? depuisLigne(l) : styleParId(STYLE_DEFAUT);
}

/** Identifiants valides pour config.style (contrôle à l'enregistrement d'une campagne). */
export async function idsStyles(db: D1Database): Promise<Set<string>> {
  return new Set((await tousLesStyles(db)).map((s) => s.id));
}
