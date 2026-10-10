-- Parlopop — Parlomix (montages vidéo)
-- Un Parlomix est fabriqué dans Parlorama à partir des réponses d'une campagne, puis envoyé ici.
-- La liste des sessions montées est gardée : si une personne retire son accord, ses montages ne sont plus servis.

CREATE TABLE parlomix (
  id           TEXT PRIMARY KEY,
  campagne_id  TEXT NOT NULL REFERENCES campagnes(id),
  type         TEXT NOT NULL CHECK (type IN ('personne', 'question')),
  session_id   TEXT REFERENCES sessions(id),         -- montage par personne
  etape_id     TEXT,                                 -- montage par question
  cabine_id    TEXT REFERENCES cabines(id),          -- montage par question limité à une cabine
  format       TEXT NOT NULL CHECK (format IN ('16:9', '9:16')),
  titre        TEXT NOT NULL,
  sessions     TEXT NOT NULL,                        -- JSON : identifiants des sessions montées
  nb_extraits  INTEGER NOT NULL,
  diffusable   INTEGER NOT NULL DEFAULT 0,           -- toutes les personnes montées ont accepté la diffusion publique
  plan         TEXT NOT NULL,                        -- JSON : plan de montage exécuté
  statut       TEXT NOT NULL DEFAULT 'attendu' CHECK (statut IN ('attendu', 'pret')),
  cle          TEXT,                                 -- fichier dans le stockage vidéo
  type_mime    TEXT,
  octets       INTEGER,
  duree_ms     INTEGER,
  cree_par     TEXT NOT NULL,
  cree_le      TEXT NOT NULL,
  pret_le      TEXT,
  CHECK ((type = 'personne' AND session_id IS NOT NULL) OR (type = 'question' AND etape_id IS NOT NULL))
);
CREATE INDEX idx_parlomix_campagne ON parlomix(campagne_id, cree_le);
