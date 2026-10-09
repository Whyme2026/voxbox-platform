-- Vox Boxes — schéma du socle (lot 0)
-- Conventions : identifiants texte (UUID), dates en texte ISO 8601 UTC, JSON en texte.

CREATE TABLE clients (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  nom             TEXT NOT NULL,                 -- nom de marque affiché
  raison_sociale  TEXT NOT NULL,                 -- responsable de traitement (RGPD)
  contact_rgpd    TEXT NOT NULL,                 -- e-mail ou adresse affichée au visiteur
  logo_url        TEXT,
  couleurs        TEXT NOT NULL DEFAULT '{}',    -- JSON { principale, secondaire, texte }
  cree_le         TEXT NOT NULL,
  maj_le          TEXT NOT NULL
);

CREATE TABLE utilisateurs (
  id        TEXT PRIMARY KEY,
  email     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role      TEXT NOT NULL CHECK (role IN ('admin_whyme', 'operateur_whyme', 'validateur_client', 'lecteur_client')),
  client_id TEXT REFERENCES clients(id),
  actif     INTEGER NOT NULL DEFAULT 1,
  cree_le   TEXT NOT NULL,
  -- Un compte WhyMe n'est rattaché à aucun client ; un compte client l'est toujours.
  CHECK (
    (role IN ('admin_whyme', 'operateur_whyme') AND client_id IS NULL) OR
    (role IN ('validateur_client', 'lecteur_client') AND client_id IS NOT NULL)
  )
);

CREATE TABLE campagnes (
  id                       TEXT PRIMARY KEY,
  client_id                TEXT NOT NULL REFERENCES clients(id),
  slug                     TEXT NOT NULL,
  nom                      TEXT NOT NULL,
  debut                    TEXT,               -- date de début (AAAA-MM-JJ)
  fin                      TEXT,               -- date de fin
  statut                   TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon', 'validee', 'active', 'close')),
  conservation_jours       INTEGER NOT NULL DEFAULT 365 CHECK (conservation_jours BETWEEN 1 AND 1095),
  parcours_version_id      TEXT,
  consentement_version_id  TEXT,
  validee_par              TEXT,
  validee_le               TEXT,
  cree_le                  TEXT NOT NULL,
  maj_le                   TEXT NOT NULL,
  UNIQUE (client_id, slug)
);
CREATE INDEX idx_campagnes_client ON campagnes(client_id);

-- Chaque modification du parcours crée une nouvelle version : une session garde la version qu'elle a jouée.
CREATE TABLE parcours_versions (
  id           TEXT PRIMARY KEY,
  campagne_id  TEXT NOT NULL REFERENCES campagnes(id),
  numero       INTEGER NOT NULL,
  config       TEXT NOT NULL,                    -- JSON, voir src/parcours/schema.ts
  cree_par     TEXT NOT NULL,
  cree_le      TEXT NOT NULL,
  UNIQUE (campagne_id, numero)
);

-- Textes de consentement versionnés : la preuve du consentement renvoie à la version exacte affichée.
CREATE TABLE consentement_versions (
  id               TEXT PRIMARY KEY,
  campagne_id      TEXT NOT NULL REFERENCES campagnes(id),
  numero           INTEGER NOT NULL,
  texte_interne    TEXT NOT NULL,                -- usage interne (analyse des avis), obligatoire
  texte_diffusion  TEXT NOT NULL,                -- diffusion publique (droit à l'image), facultatif
  empreinte        TEXT NOT NULL,                -- SHA-256 des deux textes
  cree_par         TEXT NOT NULL,
  cree_le          TEXT NOT NULL,
  UNIQUE (campagne_id, numero)
);

CREATE TABLE cabines (
  id              TEXT PRIMARY KEY,
  nom             TEXT NOT NULL,
  code_appairage  TEXT UNIQUE,                   -- code court saisi une fois sur la tablette
  jeton_hash      TEXT,                          -- empreinte du jeton de la tablette appairée
  campagne_id     TEXT REFERENCES campagnes(id),
  dernier_signal  TEXT,                          -- JSON { reseau, batterie, file, micro }
  vu_le           TEXT,
  cree_le         TEXT NOT NULL
);

CREATE TABLE sessions (
  id                       TEXT PRIMARY KEY,
  campagne_id              TEXT NOT NULL REFERENCES campagnes(id),
  cabine_id                TEXT REFERENCES cabines(id),
  canal                    TEXT NOT NULL CHECK (canal IN ('cabine', 'lien', 'qr')),
  prenom                   TEXT NOT NULL,
  nom                      TEXT,
  email                    TEXT,
  recontact                INTEGER NOT NULL DEFAULT 0,
  consent_interne          INTEGER NOT NULL CHECK (consent_interne = 1),
  consent_diffusion        INTEGER NOT NULL DEFAULT 0,
  consentement_version_id  TEXT NOT NULL REFERENCES consentement_versions(id),
  parcours_version_id      TEXT NOT NULL REFERENCES parcours_versions(id),
  code_retrait             TEXT NOT NULL UNIQUE,
  cree_le                  TEXT NOT NULL,
  purge_prevue_le          TEXT NOT NULL,
  retiree_le               TEXT,
  purgee_le                TEXT
);
CREATE INDEX idx_sessions_campagne ON sessions(campagne_id);
CREATE INDEX idx_sessions_purge ON sessions(purge_prevue_le) WHERE purgee_le IS NULL;

CREATE TABLE reponses (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  etape_id      TEXT NOT NULL,
  cle_source    TEXT,                            -- fichier WebM reçu de la tablette
  cle_16_9      TEXT,
  cle_9_16      TEXT,
  duree_ms      INTEGER,
  son_present   INTEGER,
  transcription TEXT,
  statut        TEXT NOT NULL DEFAULT 'attendue' CHECK (statut IN ('attendue', 'recue', 'traitement', 'prete', 'erreur')),
  erreur        TEXT,
  cree_le       TEXT NOT NULL,
  maj_le        TEXT NOT NULL,
  UNIQUE (session_id, etape_id)
);

-- Journal des accès et actions sensibles. Jamais modifié ni supprimé par l'application.
CREATE TABLE journal (
  id                 TEXT PRIMARY KEY,
  quand              TEXT NOT NULL,
  utilisateur_email  TEXT NOT NULL,
  action             TEXT NOT NULL,
  cible_type         TEXT,
  cible_id           TEXT,
  client_id          TEXT,
  details            TEXT
);
CREATE INDEX idx_journal_quand ON journal(quand);
CREATE INDEX idx_journal_client ON journal(client_id, quand);
