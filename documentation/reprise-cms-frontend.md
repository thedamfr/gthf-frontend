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

Les appels JSON CMS ont un délai effectif de 10 secondes, corps HTTP compris.
Seuls les résultats `status=published` validés entrent dans le cache du processus :
60 secondes pour articles et gardes du catalogue, 300 pour chapitres et données
éditoriales du catalogue. Les données globales gardent leur durée existante.
Les commutateurs de publication sont consultés à chaque lecture ; leur dernier
état validé sert pendant une panne. Une erreur transitoire ou un JSON invalide
ne remplace pas une publication valide. Un refus d’accès, retrait ou changement
confirmé invalide les copies concernées. Une fermeture confirmée reste fermée
si le CMS devient ensuite inaccessible. Les previews restent hors cache.

Le cache JSON contient au plus 256 entrées et 32 Mio, avec éviction des moins
récemment lues. Non partagé et non persistant, il disparaît au remplacement du
processus. Les octets GPX/géométrie vérifiés par SHA-256 disposent de 64 entrées
et 32 Mio supplémentaires ; garde de publication et métadonnées précèdent chaque
accès. Les erreurs sont réessayées après une seconde.

`/api/serving` admet une instance après une lecture CMS réussie, puis garde cette
admission pour ses lectures chaudes. `/api/health` vérifie le processus et son
identité ; `/api/ready` contrôle toujours les dépendances sans cache. La livraison
exige les images/labels OCI exacts, puis la convergence publique sous 90 secondes.
Une mauvaise image échoue directement.

La première activation livre le frontend compatible, puis remplace le CMS en
`Recreate`, sans anciens et nouveaux writers simultanés. Sa fenêtre d’interruption
CMS est bornée à 390 secondes ; les erreurs frontend ou hors fenêtre bloquent.
Ensuite, 60 secondes continues de santé sont exigées. Seules les transitions
entre images v2 compatibles avec les lots durables restent progressives.

Après une activation possible du nouveau CMS, tout rollback exige les labels OCI
`io.gthf.media-recovery=2` et `io.gthf.media-batch-recovery=1` à la révision attendue,
même si les tables semblent encore absentes ou vides. PostgreSQL doit répondre.
Sinon la livraison échoue en conservant l’image et les journaux ; il faut réparer
avec une version compatible, sans rétablir automatiquement l’ancien worker.

Les versions remplacées restent lisibles tant que le média logique existe : une
partition peut prolonger le cache au-delà des TTL. La suppression explicite
et autorisée nettoie toutes ses versions. Le stockage augmente avec les
remplacements ; remplacer seul ne révoque pas les anciennes URL.

Ce jalon couvre la reprise de #39 et la convergence de #42. Il ne qualifie ni
1 000 visiteurs simultanés, ni HPA, ni deux réplicas permanents en production.
Deux instances VM vérifient copies chaudes/froides, retraits et reprise.

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
et le manifeste/configuration OCI local doit attester une image sans capacité
de reprise ou v1. Les anciens processus s’arrêtent avant le nouveau worker : v1
ignore la rétention des historiques. Seule une image v2 avec capacité lots v1
conserve `RollingUpdate` ; une preuve inaccessible ou
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
tables `gthf_media_operations`, `gthf_media_cleanup` et `gthf_media_batches`
avant toute restauration
susceptible de remplacer le CMS. Les comptes `preparing`, `prepared`,
`interrupted` et `cleanupPending` sont conservés dans la preuve privée. Une
absence de tables ne permet pas de rétablir l'ancien CMS : le candidat peut
terminer son initialisation entre la lecture et le changement d'image. Des
tables partielles, des états inconnus ou une lecture DB impossible bloquent aussi
le rollback. Tous ces retours arrière exigent un worker média v2 et lots v1,
sans exception selon le nombre d'opérations observées.
Les références d'image, le digest de configuration et le label de révision OCI
sont vérifiés avant d'accepter les capacités de reprise v2 et de lots v1.
Les lots `pending`, `committed` et `failed` sont comptés séparément ; un état
inconnu bloque. Le refus conserve dans la preuve privée l'action attendue
`repair-forward-with-compatible-worker`. Les tests modélisent une initialisation
concurrente des tables après leur lecture et refusent toute application de
l'ancien CMS. Aucune table, intention ou donnée média n'est supprimée par ce contrôle.

### Médias remplacés et partition réseau

Un TTL de revalidation n’est pas un âge maximal du fallback. Un ancien délai de
nettoyage de dix minutes pouvait donc casser une publication encore servie ; les
données globales peuvent aussi rester fraîches une heure. Le CMS v2 ancre chaque
intention de nettoyage d’une ancienne version à `retain_file_id`. Tant que le
fichier logique existe, le worker ne la réclame pas et ne fait aucun HEAD pour
elle. Le commit SQL d’une suppression explicitement autorisée rend les anciennes
versions et la version courante nettoyables. Les droits et conflits de version
restent contrôlés ; un échec de suppression ne libère pas les historiques.

Les anciennes URL publiques restent donc lisibles après remplacement, jusqu’à
cette suppression ; aucune purge automatique basée uniquement sur l’âge n’est
promise. Le stockage augmente avec les remplacements. Le cache JSON garde ses
limites mémoire et sa révocation dès confirmation du retrait. Une suppression
explicite peut casser les anciennes références : elle demeure prioritaire sur
leur disponibilité. Cela ne crée pas une invalidation globale des caches des
navigateurs ou du cache d’optimisation d’images Next.

Le Golden Journey VM conserve A puis B, publie et réchauffe B, coupe uniquement
les accès des frontends au CMS puis remplace B par C. Pendant 601 secondes réelles,
le CMS et son worker restent actifs, MinIO reste accessible depuis le frontend,
et A/B gardent leurs octets. La dernière publication doit encore afficher B. Une
suppression de C doit ensuite nettoyer A/B/C, préserver un média indépendant et
rejouer le même reçu. La NetworkPolicy est retirée dans `finally`, y compris en
cas d’échec ; ces mutations restent limitées à la VM identifiée.
