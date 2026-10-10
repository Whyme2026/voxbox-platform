-- Parlopop — miniatures des vidéos (une image JPEG par réponse et par Parlomix, pour les listes de Parlorama).
ALTER TABLE reponses ADD COLUMN cle_miniature TEXT;
ALTER TABLE parlomix ADD COLUMN cle_miniature TEXT;
