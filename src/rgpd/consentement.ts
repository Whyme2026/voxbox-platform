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

export function genererTextes(client: FicheClient, conservationJours: number): TextesConsentement {
  const duree = dureeLisible(conservationJours);
  const texte_interne =
    `En touchant « C'est parti », vous acceptez que ${client.raison_sociale} (${client.nom}) enregistre ` +
    `vos réponses en vidéo pour analyser les avis de ses clients. ` +
    `Les vidéos sont réservées à un usage interne, hébergées dans l'Union européenne par WhyMe pour le compte ` +
    `de ${client.nom}, et supprimées au bout de ${duree}. ` +
    `Vous pouvez retirer votre accord à tout moment grâce au lien qui vous est remis, ou en écrivant à ${client.contact_rgpd}.`;
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
