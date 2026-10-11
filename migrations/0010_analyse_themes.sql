-- Parlopop — option Analyse, lot 2 : thèmes, tonalité, direct et alertes (11/10/2026).
-- Chaque réponse transcrite est classée par Mistral Large 3 selon la grille de thèmes de sa campagne.
-- On classe des propos, jamais des personnes : aucune note ni aucun profil n'est attaché à un visiteur.
-- La marque voit le classement dès qu'il est fait (décision du 11/10/2026) ; les vues agrégées s'ouvrent à 100 visiteurs.

-- Grille de thèmes de la campagne : JSON [{ "id", "libelle", "description"? }], 15 thèmes au plus.
ALTER TABLE campagnes ADD COLUMN grille_themes TEXT NOT NULL DEFAULT '[]';

-- Classement d'une réponse. État : NULL = non concernée ; a_faire ; en_cours ; faite ; echec.
ALTER TABLE reponses ADD COLUMN analyse_etat TEXT CHECK (analyse_etat IN ('a_faire', 'en_cours', 'faite', 'echec'));
ALTER TABLE reponses ADD COLUMN analyse_essais INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reponses ADD COLUMN analyse_le TEXT;
ALTER TABLE reponses ADD COLUMN analyse_erreur TEXT;
ALTER TABLE reponses ADD COLUMN analyse_grille TEXT;                  -- empreinte de la grille utilisée
-- Sujet abordé hors grille (« autres sujets »), en quelques mots.
ALTER TABLE reponses ADD COLUMN autre_sujet TEXT;
-- Insatisfaction forte exprimée dans le propos (alerte du jour), son motif en une phrase, et sa prise en compte.
ALTER TABLE reponses ADD COLUMN alerte INTEGER NOT NULL DEFAULT 0 CHECK (alerte IN (0, 1));
ALTER TABLE reponses ADD COLUMN alerte_motif TEXT;
ALTER TABLE reponses ADD COLUMN alerte_vue_le TEXT;
ALTER TABLE reponses ADD COLUMN alerte_vue_par TEXT;
CREATE INDEX idx_reponses_analyse ON reponses(analyse_etat) WHERE analyse_etat IN ('a_faire', 'en_cours');
CREATE INDEX idx_reponses_alerte ON reponses(alerte) WHERE alerte = 1;

-- Thèmes abordés dans une réponse : un propos peut en toucher plusieurs. Tonalité du propos sur ce thème,
-- extrait exact de la transcription et son moment dans la vidéo. Effacés avec la réponse.
CREATE TABLE reponse_themes (
  reponse_id  TEXT NOT NULL REFERENCES reponses(id) ON DELETE CASCADE,
  theme_id    TEXT NOT NULL,
  tonalite    TEXT NOT NULL CHECK (tonalite IN ('positif', 'neutre', 'negatif')),
  extrait     TEXT,
  debut       REAL,
  fin         REAL,
  PRIMARY KEY (reponse_id, theme_id)
);
CREATE INDEX idx_reponse_themes_theme ON reponse_themes(theme_id);
