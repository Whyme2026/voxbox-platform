// E-mails de Why me : vidéo prête, reprise d'une interview interrompue, connexion des recruteurs.
// Chaque e-mail est gardé dans wm_courriels (effacé après 7 jours) ; il part chez Brevo si la clé est configurée.
// Sans clé (environnement de test), il reste lisible dans Parlorama : rien n'est perdu en silence.

import type { Env, D1PreparedStatement } from "../types.ts";
import { envoyerCourriel } from "../courriel.ts";
import { maintenant, nouvelId } from "../http.ts";
import { ACCES_RECRUTEURS_MOIS } from "./config.ts";

export type SorteCourriel = "video_prete" | "reprise" | "connexion_recruteur" | "connexion_client";

const FUCHSIA = "#C6017C";
const ENCRE = "#333333";
const GRIS = "#5E5E5E";

const echapper = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function gabarit(contenu: string, pied: string): string {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#F6F5F3;font-family:'Source Sans 3',Helvetica,Arial,sans-serif;color:${GRIS}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden">
<tr><td style="background:${FUCHSIA};height:6px;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 8px;font-size:22px;font-weight:700;color:${FUCHSIA};letter-spacing:-0.5px">why me</td></tr>
<tr><td style="padding:0 32px 24px;font-size:16px;line-height:1.55">${contenu}</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid #E4E6E9;font-size:13px;line-height:1.5;color:${GRIS}">${pied}</td></tr>
</table></td></tr></table></body></html>`;
}

const bouton = (lien: string, texte: string) =>
  `<p style="margin:24px 0"><a href="${echapper(lien)}" style="display:inline-block;background:${FUCHSIA};color:#FFFFFF;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px">${echapper(texte)}</a></p>`;

const listeEntreprises = (noms: string[]) =>
  noms.length <= 1 ? noms.join("") : `${noms.slice(0, -1).join(", ")} et ${noms[noms.length - 1]}`;

export interface VideoPrete {
  prenom: string;
  evenement: string;
  organisateur?: string;
  entreprises: string[];
  aCv: boolean;
  /** Page publique et sticker : seulement si le candidat l'a acceptée. */
  lienVideo: string | null;
  lienSticker: string | null;
  lienGestion: string;
  lienConfidentialite: string;
}

/** E-mail envoyé quand le montage est prêt et la candidature transmise. Reprend le texte de la room actuelle. */
export function courrielVideoPrete(v: VideoPrete): { sujet: string; texte: string; html: string } {
  const lieu = v.organisateur ? `de ${v.organisateur} au ${v.evenement}` : `du ${v.evenement}`;
  const quoi = v.aCv ? "Ton CV et ton interview vidéo leur sont" : "Ton interview vidéo leur est";
  const sujet = "Ta vidéo WhyMe est prête !";
  const texte = [
    `Hello ${v.prenom},`,
    "",
    `Merci pour ton passage dans la JobBox WhyMe ${lieu}.`,
    `Ta candidature est partie chez ${listeEntreprises(v.entreprises)}. ${quoi} ${v.aCv ? "accessibles" : "accessible"} pendant ${ACCES_RECRUTEURS_MOIS} mois. Si ton profil correspond à une opportunité, elles pourront reprendre contact avec toi directement.`,
    "",
    ...(v.lienVideo ? [
      `Voir ta vidéo : ${v.lienVideo}`,
      `Ton sticker QR code : ${v.lienSticker}`,
      "Ajoute-le à ton CV numérique, à ton profil LinkedIn, ou partage-le lors de tes prochaines candidatures.",
      "",
    ] : []),
    "Ta personnalité ne se résume pas à quelques lignes. Maintenant, tu peux aussi la montrer.",
    "Bonne chance pour la suite,",
    "L'équipe WhyMe",
    "",
    "Tu gardes la main :",
    `- supprimer ma vidéo ou toutes mes données : ${v.lienGestion}`,
    `- politique de confidentialité : ${v.lienConfidentialite}`,
  ].join("\n");

  const contenu = [
    `<p style="font-size:20px;font-weight:700;color:${ENCRE};margin:0 0 12px">Hello ${echapper(v.prenom)},</p>`,
    `<p>Merci pour ton passage dans la JobBox WhyMe ${echapper(lieu)}.</p>`,
    `<p>Ta candidature est partie chez <strong style="color:${ENCRE}">${echapper(listeEntreprises(v.entreprises))}</strong>. ${quoi} ${v.aCv ? "accessibles" : "accessible"} pendant ${ACCES_RECRUTEURS_MOIS} mois. Si ton profil correspond à une opportunité, elles pourront reprendre contact avec toi directement.</p>`,
    ...(v.lienVideo ? [
      bouton(v.lienVideo, "Voir ma vidéo"),
      `<p style="margin:0 0 8px;font-weight:600;color:${ENCRE}">Et l'expérience ne s'arrête pas là !</p>`,
      `<p style="margin:0 0 12px">Voici ton sticker QR code, qui mène directement à ta vidéo :</p>`,
      `<p style="margin:0 0 8px"><img src="${echapper(v.lienSticker!)}" width="180" height="180" alt="QR code vers ma vidéo WhyMe" style="display:block;border:0"></p>`,
      `<p style="margin:0 0 16px;font-size:14px"><a href="${echapper(v.lienSticker!)}" style="color:${FUCHSIA}">Télécharger le sticker</a></p>`,
      `<ul style="padding-left:20px;margin:0 0 16px"><li>ajoute-le à ton CV numérique ;</li><li>intègre-le à ton profil LinkedIn ;</li><li>partage-le lors de tes prochaines candidatures.</li></ul>`,
    ] : []),
    `<p>Ta personnalité ne se résume pas à quelques lignes. Maintenant, tu peux aussi la montrer.</p>`,
    `<p>Bonne chance pour la suite,<br>L'équipe WhyMe</p>`,
  ].join("\n");
  const pied = `<strong style="color:${ENCRE}">Tu gardes la main.</strong> <a href="${echapper(v.lienGestion)}" style="color:${FUCHSIA}">Supprimer ma vidéo ou toutes mes données</a> · <a href="${echapper(v.lienConfidentialite)}" style="color:${FUCHSIA}">Politique de confidentialité</a><br>WhyNot (WhyMe) héberge ta candidature en Europe pour les entreprises choisies. Personne ne note ni n'analyse automatiquement ta vidéo.`;
  return { sujet, texte, html: gabarit(contenu, pied) };
}

