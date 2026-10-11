// Feuilles de style de Why me : l'allure d'une campagne (couleurs, motif) sur le téléphone du candidat, dans le film
// monté (plan d'ouverture et plans « question ») et dans les e-mails. Comme l'habillage des campagnes Parlobox, une
// marque change d'allure par configuration, jamais par du code propre à elle : on ajoute une feuille ici.
// « Bulles » est la feuille par défaut (charte why me, fuchsia).

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
  motif: "piment" | null;
}

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
  },
];

export const STYLE_DEFAUT = "bulles";

export function styleParId(id: string | undefined | null): StyleWhyme {
  return STYLES.find((s) => s.id === id) ?? STYLES.find((s) => s.id === STYLE_DEFAUT)!;
}
