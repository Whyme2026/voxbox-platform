// Lecture et transitions de statut des campagnes, partagées entre l'espace WhyMe et l'espace client.

import type { D1Database } from "../types.ts";
import type { Identite } from "../auth/identite.ts";
import { verifierAppartenance } from "../auth/droits.ts";
import { conflit, introuvable, maintenant } from "../http.ts";
import { ligneJournal } from "../journal.ts";
import { prochainePurge } from "../rgpd/purge.ts";

export type Statut = "brouillon" | "validee" | "active" | "close";

export interface LigneCampagne {
  id: string;
  client_id: string;
  slug: string;
  nom: string;
  debut: string | null;
  fin: string | null;
  statut: Statut;
  conservation_jours: number;
  /** Option Analyse (0 ou 1) : transcription puis analyse des réponses, vendue campagne par campagne. */
  option_analyse: number;
  /** JSON : termes propres à la campagne transmis au service de transcription. */
  vocabulaire: string;
  /** JSON : grille de thèmes de l'option Analyse ([{ id, libelle, description? }]). */
  grille_themes: string;
  parcours_version_id: string | null;
  consentement_version_id: string | null;
  validee_par: string | null;
  validee_le: string | null;
  cree_le: string;
  maj_le: string;
}

export async function chargerCampagne(db: D1Database, identite: Identite, id: string): Promise<LigneCampagne> {
  const c = await db.prepare("SELECT * FROM campagnes WHERE id = ?").bind(id).first<LigneCampagne>();
  if (!c) throw introuvable("Campagne introuvable");
  verifierAppartenance(identite, c.client_id);
  return c;
}

/** Campagne avec la version courante de son parcours et de ses textes de consentement. */
export async function detailCampagne(db: D1Database, c: LigneCampagne) {
  const parcours = c.parcours_version_id
    ? await db.prepare("SELECT id, numero, config, cree_par, cree_le FROM parcours_versions WHERE id = ?")
        .bind(c.parcours_version_id).first<{ id: string; numero: number; config: string; cree_par: string; cree_le: string }>()
    : null;
  const consentement = c.consentement_version_id
    ? await db.prepare("SELECT id, numero, texte_interne, texte_diffusion, empreinte, analyse, cree_le FROM consentement_versions WHERE id = ?")
        .bind(c.consentement_version_id).first()
    : null;
  const client = await db.prepare("SELECT nom, logo_url, couleurs FROM clients WHERE id = ?").bind(c.client_id)
    .first<{ nom: string; logo_url: string | null; couleurs: string }>();
  return {
    ...c,
    option_analyse: c.option_analyse === 1,
    vocabulaire: JSON.parse(c.vocabulaire) as string[],
    grille_themes: JSON.parse(c.grille_themes) as unknown[],
    // Purge à échéance : prochaine date et visiteurs concernés (affiché dans Parlorama).
    purge: await prochainePurge(db, c.id),
    client: client ? { nom: client.nom, logo_url: client.logo_url, couleurs: JSON.parse(client.couleurs) as unknown } : null,
    parcours: parcours ? { ...parcours, config: JSON.parse(parcours.config) as unknown } : null,
    consentement,
  };
}

/** Transitions autorisées. La validation par le client fige le contenu ; toute modification la remet en brouillon. */
const TRANSITIONS: Record<Statut, readonly Statut[]> = {
  brouillon: ["validee"],
  validee: ["active", "brouillon"],
  active: ["close"],
  close: [],
};

export async function changerStatut(db: D1Database, identite: Identite, c: LigneCampagne, cible: Statut): Promise<void> {
  if (!TRANSITIONS[c.statut].includes(cible)) {
    throw conflit(`Passage de « ${c.statut} » à « ${cible} » impossible`);
  }
  if (cible === "validee" && (!c.parcours_version_id || !c.consentement_version_id)) {
    throw conflit("Le parcours et les textes de consentement doivent être définis avant validation");
  }
  if (cible === "validee" && c.option_analyse === 1) {
    const v = await db.prepare("SELECT analyse FROM consentement_versions WHERE id = ?").bind(c.consentement_version_id).first<{ analyse: number }>();
    if (v?.analyse !== 1) throw conflit("Option Analyse : les textes de consentement doivent mentionner la transcription et l'analyse avant validation");
  }
  const now = maintenant();
  const validation = cible === "validee" ? [identite.email, now] : cible === "brouillon" ? [null, null] : [c.validee_par, c.validee_le];
  await db.batch([
    db.prepare("UPDATE campagnes SET statut = ?, validee_par = ?, validee_le = ?, maj_le = ? WHERE id = ? AND statut = ?")
      .bind(cible, validation[0], validation[1], now, c.id, c.statut),
    ligneJournal(db, identite, {
      action: `campagne.statut.${cible}`, cibleType: "campagne", cibleId: c.id, clientId: c.client_id,
      details: { avant: c.statut, apres: cible },
    }),
  ]);
}

/** Le contenu d'une campagne active ou close ne se modifie plus ; une campagne validée repasse en brouillon. */
export function verifierModifiable(c: LigneCampagne): void {
  if (c.statut === "active" || c.statut === "close") {
    throw conflit("Une campagne active ou close ne peut plus être modifiée");
  }
}
