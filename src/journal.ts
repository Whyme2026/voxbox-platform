// Journal des accès et actions sensibles. Écriture seule : l'application ne modifie ni ne supprime jamais une ligne.

import type { D1Database } from "./types.ts";
import type { Identite } from "./auth/identite.ts";
import { maintenant, nouvelId } from "./http.ts";

export interface EntreeJournal {
  action: string;
  cibleType?: string;
  cibleId?: string;
  clientId?: string | null;
  details?: Record<string, unknown>;
}

export function ligneJournal(db: D1Database, qui: Identite | string, e: EntreeJournal) {
  const email = typeof qui === "string" ? qui : qui.email;
  return db
    .prepare(
      "INSERT INTO journal (id, quand, utilisateur_email, action, cible_type, cible_id, client_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      nouvelId(), maintenant(), email, e.action, e.cibleType ?? null, e.cibleId ?? null,
      e.clientId ?? null, e.details ? JSON.stringify(e.details) : null,
    );
}

export async function journaliser(db: D1Database, qui: Identite | string, e: EntreeJournal): Promise<void> {
  await ligneJournal(db, qui, e).run();
}
