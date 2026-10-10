-- Parlopop — accès du visiteur à ses vidéos par e-mail (QR code affiché à l'extérieur de la cabine).
-- Le visiteur saisit l'e-mail donné à l'identification ; un lien à durée limitée lui est envoyé. Seule l'empreinte
-- (SHA-256) du jeton est conservée ; les demandes de plus d'un jour sont effacées.
CREATE TABLE acces_visiteur (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL,
  jeton_empreinte  TEXT NOT NULL UNIQUE,
  cree_le          TEXT NOT NULL,
  expire_le        TEXT NOT NULL,
  envoye           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX acces_visiteur_email ON acces_visiteur (email, cree_le);
CREATE INDEX sessions_email ON sessions (email);
