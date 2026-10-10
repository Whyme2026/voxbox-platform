// Matrice des droits. Toute route protégée appelle exiger() avec l'action visée.
// Le cloisonnement entre clients est garanti par perimetreClient() : un compte client ne voit
// jamais que son propre client, quel que soit ce que la requête demande.

import { interdit, introuvable } from "../http.ts";
import type { Identite, Role } from "./identite.ts";

export type Action =
  | "clients.gerer"          // créer, modifier une fiche client
  | "utilisateurs.gerer"     // créer des comptes, changer des rôles
  | "campagnes.gerer"        // créer, paramétrer, activer, clore une campagne
  | "campagnes.lire"
  | "campagnes.valider"      // valider questions et textes avant lancement
  | "cabines.gerer"
  | "reponses.lire"
  | "visiteurs.gerer"        // supprimer les données d'un visiteur, retirer son accord de diffusion
  | "journal.lire";

const MATRICE: Record<Role, readonly Action[]> = {
  admin_whyme: [
    "clients.gerer", "utilisateurs.gerer", "campagnes.gerer", "campagnes.lire",
    "campagnes.valider", "cabines.gerer", "reponses.lire", "visiteurs.gerer", "journal.lire",
  ],
  operateur_whyme: ["campagnes.gerer", "campagnes.lire", "cabines.gerer", "reponses.lire", "visiteurs.gerer"],
  validateur_client: ["campagnes.lire", "campagnes.valider", "reponses.lire", "visiteurs.gerer"],
  lecteur_client: ["campagnes.lire", "reponses.lire"],
};

export function peut(identite: Identite, action: Action): boolean {
  return MATRICE[identite.role].includes(action);
}

export function exiger(identite: Identite, action: Action): void {
  if (!peut(identite, action)) throw interdit();
}

/**
 * Client auquel limiter une lecture. Pour un compte WhyMe : le client demandé (ou aucun filtre).
 * Pour un compte client : toujours son propre client, et refus s'il en demande un autre.
 */
export function perimetreClient(identite: Identite, clientDemande?: string | null): string | null {
  if (identite.clientId === null) return clientDemande ?? null;
  if (clientDemande && clientDemande !== identite.clientId) throw interdit();
  return identite.clientId;
}

/**
 * Vérifie qu'une ressource appartenant à `clientId` est accessible à cette identité.
 * Répond « introuvable » plutôt que « interdit » : un client ne doit pas pouvoir deviner
 * l'existence des ressources d'un autre client.
 */
export function verifierAppartenance(identite: Identite, clientId: string): void {
  if (identite.clientId !== null && identite.clientId !== clientId) throw introuvable();
}
