# Reprise du frontend pendant une panne du CMS

## Summary

Le frontend conserve la dernière réponse publique validée pour continuer les
lectures déjà réchauffées pendant une panne du CMS. Un processus sans copie
affiche une indisponibilité temporaire. Les retraits et fermetures confirmés
invalident les copies concernées ; les aperçus restent hors cache. La livraison
attend la convergence publique et exige toujours un CMS prêt. La qualification
Golden Journeys sur VM, puis la livraison vérifiée, restent nécessaires avant
de déclarer ce jalon livré.

## Synthèse

Les appels JSON CMS ont un délai effectif de 10 secondes, couvrant aussi le
corps HTTP. Seuls les résultats de requêtes `status=published`, structurellement
validés, entrent dans un cache local au processus : 60 secondes pour les
articles et gardes du catalogue, 300 secondes pour les chapitres et données
éditoriales du catalogue. Les données globales conservent leur durée existante.
Les commutateurs de publication sont consultés à chaque lecture ; leur dernier
état validé sert seulement lors d'une panne. Une erreur transitoire ou un JSON
invalide ne remplace jamais une publication valide. Un refus d'accès, une
absence ou une modification confirmée invalide les autres requêtes de la
collection concernée. Une fermeture confirmée reste fermée même si le CMS tombe
ensuite en panne.

Le cache JSON est limité à 256 entrées et 32 Mio de représentations sérialisées,
avec éviction des entrées les moins récemment lues. Il n'est ni partagé ni
persistant : le remplacement d'une instance commence à froid. Les octets GPX et
géométrie validés par SHA-256 disposent d'un cache distinct de 64 entrées/32 Mio ;
la garde de publication et les métadonnées sont vérifiées avant chaque accès.
Les previews restent hors cache ; les pannes sont réessayées après une seconde.

`/api/serving` admet une nouvelle instance après une vraie lecture CMS réussie,
puis conserve cette admission pendant la vie du processus pour permettre les
lectures chaudes. `/api/health` reste la santé locale et l'identité de l'image.
`/api/ready` reste un contrôle sans cache des dépendances : une livraison ne
peut pas être validée grâce au seul cache chaud. Le déployeur vérifie d'abord les
images et labels OCI exacts, puis attend au plus 90 secondes la fin des anciens
processus et la révision publique attendue. Une mauvaise image échoue directement.

La première activation livre d’abord le frontend compatible, puis remplace le
CMS en `Recreate`, sans anciens et nouveaux writers simultanés. Son interruption
attendue est chronométrée dans une fenêtre de 390 secondes maximum ; le
frontend et les erreurs hors fenêtre restent bloquants. Ensuite, 60 secondes
continues de santé sont exigées. Les activations suivantes restent progressives.

Un journal média existant interdit le rollback automatique vers un ancien CMS
sans capacité de reprise attestée, même avec zéro opération en attente. La
lecture PostgreSQL doit réussir et l'image cible doit porter le label OCI
`io.gthf.media-recovery=1` à la révision attendue. Sinon la livraison échoue en
conservant l'image actuelle et les journaux ; une intervention compatible est
nécessaire.

Ce jalon traite la reprise de l'issue #39 et la convergence de l'issue #42. Il
ne valide ni 1 000 visiteurs simultanés, ni un HPA, ni deux réplicas permanents
en production. La campagne isolée utilise deux instances pour vérifier les
copies chaudes/froides, les retraits et le retour des dépendances.

## Annexes

### Vérifications reproductibles

Avec Node 24 et les dépendances du lockfile : `npm test`, `npm run lint`,
`npm run build`, `npm run test:delivery` et `npm run test:delivery:runtime`.
Les tests ciblés de cache incluent un vrai serveur HTTP dont le corps reste
bloqué, en complément des simulations de panne, révocation et concurrence.
Les tests du déployeur simulent la convergence temporelle ; ils ne prouvent
pas à eux seuls un rollout Kubernetes réel.

La suite Golden Journeys existante reste `npm run test:e2e -- staging`, puis
`npm run test:e2e -- production` pour la vérification de production en lecture.
La campagne de reprise sur VM possède son profil, sa commande npm et ses
rapports séparés. Chaque preuve publiée dans la PR doit préciser le SHA testé,
la commande, l'environnement, les scénarios réellement exécutés et leurs limites.

### Limites de cohérence

Une instance déconnectée ne peut pas apprendre une révocation décidée sur un
CMS inaccessible. Elle conserve la dernière publication qu'elle a effectivement
validée. Dès qu'un retrait est confirmé sur cette instance, les anciennes
réponses concernées ne sont plus réutilisées, y compris par une lecture déjà
en cours. Les autres instances apprennent le changement à leur prochaine
revalidation. Aucun contenu privé ou draft n'est accepté dans le cache public.

### Activation initiale et interruption mesurée

La première activation du journal média utilise `Recreate` pour le CMS seul :
le déploiement et l’image précédents doivent correspondre à la preuve livrée,
et le manifeste/configuration OCI local doit attester l’absence du label de
reprise. Les anciens processus s’arrêtent avant le nouveau worker. Une image
précédente attestée v1 conserve `RollingUpdate` ; une preuve inaccessible ou
incohérente bloque avant mutation. Les deux chemins de livraison, image seule
et infrastructure, imposent cette stratégie avant de créer le nouveau pod.

L’observation de production ouvre alors une seule fenêtre CMS, bornée à
390 secondes autour de son remplacement. Elle conserve chaque échec et la
durée observée de chaque interruption. Une erreur frontend ou hors fenêtre
reste bloquante. Après fermeture, il faut 60 secondes continues de réponses
saines, puis les preuves Prometheus fraîches. La fenêtre ne masque ni une
coupure excessive ni l’échéance totale de dix minutes de l’observation.

Le frontend candidat est livré et qualifié avant le premier remplacement du
CMS. `/api/serving` doit confirmer son admission et la page frontend surveillée
est réchauffée avant l’ouverture de la fenêtre. Un ancien frontend dépourvu de
cette admission bloque la transition avant mutation CMS.

### Retour arrière et intentions médias

Les deux chemins de rollback (composants et infrastructure) contrôlent les
tables `gthf_media_operations` et `gthf_media_cleanup` avant toute restauration
susceptible de remplacer le CMS. Les comptes `preparing`, `prepared`,
`interrupted` et `cleanupPending` sont conservés dans la preuve privée. Une
absence de tables autorise l'ancien CMS ; des tables partielles, des états
inconnus ou une lecture DB impossible bloquent le rollback. Des tables présentes
exigent toujours un worker compatible : un compte nul ne constitue pas une
barrière empêchant un nouvel upload entre le contrôle et le changement d'image.
Les références d'image, le digest de configuration et le label de révision OCI
sont vérifiés avant d'accepter la capacité de reprise v1. Aucune table, intention
ou donnée média n'est supprimée par ce contrôle.
