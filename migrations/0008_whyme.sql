-- Why me (JobBox smartphone) : interview vidéo du candidat sur son propre téléphone, via un QR code par campagne.
-- Produit distinct de Parlopop sur la même plateforme (même Worker, même base, même stockage, même journal).
-- Règles : aucune note ni analyse du candidat ; rushes supprimés après montage ; recruteurs 12 mois ; lien public
-- 24 mois ; tout est en 9:16. Voir docs/whyme.md.

-- Entreprises recruteuses : communes à toutes les campagnes (une entreprise participe à plusieurs événements).
CREATE TABLE wm_entreprises (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  nom        TEXT NOT NULL,
  logo_cle   TEXT,                                -- image dans R2 (PNG, JPEG ou WebP)
  cree_le    TEXT NOT NULL,
  maj_le     TEXT NOT NULL
);

-- Campagne = un événement (ou un lien digital). Le QR code ouvre /i/<code>.
CREATE TABLE wm_campagnes (
  id                 TEXT PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,         -- dans l'adresse du QR code
  nom                TEXT NOT NULL,                -- nom interne
  statut             TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon', 'active', 'close')),
  config             TEXT NOT NULL,                -- JSON validé par src/whyme/config.ts
  textes_empreinte   TEXT NOT NULL,                -- SHA-256 des textes de consentement affichés
  textes             TEXT NOT NULL,                -- JSON des textes de consentement (preuve)
  cree_par           TEXT NOT NULL,
  cree_le            TEXT NOT NULL,
  maj_le             TEXT NOT NULL
);

-- Entreprises proposées dans une campagne.
CREATE TABLE wm_campagne_entreprises (
  campagne_id    TEXT NOT NULL REFERENCES wm_campagnes(id),
  entreprise_id  TEXT NOT NULL REFERENCES wm_entreprises(id),
  ordre          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campagne_id, entreprise_id)
);

-- Candidat : une interview. L'identifiant est créé par le téléphone (reprise après coupure, envoi idempotent).
CREATE TABLE wm_candidats (
  id                    TEXT PRIMARY KEY,
  campagne_id           TEXT NOT NULL REFERENCES wm_campagnes(id),
  jeton_empreinte       TEXT NOT NULL,             -- jeton du téléphone (envois, reprise)
  gestion_empreinte     TEXT NOT NULL,             -- jeton du lien « tu gardes la main » de l'e-mail
  prenom                TEXT NOT NULL,
  nom                   TEXT NOT NULL,
  email                 TEXT NOT NULL,
  age                   INTEGER,                   -- âge déclaré (affiché si la campagne le prévoit, contrôle d'âge minimum)
  famille               TEXT,                      -- famille de postes choisie
  consent_candidature   INTEGER NOT NULL CHECK (consent_candidature = 1),
  consent_public        INTEGER NOT NULL DEFAULT 0,
  textes_empreinte      TEXT NOT NULL,             -- version des textes vus par le candidat
  cv_cle                TEXT,
  cv_nom                TEXT,
  cv_type               TEXT,
  cv_taille             INTEGER,
  -- en_cours → termine (toutes les réponses reçues) → montage → pret (montage livré, candidatures transmises)
  statut                TEXT NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'termine', 'montage', 'pret', 'erreur')),
  erreur                TEXT,
  montage_cle           TEXT,
  montage_taille        INTEGER,
  montage_duree_ms      INTEGER,
  miniature_cle         TEXT,
  code_public           TEXT UNIQUE,               -- page /v/<code> (si consent_public)
  origine               TEXT NOT NULL,             -- adresse du site (liens des e-mails envoyés plus tard)
  derniere_action_le    TEXT NOT NULL,
  reprise_envoyee_le    TEXT,
  montage_demande_le    TEXT,
  montage_essais        INTEGER NOT NULL DEFAULT 0,
  termine_le            TEXT,
  pret_le               TEXT,
  courriel_envoye_le    TEXT,
  acces_recruteurs_jusqu TEXT,                     -- fin de l'accès des recruteurs (12 mois après la transmission)
  public_jusqu          TEXT,                      -- fin du lien public (24 mois)
  video_supprimee_le    TEXT,                      -- le candidat a supprimé sa vidéo (ou échéance)
  cree_le               TEXT NOT NULL,
  supprime_le           TEXT                       -- données effacées (le candidat l'a demandé, ou purge)
);
CREATE INDEX wm_candidats_campagne ON wm_candidats (campagne_id, cree_le);
CREATE INDEX wm_candidats_statut ON wm_candidats (statut, derniere_action_le);

-- Une candidature = un candidat × une entreprise. Transmise quand le montage est prêt.
CREATE TABLE wm_candidatures (
  candidat_id    TEXT NOT NULL REFERENCES wm_candidats(id),
  entreprise_id  TEXT NOT NULL REFERENCES wm_entreprises(id),
  transmise_le   TEXT,
  retiree_le     TEXT,
  PRIMARY KEY (candidat_id, entreprise_id)
);
CREATE INDEX wm_candidatures_entreprise ON wm_candidatures (entreprise_id, transmise_le);

-- Prises gardées (une par question ; une reprise remplace la précédente). Supprimées après le montage.
CREATE TABLE wm_prises (
  candidat_id   TEXT NOT NULL REFERENCES wm_candidats(id),
  question_id   TEXT NOT NULL,
  cle           TEXT NOT NULL,
  type          TEXT NOT NULL,
  duree_ms      INTEGER,
  son_present   INTEGER,
  taille        INTEGER,
  reprise       INTEGER NOT NULL DEFAULT 0,
  recue_le      TEXT NOT NULL,
  PRIMARY KEY (candidat_id, question_id)
);

-- Recruteurs : rattachés à une entreprise, connexion par lien envoyé par e-mail (pas Cloudflare Access).
CREATE TABLE wm_recruteurs (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  entreprise_id  TEXT NOT NULL REFERENCES wm_entreprises(id),
  actif          INTEGER NOT NULL DEFAULT 1,
  cree_le        TEXT NOT NULL
);

-- Liens de connexion (15 min, usage unique) et sessions (12 h) des recruteurs. Empreintes SHA-256 seulement.
CREATE TABLE wm_jetons_recruteur (
  empreinte     TEXT PRIMARY KEY,
  recruteur_id  TEXT NOT NULL REFERENCES wm_recruteurs(id),
  sorte         TEXT NOT NULL CHECK (sorte IN ('lien', 'session')),
  expire_le     TEXT NOT NULL,
  utilise_le    TEXT,
  cree_le       TEXT NOT NULL
);

-- E-mails de Why me : envoyés par Brevo si la clé est configurée, sinon gardés ici (environnement de test) pour être
-- lus dans Parlorama. Effacés après 7 jours (ils contiennent des liens personnels).
CREATE TABLE wm_courriels (
  id        TEXT PRIMARY KEY,
  a         TEXT NOT NULL,
  sujet     TEXT NOT NULL,
  texte     TEXT NOT NULL,
  html      TEXT NOT NULL,
  sorte     TEXT NOT NULL,                         -- video_prete, reprise, connexion_recruteur
  envoye    INTEGER NOT NULL DEFAULT 0,            -- 1 : parti chez Brevo
  cree_le   TEXT NOT NULL
);
CREATE INDEX wm_courriels_date ON wm_courriels (cree_le);
