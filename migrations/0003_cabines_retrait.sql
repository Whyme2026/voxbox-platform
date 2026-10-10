-- Parlopop — retrait d'une cabine.
-- Une cabine jamais utilisée est supprimée ; une cabine qui a déjà recueilli des réponses est retirée :
-- tablette déconnectée, plus aucune campagne, masquée des listes, mais gardée pour l'historique des sessions.
ALTER TABLE cabines ADD COLUMN retiree_le TEXT;
