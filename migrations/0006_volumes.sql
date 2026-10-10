-- Parlopop — volume de stockage par campagne : taille de chaque fichier, notée à l'envoi.
-- Les fichiers déjà stockés sont mesurés après coup (lecture des métadonnées du stockage), au premier affichage.
ALTER TABLE reponses ADD COLUMN octets_source INTEGER;
ALTER TABLE reponses ADD COLUMN octets_miniature INTEGER;
ALTER TABLE parlomix ADD COLUMN octets_miniature INTEGER;
