-- Why me : clients et sous-clients, équipe RH séparée de Parlopop (12/10/2026).
-- Un client (ex. la PFA au Mondial de l'Auto) commande une campagne ; WhyMe y opère pour plusieurs entreprises
-- recruteuses (les sous-clients, fiches communes à toutes les campagnes). Le client ne voit que des statistiques
-- agrégées de ses campagnes : jamais une identité, une vidéo ni un CV (le candidat postule chez les entreprises).

CREATE TABLE wm_clients (
  id        TEXT PRIMARY KEY,
  slug      TEXT NOT NULL UNIQUE,
  nom       TEXT NOT NULL,
  cree_le   TEXT NOT NULL,
  maj_le    TEXT NOT NULL
);

ALTER TABLE wm_campagnes ADD COLUMN client_id TEXT REFERENCES wm_clients(id);
CREATE INDEX wm_campagnes_client ON wm_campagnes (client_id);

-- Contacts d'un client : connexion par lien reçu par e-mail (même espace que les recruteurs, /recruteur/).
CREATE TABLE wm_contacts_client (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  client_id  TEXT NOT NULL REFERENCES wm_clients(id),
  actif      INTEGER NOT NULL DEFAULT 1,
  cree_le    TEXT NOT NULL
);

-- Liens de connexion (15 min, usage unique) et sessions (12 h) des contacts client. Empreintes SHA-256 seulement.
CREATE TABLE wm_jetons_contact (
  empreinte   TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES wm_contacts_client(id),
  sorte       TEXT NOT NULL CHECK (sorte IN ('lien', 'session')),
  expire_le   TEXT NOT NULL,
  utilise_le  TEXT,
  cree_le     TEXT NOT NULL
);

-- Équipe WhyMe qui gère Why me (/rh/). Indépendante des comptes Parlopop (table utilisateurs) : un compte
-- Parlorama n'ouvre pas l'espace RH, et inversement. Amorçage par la variable RH_ADMIN_EMAILS.
CREATE TABLE rh_equipe (
  email     TEXT PRIMARY KEY COLLATE NOCASE,
  role      TEXT NOT NULL CHECK (role IN ('admin_rh', 'operateur_rh')),
  actif     INTEGER NOT NULL DEFAULT 1,
  cree_par  TEXT NOT NULL,
  cree_le   TEXT NOT NULL
);
