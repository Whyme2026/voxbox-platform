-- Parlopop — choix faits par le visiteur aux étapes « choix » (qualification, aiguillage, modèle) : une ligne par étape.
-- Ce que la personne a déclaré, jamais une note ou un profil calculé. Supprimés avec ses réponses en cas de retrait.
CREATE TABLE choix (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  etape_id   TEXT NOT NULL,
  option_id  TEXT NOT NULL,
  cree_le    TEXT NOT NULL,
  PRIMARY KEY (session_id, etape_id)
);
