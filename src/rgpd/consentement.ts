// Génération des textes de consentement au nom de la marque (responsable de traitement),
// WhyMe intervenant comme sous-traitant.
// ⚠ Textes provisoires : à faire valider par un avocat ou un DPO avant le premier contrat client.

export interface FicheClient {
  nom: string;
  raison_sociale: string;
  contact_rgpd: string;
}

export interface TextesConsentement {
  texte_interne: string;
  texte_diffusion: string;
}

function dureeLisible(jours: number): string {
  if (jours % 365 === 0) { const a = jours / 365; return a === 1 ? "1 an" : `${a} ans`; }
  if (jours % 30 === 0) { const m = jours / 30; return m === 1 ? "1 mois" : `${m} mois`; }
  return `${jours} jours`;
}

/**
 * Phrase ajoutée aux textes d'une campagne avec l'option Analyse. Sa présence est la condition pour transcrire :
 * une version de textes qui la contient porte analyse = 1 (voir textesMentionnentAnalyse).
 */
export const MENTION_ANALYSE =
  "Vos réponses sont aussi transcrites et analysées automatiquement pour en dégager les sujets abordés : " +
  "l'analyse porte sur ce que vous dites, jamais sur votre personne. Elle est réalisée dans l'Union européenne " +
  "par Mistral AI, sous-traitant de WhyMe. ";

/** Un texte rédigé à la main pour une campagne avec l'option doit au moins parler de transcription et d'analyse. */
export function textesMentionnentAnalyse(texteInterne: string): boolean {
  const t = texteInterne.toLowerCase();
  return t.includes("transcri") && t.includes("analys");
}

export function genererTextes(client: FicheClient, conservationJours: number, opts: { analyse?: boolean } = {}): TextesConsentement {
  const duree = dureeLisible(conservationJours);
  const texte_interne =
    `En cochant la case d'accord, vous acceptez que ${client.raison_sociale} (${client.nom}) enregistre ` +
    `vos réponses en vidéo pour analyser les avis de ses visiteurs. ` +
    (opts.analyse ? MENTION_ANALYSE : "") +
    `Les vidéos sont réservées à un usage interne, hébergées dans l'Union européenne par WhyMe pour le compte ` +
    `de ${client.nom}, et supprimées au bout de ${duree}. ` +
    `Vous pouvez retirer votre accord ou supprimer vos vidéos à tout moment grâce au QR code affiché à l'extérieur de la cabine, ` +
    `ou en écrivant à ${client.contact_rgpd}.`;
  const texte_diffusion =
    `J'accepte aussi que ${client.nom} utilise ma vidéo dans ses communications publiques ` +
    `(site, réseaux sociaux, publicité) pendant ${duree}. Facultatif.`;
  return { texte_interne, texte_diffusion };
}

export async function empreinte(t: TextesConsentement): Promise<string> {
  const data = new TextEncoder().encode(`${t.texte_interne}\n---\n${t.texte_diffusion}`);
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
