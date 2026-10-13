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
Une preview n'utilise et n'alimente aucun de ces caches. Après une panne, une
nouvelle tentative est permise après une seconde ; une lecture réussie rafraîchit
le contenu. La fraîcheur reste soumise aux durées de validité indiquées.

`/api/serving` admet une nouvelle instance après une vraie lecture CMS réussie,
puis conserve cette admission pendant la vie du processus pour permettre les
lectures chaudes. `/api/health` reste la santé locale et l'identité de l'image.
`/api/ready` reste un contrôle sans cache des dépendances : une livraison ne
peut pas être validée grâce au seul cache chaud. Le déployeur vérifie d'abord les
images et labels OCI exacts, puis attend au plus 90 secondes la fin des anciens
processus et la révision publique attendue. Une mauvaise image échoue directement.
Les observations intermédiaires sont conservées dans le rapport privé.

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
