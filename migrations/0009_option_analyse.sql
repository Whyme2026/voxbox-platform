-- Parlopop — option Analyse (décision du 11/10/2026), lot 1 : transcription.
-- L'option se vend campagne par campagne. Sans elle, rien n'est envoyé hors de Cloudflare.
-- Une réponse n'est transcrite que si le visiteur a accepté des textes qui mentionnent l'analyse (pas de rétroactivité).

-- Option activée au contrat, et vocabulaire propre à la campagne (noms de modèles…) pour aider la transcription.
ALTER TABLE campagnes ADD COLUMN option_analyse INTEGER NOT NULL DEFAULT 0 CHECK (option_analyse IN (0, 1));
ALTER TABLE campagnes ADD COLUMN vocabulaire TEXT NOT NULL DEFAULT '[]';

-- La version des textes acceptée par le visiteur mentionne-t-elle la transcription et l'analyse ?
ALTER TABLE consentement_versions ADD COLUMN analyse INTEGER NOT NULL DEFAULT 0 CHECK (analyse IN (0, 1));

-- Transcription d'une réponse : le texte va dans reponses.transcription (colonne du socle), le reste ci-dessous.
-- État : NULL = non concernée ; a_faire ; en_cours ; faite ; echec (abandon après plusieurs essais).
ALTER TABLE reponses ADD COLUMN transcription_etat TEXT CHECK (transcription_etat IN ('a_faire', 'en_cours', 'faite', 'echec'));
ALTER TABLE reponses ADD COLUMN transcription_segments TEXT;          -- JSON [{ "d": s, "f": s, "t": "texte" }]
ALTER TABLE reponses ADD COLUMN transcription_langue TEXT;
ALTER TABLE reponses ADD COLUMN transcription_essais INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reponses ADD COLUMN transcription_le TEXT;                -- dernier essai ou fin
ALTER TABLE reponses ADD COLUMN transcription_erreur TEXT;
CREATE INDEX idx_reponses_transcription ON reponses(transcription_etat) WHERE transcription_etat IN ('a_faire', 'en_cours');
