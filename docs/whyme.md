# Why me (JobBox smartphone, usages RH)

Interview vidéo du candidat **sur son propre téléphone**, dans la JobBox (QR code de la campagne) ou en digital pur
(même lien). Produit distinct de Parlopop sur la même plateforme : même Worker, même base, même stockage, même
journal ; tables `wm_*`, routes `/api/whyme`, `/api/recruteur`, `/api/montage`, `/api/admin/whyme`.
Note de cadrage : projet « vox-boxes », `claude/whyme-jobbox-note-cadrage.md` (version 4, validée le 11/10/2026).

## Règles (non négociables)
- **Aucune IA, aucune note** : ni transcription, ni résumé, ni score. Le signal humain et la spontanéité d'abord.
- Rushes (prises par question) **effacés dès que le montage est prêt** ; le recruteur ne voit que le montage.
- Recruteurs : candidatures de **leur entreprise** seulement, **12 mois**, chaque lecture et téléchargement journalisés.
- Page publique : seulement avec l'accord du candidat, **24 mois** ; le candidat ne télécharge pas sa vidéo.
- Le candidat **supprime sa vidéo** depuis l'e-mail : elle disparaît partout (page publique et recruteurs) ;
  ou toutes ses données. Interview jamais terminée : effacée après 30 jours.
- Âge affiché sur la vidéo par défaut (`ageAffiche`, désactivable par campagne), annoncé au candidat avant ;
  âge minimum par campagne (15 ans par défaut).
- Tout est en **9:16** (720 × 1280). Aucun traceur tiers dans le parcours.

## Parcours candidat (`/i/<code>` → `public/whyme/candidat/`, `public/whyme/js/candidat.js`)
Accueil → CV facultatif (PDF ou Word, 5 Mo) → prénom, nom, e-mail (message de vigilance), âge → famille de postes
→ entreprises (une, plusieurs, « tout sélectionner ») → accords (candidature obligatoire, page publique facultative,
textes versionnés par empreinte) → téléphone posé (caméra, micro, écran maintenu allumé) → cadrage (lumière, son,
visage si le navigateur sait le détecter ; jamais bloquant au-delà de 25 s) → question d'essai (jamais envoyée) →
questions : lecture, enregistrement, puis « On garde » / « Je veux la revoir » (gardée seule au bout de
`validationAutoSec`), après revisionnage « Je garde » / « Je refais » (une reprise par question) → envoi → fin
(« ta vidéo arrive par e-mail », aucun montage montré).
- Enregistrement (`capture.js`) : WebM (VP9/VP8 + Opus) en priorité, MP4 seulement si le WebM n'existe pas (iPhone).
- File d'envoi (`envoi.js`) : IndexedDB, reprise après coupure ou rechargement. Jeton dans l'en-tête `x-jeton`.
- Reprise : même téléphone (stockage local) ou lien de l'e-mail `#reprise=<id>.<jeton>` (envoyé après 15 min
  d'inactivité ; le lien porte un nouveau jeton).

## Montage (`src/whyme/montage.ts` + service `montage/`)
Interview terminée → la plateforme appelle `POST /monter` du service (liaison interne `MONTAGE_SERVICE`, ou `MONTAGE_URL` hors Cloudflare) → le service lit le plan
(`/api/montage/travaux/:id`) et les prises, monte avec ffmpeg (ouverture why me + prénom, pour chaque question un
carton fuchsia puis la réponse sans ses blancs, logo et « prénom, âge » à l'image, fermeture), renvoie miniature puis
film → finalisation : rushes effacés, candidatures transmises, e-mail. Secret partagé `MONTAGE_CLE`, qui ne circule
jamais : chaque requête est signée (HMAC horodaté, 5 min, en-tête `x-montage-signature`, `montage/signature.ts`),
car les journaux Cloudflare enregistrent les en-têtes ; le service n'appelle que les plateformes listées dans `MONTAGE_API_AUTORISEES`.
Conteneur : `montage/Dockerfile`, Worker `montage/worker.ts`, `montage/wrangler.jsonc` (juridiction UE).

## E-mails (`src/whyme/courriels.ts`)
Vidéo prête (entreprises nommées, bouton « Voir ma vidéo », sticker QR code PNG, « Tu gardes la main »), reprise,
connexion recruteur. Tous gardés 7 jours dans `wm_courriels` ; envoyés par Brevo si `BREVO_CLE` est configuré.

## Espace recruteur (`/recruteur/`)
Lien de connexion par e-mail (15 min, usage unique, 3 demandes par heure), session de 12 h. Liste, filtres
(événement, métier, nom), lecture et téléchargement de la vidéo, CV. Comptes créés par WhyMe (Parlorama > Why me).

## Parlorama · Why me (`/admin/whyme.html`, comptes WhyMe)
Campagnes (configuration JSON, modèle `fixtures/whyme-campagne-demo.json`, QR code, ouverture/clôture, suivi des
interviews, relance du montage), entreprises et logos, recruteurs, e-mails de test.

## Tâches planifiées (cron, toutes les 5 minutes, `src/whyme/taches.ts`)
Relance des montages (3 essais), e-mails de reprise, purges (30 jours, 12 et 24 mois), CV effacé à la fin de l'accès
des recruteurs, e-mails et jetons échus.

## Vérifier
```
npm run check
npm run e2e:whyme -- <voix.wav> <camera.y4m> <dossier-captures>   # téléphone simulé + vrai montage ffmpeg
```
La voix de test doit ressembler à de la parole (syllabes) : un son continu est atténué par la réduction de bruit du
navigateur et passe pour du silence.
