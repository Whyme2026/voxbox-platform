-- Parlobox — écran « Recevoir ma vidéo » (14/10/2026).
-- Le visiteur peut laisser son e-mail, après l'accord, pour recevoir ses vidéos ; c'est aussi par cet e-mail qu'il
-- peut changer d'avis (retirer la diffusion, supprimer ses vidéos). Un e-mail part une fois ses vidéos reçues.
ALTER TABLE sessions ADD COLUMN envoi_video INTEGER NOT NULL DEFAULT 0;
-- Adresse publique de la plateforme au moment du passage (pour le lien de l'e-mail, envoyé par une tâche planifiée).
ALTER TABLE sessions ADD COLUMN envoi_video_origine TEXT;
ALTER TABLE sessions ADD COLUMN envoi_video_le TEXT;
CREATE INDEX sessions_envoi_video ON sessions (envoi_video, envoi_video_le);
-- Liens d'accès : « demande » (QR code extérieur, une heure) ou « video » (e-mail des vidéos, 30 jours).
ALTER TABLE acces_visiteur ADD COLUMN motif TEXT NOT NULL DEFAULT 'demande';