/** Interview interrompue (coupure, appel, onglet fermé) : lien pour reprendre où le candidat en était. */
export function courrielReprise(prenom: string, evenement: string, lien: string): { sujet: string; texte: string; html: string } {
  const sujet = "Ton interview WhyMe t'attend";
  const texte = `Hello ${prenom},\n\nTon interview WhyMe (${evenement}) s'est interrompue. Tes réponses déjà enregistrées sont gardées : reprends là où tu en étais.\n\n${lien}\n\nSi tu ne la termines pas, elle sera effacée dans 30 jours.\nL'équipe WhyMe`;
  const html = gabarit(
    `<p style="font-size:20px;font-weight:700;color:${ENCRE};margin:0 0 12px">Hello ${echapper(prenom)},</p>
<p>Ton interview WhyMe (${echapper(evenement)}) s'est interrompue. Tes réponses déjà enregistrées sont gardées : reprends là où tu en étais.</p>
${bouton(lien, "Reprendre mon interview")}
<p>L'équipe WhyMe</p>`,
    "Si tu ne la termines pas, elle sera effacée dans 30 jours, et ta candidature ne sera pas transmise.",
  );
  return { sujet, texte, html };
}

export function courrielConnexionRecruteur(entreprise: string, lien: string, espace = "l'espace recruteur WhyMe"): { sujet: string; texte: string; html: string } {
  const sujet = "Votre lien de connexion WhyMe";
  const texte = `Bonjour,\n\nVoici votre lien de connexion à ${espace} (${entreprise}). Il est valable 15 minutes et ne sert qu'une fois.\n\n${lien}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.\nL'équipe WhyMe`;
  const html = gabarit(
    `<p style="font-size:20px;font-weight:700;color:${ENCRE};margin:0 0 12px">Bonjour,</p>
<p>Voici votre lien de connexion à ${echapper(espace)} (${echapper(entreprise)}). Il est valable 15 minutes et ne sert qu'une fois.</p>
${bouton(lien, "Ouvrir mon espace")}`,
    "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.",
  );
  return { sujet, texte, html };
}

/** Adresse d'expédition des e-mails Why me (doit être un expéditeur vérifié du compte Brevo). */
export const expediteurWhyme = (env: Env) => env.COURRIEL_EXPEDITEUR_WHYME ?? "hello@whyme.jobs";

/** Garde l'e-mail dans wm_courriels et l'envoie par Brevo si la clé est configurée. Ne lève pas d'erreur. */
export async function envoyerWhyme(env: Env, a: string, sorte: SorteCourriel, c: { sujet: string; texte: string; html: string }): Promise<boolean> {
  let envoye = false;
  if (env.BREVO_CLE) {
    try {
      await envoyerCourriel(env, { a, ...c, expediteur: "WhyMe", de: expediteurWhyme(env) });
      envoye = true;
    } catch (e) {
      console.error("Why me : e-mail non parti", sorte, e);
    }
  }
  await enregistrerCourriel(env, a, sorte, c, envoye).run();
  return envoye;
}

export function enregistrerCourriel(env: Env, a: string, sorte: SorteCourriel, c: { sujet: string; texte: string; html: string }, envoye: boolean): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO wm_courriels (id, a, sujet, texte, html, sorte, envoye, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(nouvelId(), a, c.sujet, c.texte, c.html, sorte, envoye ? 1 : 0, maintenant());
}
