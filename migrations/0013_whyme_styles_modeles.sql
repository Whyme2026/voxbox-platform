-- Why me : feuilles de style et questionnaires types créés dans l'espace RH (12/10/2026).
-- Les feuilles et questionnaires livrés avec Why me restent dans le code (src/whyme/styles.ts, src/whyme/modeles.ts) ;
-- ces tables ne contiennent que ceux de l'équipe RH. Aucune donnée personnelle de candidat.

-- Feuille de style : identifiant lisible (config.style des campagnes y renvoie), les dix couleurs (JSON, déduites des
-- trois choisies) et un motif facultatif parmi ceux livrés (montage/motifs/, public/whyme/motifs/).
CREATE TABLE wm_styles (
  id           TEXT PRIMARY KEY,
  nom          TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  couleurs     TEXT NOT NULL,
  motif        TEXT,
  cree_par     TEXT NOT NULL,
  cree_le      TEXT NOT NULL,
  maj_le       TEXT NOT NULL
);

-- Questionnaire type : configuration d'une campagne sans événement ni organisateur (JSON).
CREATE TABLE wm_modeles (
  id           TEXT PRIMARY KEY,
  nom          TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  config       TEXT NOT NULL,
  cree_par     TEXT NOT NULL,
  cree_le      TEXT NOT NULL,
  maj_le       TEXT NOT NULL
);
