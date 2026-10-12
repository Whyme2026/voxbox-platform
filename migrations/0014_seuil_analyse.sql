-- Option Analyse : seuil d'ouverture des vues agrégées réglable par campagne (12/10/2026).
-- 100 visiteurs par défaut (décision du 11/10/2026). Une petite campagne (ex. 40 jeunes au Mondial de l'Auto)
-- peut ouvrir ses vues plus tôt ; les pourcentages restent masqués sous 30 propos, et jamais moins de 20 visiteurs :
-- en dessous, une répartition ne veut rien dire et isolerait trop facilement une personne.
ALTER TABLE campagnes ADD COLUMN seuil_analyse INTEGER NOT NULL DEFAULT 100 CHECK (seuil_analyse BETWEEN 20 AND 1000);
