# Livraison continue GTHF sur OVH

## Summary (30 secondes)

Le déployeur courant cible les dépôts et ressources GTHF, la branche de
publication `gthf-release`, le répertoire `/home/ubuntu/gthf-delivery` et
l'unité `gthf-delivery.timer`. Le [plan de renommage](renommage-gthf.md)
porte les conditions de migration ; les résultats datés ci-dessous restent
les preuves des livraisons antérieures.

## Synthèse (3 minutes)

GitHub Actions vérifie le code et publie une image immuable ; le réconciliateur
local contrôle son origine, qualifie le staging, puis réalise la promotion.
Pour la migration de noms, suspendre ce circuit, vérifier le diff de la base
contre la version servie et qualifier les nouvelles images GTHF. Ce diff est
uniquement documentaire avant le renommage ; aucune autre fonctionnalité de
`main` n'est incluse dans cette migration.

Les namespaces cibles sont `gthf-qualification` et `gthf-staging` (production).
Les données SQL, médias, identités et secrets existants restent distincts entre
les environnements. Le proxy de staging doit utiliser les nouveaux services,
et les sondes Prometheus les nouveaux labels applicatifs.

Les Golden Journeys s'exécutent via `npm run test:e2e -- staging` (droits,
CRUD, persistance, preview, publication, médias et nettoyage) et
`npm run test:e2e -- production` (lecture publique et refus de preview anonyme).
Le rapport de PR doit identifier la révision source, les digests réellement
servis, les limites de qualification, les résultats et les artefacts privés.
Les annexes conservent les noms et chemins historiques : les commandes anciennes
ne remplacent pas le plan de migration courant.

## Annexes — historique et procédures antérieurs au renommage

Version 0.5 — 11 septembre 2026. Statut : **réconciliation locale activée ;
cycles automatiques frontend et CMS vérifiés**. Le constat initial est conservé dans son
[snapshot intégral](history/deploiement_continu_2026-09-10.md) ; les décisions nouvelles sont précisées dans
l'[ADR de livraison](adr_livraison_continue.md).
Il est la référence GTHF commune au frontend et au CMS ; les conventions de
plateforme sont portées par `infra-sincere`.

## Première livraison automatique — 11 septembre 2026

Les PR [frontend #36](https://github.com/thedamfr/gthdf-frontend/pull/36) et
[CMS #26](https://github.com/thedamfr/gthdf-cms/pull/26) sont fusionnées.
Le service `gthdf-delivery.timer` est activé sur Penthouse. Il suit le mécanisme
local déjà opérationnel du site ; aucune Application ArgoCD GTHF ni connexion
SSH/Tailscale depuis GitHub Actions n’a été ajoutée.

Le [workflow frontend](https://github.com/thedamfr/gthdf-frontend/actions/runs/34628121326)
a publié le candidat `636d7b6a6226d225141df69d57d45c6bc344f7c7`. Le service a vérifié
la provenance GitHub, les empreintes Git et le label OCI avant toute activation.
Il a ensuite qualifié le couple en staging de 17:38:00 à 17:40:01 UTC, puis en
production de 17:40:03 à 17:42:45 UTC. Les recettes ont réussi, avec 456 contrôles
origine sans erreur et au moins 60 secondes saines après le rollout. Les sondes
Prometheus étaient fraîches et saines avant et après, sans alerte pertinente.

Le [workflow CMS](https://github.com/thedamfr/gthdf-cms/actions/runs/34629330095)
a ensuite publié le candidat `02963c8bafed323658890752cc19f2c9356e7748`. Le service
a reconnu un runtime identique à celui déjà vérifié et conservé l’image CMS
existante. La recette staging a réussi de 17:48:06 à 17:48:31 UTC, puis la recette
production de 17:48:31 à 17:49:53 UTC, avec 228 contrôles origine sans erreur.
Le SHA traité CMS est donc `02963c8`, tandis que son SHA d’image reste `bd7c112`.
La première publication CMS a construit une image faute de candidat précédent ;
le calcul local a correctement évité un remplacement inutile du runtime.

| Application | Commit de l’image en production | Digest SHA-256 GHCR |
|---|---|---|
| Frontend | `636d7b6a6226d225141df69d57d45c6bc344f7c7` | `6834e843bdad48a5f9651b8928f36e55c405d62252ff6eed7234e2952bcd6882` |
| CMS | `bd7c11222ed03325fe2161d349de0b1286255e18` | `35dd2cdc3bccd4c91db281b79eab4a4efbcda5aa28b404e80c8be1e4ab8972d8` |

Les preuves privées sont conservées sous `/home/ubuntu/gthdf-delivery/` :
`history/1789148401737164606-staging.json`,
`history/1789148565768359346-production.json`,
`history/1789148565766038199-origin-samples.json` et `checks/local-delivery/`.
Elles sont distinctes des 468 contrôles de l’amorçage manuel ci-dessous.
Le cycle CMS est conservé dans `history/1789148911516098900-staging.json`,
`history/1789148993023990010-production.json` et
`history/1789148993022666900-origin-samples.json`. Les PR de clôture
[frontend #37](https://github.com/thedamfr/gthdf-frontend/pull/37) et
[CMS #27](https://github.com/thedamfr/gthdf-cms/pull/27) recevront, après fusion,
les résultats du cycle documentaire ultérieur, sans modifier ces preuves
historiques. Ce contrôle reste à exécuter lors de la rédaction de cette version.

## Historique de l’amorçage — 11 septembre 2026 à 14:36 UTC

Les PR [frontend #33](https://github.com/thedamfr/gthdf-frontend/pull/33) et
[CMS #23](https://github.com/thedamfr/gthdf-cms/pull/23) sont fusionnées.
Les workflows [frontend](https://github.com/thedamfr/gthdf-frontend/actions/runs/34608587524)
et [CMS](https://github.com/thedamfr/gthdf-cms/actions/runs/34608608471) ont réussi,
construit et publié les images GHCR. Une opération SSH autorisée a ensuite
qualifié le même couple en staging et l’a vérifié en production le 11 septembre à 14:36 UTC.

| Application | Commit de l’image | Digest SHA-256 GHCR |
|---|---|---|
| Frontend | `2f926629bc0df46fa39d2a9e3b26cb7c271e9733` | `bc5ac36cfe48188b88ad7236601a90db369a4d5949dd153755c18be9b9a76576` |
| CMS | `bd7c11222ed03325fe2161d349de0b1286255e18` | `35dd2cdc3bccd4c91db281b79eab4a4efbcda5aa28b404e80c8be1e4ab8972d8` |

Les références `staging.json` et `production.json` sont enregistrées après les
recettes réelles. La seconde tentative de promotion a passé 468 requêtes
à l’origine sans erreur, dont au moins 60 secondes après la fin du rollout.
Les sondes Prometheus sont présentes, récentes et saines ; aucune alerte GTHF
active ne subsiste. La première tentative a été annulée après des timeouts :
voir le détail de l’incident ci-dessous. L’automatisation était encore désactivée
à ce stade ; son activation ultérieure est décrite plus haut.

Sur `penthouse`, le namespace `gthdf-qualification` et son PostgreSQL sont
créés. Une copie éditoriale a été restaurée en excluant les comptes, sessions,
jetons, webhooks, paramètres privés et tâches sortantes de production. Les
références aux anciens administrateurs ont été vidées ; les tables privées
sont vérifiées vides. Les 2 720 objets média sont copiés ; les 2 209 références de fichiers et leurs
variantes pointent vers le bucket staging. Un administrateur et un jeton de
lecture dédiés sont créés ; les deux jetons d’exemple générés par Strapi ont
été supprimés. Les webhooks sont absents. Les preuves sont conservées dans
`staging-data.json` et `staging-media.json` sous le dossier privé de livraison. Les deux bases exécutent la même image PostgreSQL ; les PVC sont
physiquement distincts. Le playbook `prepare-staging.yml` a réussi puis a été
relancé sans changement. La preuve privée est conservée dans
`/home/ubuntu/gthdf-delivery/staging-foundation.json`. Les applications, les
routes et les pods de production n'ont pas été modifiés par cette préparation.
Les domaines `staging.gthf.fr` et `staging-cms.gthf.fr` servent désormais les
applications isolées derrière la passerelle : HTTPS, 401 sans authentification
et redirection HTTP vers HTTPS vérifiés. La recette administration, brouillon,
preview, publication, upload et nettoyage passe sans écriture en production.

L'archive éditoriale initiale est conservée pour le diagnostic et la reprise,
avec un mode 600 dans le dossier privé de livraison et une limite de 100 Mio.
Une préparation déjà enregistrée ne génère pas de nouvelle archive ; une
reprise sur une base non vide est refusée. Ce fichier n'est pas une sauvegarde
complète de production : les données des tables privées en sont exclues.

Le bucket staging retenu par l'utilisateur est `gthf-staging-media-bis`, région
`gra`, endpoint `https://s3.gra.io.cloud.ovh.net`. Son origine publique est `https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net`. Le bucket historique
`gthdf-staging-media` reste celui de production en région Paris 3-AZ. Il n'est
pas renommé ni migré par cette livraison. L'utilisateur S3 `gthf` doit servir
les deux buckets GTHF ; les clés ne sont donc pas une barrière d'isolation
entre ces deux environnements. Les clés Strapi, jetons et comptes restent
propres à chaque environnement.

### Commandes et accès

Depuis ce dépôt :

```bash
npm run infra:ansible:install
npm run infra:staging:prepare
npm run infra:staging:storage
npm run infra:staging:data
npm run infra:staging:media -- --extra-vars '{"gthdf_cms_checkout":"/chemin/gthdf-cms"}'
npm run test:delivery
npm run infra:credentials:upload -- /chemin/prive/identifiants-gthf.txt
```

La dernière commande transmet le fichier par SSH stdin vers
`penthouse:/home/ubuntu/gthdf-delivery/credentials/ovh-gthf.txt` (dossier 700,
fichier 600). Le fichier reste hors Git et hors des journaux. La commande
remplace atomiquement ce fichier, conserve la source locale et ne modifie
aucun Secret Kubernetes. L'installation staging a réussi. Le contrôle réel création/lecture publique/
suppression d'un objet temporaire dans le nouveau bucket a réussi. Le contrôle
`HeadBucket` de production avec ces clés réussit après correction des droits
le 11 septembre. Ce contrôle n'écrit pas dans le bucket de production ; ses
nouvelles clés sont installées en production lors de la promotion vérifiée.

GitHub Actions utilise uniquement son `GITHUB_TOKEN` pour GHCR (`packages: write`)
et pour publier `candidate.json` dans `gthdf-release` (`contents: write`). La branche
n’est mise à jour que par un push en avance rapide après contrôle du `main` courant.
La publication précède la fin du workflow ; elle ne devient éligible qu’après sa
réussite complète, contrôlée côté serveur. Un statut CI vert atteste donc la
publication, pas une production déjà vérifiée.

`gthdf-delivery.timer` lance le réconciliateur local après chaque période d’inactivité
de 60 secondes. Chaque invocation traite au plus un composant ; un curseur alterne
frontend et CMS, y compris après un échec. La limite de durée couvre ainsi une seule
livraison, et son délai restant tient compte des contrôles déjà exécutés.
Il lit les deux dépôts publics sans identifiant GitHub, vérifie le
run, son origine `main`, sa tentative, les sources Git et le déployeur exact validé.
Avant tout démarrage en staging, le déployeur lit la configuration OCI du digest
avec `docker buildx imagetools inspect` et contrôle son label de révision. Le client
Docker sert uniquement à lire le registre ; aucune image n’est construite sur l’hôte.
Le secret GHCR existant passe par un fichier temporaire privé, supprimé ensuite,
sans valeur dans les arguments ou journaux. Le contrôle `--check` inclut cette preuve.
Le cluster conserve le Secret `gthdf-ghcr` de lecture du registre. Aucun secret
Tailscale ou SSH de runner n’est requis. Le service utilise le compte opérateur
`ubuntu` existant ; il ne crée ni compte ni clé. Ses opérations privilégiées restent
celles du déployeur GTHF déjà autorisé, et non un runner généraliste.

Le compte existant possède des droits Kubernetes étendus : l’isolation repose ici
sur le déployeur, ses destinations fixes et la confiance dans les branches `main`
validées. Le service n’offre pas une nouvelle frontière RBAC de namespace. Le runbook
commun `infra-sincere` décrit encore l’audit initial ; le mécanisme actif du site et
la PR ArgoCD Studio ont été inspectés séparément avant ce choix.

Les accès de recette vérifiés sont les domaines HTTPS authentifiés
[frontend staging](https://staging.gthf.fr/) et [CMS staging](https://staging-cms.gthf.fr/).
Ils sont isolés ; aucune URL Tailscale Serve GTHF n’est configurée. Les accès
privés de recette restent dans `/home/ubuntu/gthdf-delivery/staging-access.json`
sur le serveur, hors Git et hors des journaux.

Le déployeur s'exécute par `npm run infra:delivery -- ...` dans un checkout
installé sur le serveur attendu. `status` lit les références vérifiées ;
`reserve --owner <identifiant> --minutes 60` réserve le staging (maximum 240
minutes) et `release --owner <identifiant>` le libère. `deliver --candidate
<manifest.json>` qualifie puis promeut un candidat de `main` et exige deux
références initiales complètes. L'absence d'état initial provoque un échec,
jamais une activation présumée correcte.

### Installation, activation et diagnostic du service local

Depuis un checkout frontend relu :

```bash
npm run infra:delivery:install
```

Le playbook installe les fichiers et recharge systemd, sans démarrer la livraison.
Il conserve les identifiants, les images en ligne et les états déjà vérifiés.
Une évolution du programme de réconciliation installé exige de rejouer ce playbook
après revue, en suspendant les nouveaux cycles. Le service télécharge les révisions
validées du déployeur applicatif ; il ne remplace pas lui-même son propre exécuteur.
Sur Penthouse, `node /home/ubuntu/gthdf-delivery/agent/infrastructure/delivery/reconcile.mjs --check`
contrôle les candidats sans activer de workload. Cette commande directe correspond
au script npm `infra:delivery:pull -- --check` dans un checkout complet ; l’agent
installé ne contient que ses fichiers nécessaires, sans application Node à installer.

Après qualification, créer le marqueur privé `gthdf-delivery/pull-enabled`, puis
activer `gthdf-delivery.timer` avec systemd. Supprimer ce marqueur et arrêter le timer
suspend les prochains cycles ; laisser toute livraison en cours terminer son
contrôle ou son retour arrière avant d’arrêter le service.

`systemctl status gthdf-delivery.timer` et `journalctl -u gthdf-delivery.service`
donnent le statut de l’exécuteur, sans valeurs de secrets. Les résultats par dépôt
sont dans `/home/ubuntu/gthdf-delivery/pull/`, avec un délai de cinq minutes avant
reprise d’une erreur, d’une CI en attente ou d’un candidat dépassé. Cette temporisation
limite les appels à l’API GitHub publique. Une ancienne preuve CI expirée impose une
nouvelle construction au prochain push, sans bloquer définitivement le publieur.
Une réservation staging reporte le cycle. Les références
`staging.json` et `production.json` n’avancent qu’après recette. Les observations
origine et l’historique privé conservent les échecs et retours arrière.

Le superviseur demande un arrêt gracieux après cinquante minutes. Il transmet
`SIGTERM` au déployeur, qui passe dans le retour arrière et ignore les interruptions
suivantes pendant cette récupération. Il attend la fin du processus. Le service
systemd conserve une limite de démarrage de cinquante-cinq minutes et une fenêtre
de trente minutes pour l’arrêt ; `flock --no-fork` permet d’adresser le superviseur
directement. Une récupération qui dépasse aussi cette limite exige une intervention.

La comparaison locale porte sur la production vérifiée, même si le candidat GitHub
n’a pas reconstruit son image. Les publications obsolètes, runs rouges, empreintes
incohérentes, archives dangereuses et évolutions PostgreSQL sont refusés. Une image
équivalente déjà en production est conservée. Les secrets, volumes et données de
staging ne sont jamais promus. La production reçoit les mêmes digests qualifiés.

L’installation initiale du service et du timer est passée sur Penthouse, avec sept
tâches Ansible réussies, sans redémarrer d’application. Les unités sont valides.
Avant activation, deux cycles sans candidat ont confirmé l’alternance frontend/CMS.
Le contrôle OCI a aussi réussi sous le compte systemd `ubuntu`, avec un socket
Docker volontairement inexistant : `imagetools inspect` lit le registre sans
daemon. Les fichiers temporaires d’authentification ont été supprimés. Un arrêt
systemd a vérifié la transmission de SIGTERM et l’attente de la récupération sur
un processus de test, sans toucher aux applications. Ces preuves se trouvent dans
`checks/6381631/` et `checks/43afb4c/` du dossier privé de livraison.

Le marqueur privé et le timer sont maintenant actifs. Les vérifications réelles
de publication, qualification et promotion sont consignées en tête de ce runbook.
La mise à jour documentaire de clôture sert aussi à contrôler la réutilisation des
images et l’absence de redémarrage ; son résultat sera consigné dans les PR de clôture.
Les builds de qualité CI restent exécutés : ce contrôle porte sur l’absence de
nouvelle construction d’image Docker et sur les pods effectivement conservés.

### Bascule initiale des routes de staging

Cette opération d’amorçage est réalisée. Les étapes ci-dessous décrivent sa
procédure ; ne pas les rejouer sur les environnements déjà qualifiés.
La livraison courante refuse toute règle Ingress des deux domaines staging
qui viserait un autre namespace ou un service autre que la passerelle.
Elle ne supprime pas implicitement les alias historiques de production.
Les règles wildcard, sans host ou avec backend par défaut susceptibles de
contourner cette passerelle sont également refusées. Avant toute écriture de
recette, la base, les URLs privées/publiques et le stockage doivent correspondre
exactement à la configuration de qualification. La reprise de préparation
revérifie les neuf secrets applicatifs face à la production, même lorsqu'un
checkpoint existe ; le compte S3 GTHF partagé reste l'exception autorisée.
La configuration initiale ne reprend que les paramètres applicatifs communs
explicitement autorisés ; ses endpoints et sa base sont définis pour staging.
La comparaison des volumes précède toute application de ressource ou attente
de démarrage, y compris lors d'une reprise.
Une erreur de lecture Kubernetes interrompt la préparation ; seule une absence
confirmée permet la génération initiale des secrets. L'overlay de qualification
remplace l'autorisation réseau héritée de l'ingress public par une autorisation
depuis les pods de la passerelle du même namespace. Les flux internes
frontend vers CMS restent autorisés.
La préparation prend le même verrou `staging.lock` que la livraison avant
de lire son checkpoint ou ses ressources. Une autre opération active provoque
un refus immédiat, avant toute génération de secret ou application de ressource.

1. Vérifier l'hôte, le contexte, les digests et les rollouts des trois Deployments
   `gthdf-cms`, `gthdf-frontend` et `gthdf-staging-gateway` dans
   `gthdf-qualification`, puis leurs sondes internes. Attendre le certificat
   `gthdf-qualification-tls` prêt. À cette étape, n'exposer encore aucune route
   applicative de qualification sur les domaines historiques.
2. Inventorier les Ingress de tous les namespaces pour les hosts
   `staging.gthf.fr` et `staging-cms.gthf.fr`, ainsi que les IngressRoute
   Traefik (HTTP/TCP/UDP) et les HTTPRoute/GRPCRoute Gateway API. Le contrôle
   exige les deux hosts derrière la passerelle et refuse les routes alternatives
   qui pourraient les atteindre ; un host littéral étranger tel que
   `dashboard.localhost` est accepté. Sauvegarder les deux objets
   historiques `gthdf-staging/gthdf-frontend` et `gthdf-staging/gthdf-cms` dans
   le dossier privé de livraison. Refuser la bascule si leurs noms, hosts ou
   services ne correspondent plus à cet inventaire.
3. Retirer ces deux seuls Ingress historiques, puis appliquer
   `infrastructure/kubernetes/overlays/qualification/ingress.yaml` avec le
   namespace explicite `gthdf-qualification`. Les Ingress
   `gthdf-production-frontend` et `gthdf-production-cms` continuent de servir
   les domaines de production ; seule la recette peut connaître une brève
   indisponibilité pendant la bascule de ses alias.
4. Vérifier l'absence de règle concurrente, TLS, le refus 401 sans accès de
   recette, les SHA derrière la passerelle, puis la recette CRUD complète.
   En cas d'échec, retirer les deux Ingress créés dans `gthdf-qualification`
   et restaurer les spécifications sauvegardées dans `gthdf-staging`. Les
   domaines redeviennent alors des alias de production : interdire les tests
   d'écriture jusqu'à une nouvelle qualification.

Enregistrer la référence initiale staging seulement après cette bascule
vérifiée. Une référence créée artificiellement pour contourner le bootstrap
ne valide ni les routes, ni les versions, ni l'isolation.

## Fonctionnement du déployeur

Le [plan initial](history/deploiement_continu_2026-09-10.md) conserve les critères
d'acceptation complets. L'implémentation locale sépare les responsabilités :

| Fichier | Responsabilité |
|---|---|
| `.github/workflows/delivery.yml` dans chaque dépôt | Qualité, publication du candidat, résultat stable `delivery-result` et conservation des preuves |
| `infrastructure/delivery/plan.mjs` | Empreintes Git comparées à la dernière production vérifiée, reprise des changements après un échec |
| `infrastructure/delivery/ci.mjs` | Checkout exact, réutilisation ou build GHCR et publication du candidat public |
| `infrastructure/delivery/reconcile.mjs` | Lecture locale des candidats publics, contrôle de provenance, sélection depuis la production et déclenchement sous verrou |
| `infrastructure/ansible/playbooks/delivery.yml` | Installation d'une révision exacte du déployeur dans un dossier privé par candidat |
| `infrastructure/delivery/release.py` | Verrous communs, compatibilité CMS, rollouts séquentiels, preuve des digests et du SHA servi, rollback et journal de releases |
| `infrastructure/delivery/recipe.mjs` | Recette CRUD/média uniquement en staging ; lecture des parcours publics en production |
| `infrastructure/delivery/staging-gateway.mjs` | Authentification du staging par cookie signé, relais sur deux origines internes fixes |
| `infrastructure/kubernetes/overlays/qualification/` | Manifests du staging isolé |
| `infrastructure/kubernetes/overlays/production/` | Manifests de la production dans son namespace historique |

Le workflow compare les entrées runtime, infrastructure et PostgreSQL. Les
Markdown narratifs sous `infrastructure/`, y compris les guides PostgreSQL,
sont classés comme validation : ils ne déclenchent pas de réconciliation. Les
Markdown narratifs, tests et workflows ne provoquent pas une nouvelle image
lorsque les entrées runtime sont identiques. Les CSV, scripts de migration et
chemins inconnus sont conservés dans le calcul runtime. Une évolution de
l'image PostgreSQL est refusée par la livraison automatique et exige un plan
séparé. Les validations de qualité s'exécutent même sans nouvelle image.
Un tag SHA existant n'est réutilisé qu'après lecture de sa configuration OCI
par digest et comparaison de `org.opencontainers.image.revision` au commit
attendu ; une révision absente ou différente bloque la livraison.

La réservation staging et les verrous d'activation s'appliquent côté serveur
aux deux dépôts. Avant chaque activation, le candidat doit toujours correspondre
au `main` courant de son dépôt. Le manifeste distingue `processedRevision`
(commit traité), `revision` (source de l'image), `image` (digest GHCR),
`fingerprints` et `deployerRevision`. Un push documentaire conserve le SHA de
l'image précédente. Les états `staging.json` et `production.json` avancent
uniquement après réussite de leur recette ; l'historique contient aussi les
échecs et retours arrière.

## Configuration portable et sondes

Le frontend reçoit `STRAPI_URL` pour les appels internes, `PUBLIC_STRAPI_URL`
pour les liens destinés au navigateur et `SITE_URL` pour ses URLs publiques.
Les anciennes variables `NEXT_PUBLIC_STRAPI_URL` et `NEXT_PUBLIC_SITE_URL`
restent un fallback serveur. Les pages lisent le CMS au runtime ; les données
ne sont pas intégrées à l'image par `generateStaticParams`. Les règles de
revalidation des fetchs existants restent en place. La liste des origines
acceptées par l'optimiseur Next reste une configuration de build explicite.
Les routes paramétrées ne déclarent pas de `generateStaticParams` vide : ce
mode de génération différée est incompatible avec le layout qui attend une
requête réelle ([contrainte Next.js](https://nextjs.org/docs/messages/app-static-to-dynamic-error)).
Après le build, `npm run test:delivery:runtime` lance le serveur standalone
avec un CMS local de test et exige une page chapitre 200 dès la première requête.
Le contrôle a reproduit le 500 initial puis validé la correction ; il fait
partie de la CI.

`/api/health` donne la version frontend et interdit le cache ; `/api/ready`
exige un jeton et un contenu global publié accessible dans Strapi. Le CMS
répond sur `/api/release` avec son SHA et vérifie une requête PostgreSQL avant
de renvoyer 200. Les échecs de dépendances produisent 503.

## Sauvegarde et retour arrière

Une modification d'image CMS en production commence par `pg_dump -Fc` et la
lecture de son index avec `pg_restore --list`. Le fichier privé est conservé
sur l'hôte ; la vérification de l'index n'est pas une preuve de restauration.
Le schéma automatique accepte les ajouts optionnels compatibles ; les
suppressions, changements de type et contraintes nouvelles sont refusés.
Cette restriction couvre aussi les attributs d'un nouveau schéma.
`DATABASE_FORCE_MIGRATION=false` conserve les tables et colonnes lors d'un
retour à un ancien CMS.

Le CMS sérialise `db.schema.sync()` par un verrou transactionnel PostgreSQL
commun à ses instances. Les anciens pods continuent à servir durant le
démarrage du nouveau ; le pool conserve au moins trois connexions, dont une
pour le verrou. La première activation garde le schéma courant, car l'image
historique ne possède pas ce verrou. Les démarrages concurrents ont réussi en staging. La promotion initiale
a nécessité le retrait explicite du trafic décrit ci-dessous ; les instances
actuelles disposent du délai de drainage prévu pour les rollouts suivants.

L'API interne `http://gthdf-cms:1337` est autorisée explicitement par les
NetworkPolicy : sortie des pods frontend et entrée des pods CMS du même
namespace, uniquement sur TCP 1337. Les URLs publiques restent distinctes.

Une recette échouée restaure les spécifications précédentes des ressources
concernées et revérifie les versions en service. Les namespaces, volumes et
StatefulSets ne sont pas réconciliés par une livraison applicative. Le retour
arrière ne réimporte pas une ancienne base et ne supprime pas les médias.
La première activation des tags historiques vers des digests vérifiés demande
une procédure de bootstrap spécifique ; le déployeur courant la refuse tant
que les références initiales manquent.

## Résultats locaux et incidents de préparation

Les suites complètes locales ont été exécutées sur Node 24 : tests frontend,
composants, tests CMS, lint frontend et builds Next/Strapi réussis. Les tests
ciblés couvrent aussi l’ordre qualification/promotion et le déclenchement du retour arrière,
les empreintes de build, le cookie de staging, le cache privé et les garde-fous
de peuplement. La syntaxe Python/YAML/Ansible, les liens locaux et
`git diff --check` sont contrôlés. Les CI, images GHCR et recettes sont désormais
vérifiées. Les derniers résultats sont : 185 tests unitaires frontend, 51 tests
de composants, 23 tests Python et 259 tests CMS, avec les builds Next/Strapi.

La première restauration partielle par stdin a laissé `kubectl` attendre après
la création du schéma vide. Le transfert a été arrêté, toutes les tables ont
été vérifiées vides, puis l'archive a été copiée dans un fichier avant la
restauration. `infra:staging:data` refuse de remplacer une base contenant des
lignes ; `gthdf_resume_empty_schema=true` autorise seulement la reprise d'un
schéma vide, après vérification. La copie utilise un fichier privé et une
limite temporaire de 100 Mio ; les archives de taille supérieure exigent un
espace de travail adapté.

Le premier chargement du script de peuplement a demandé l'entrée CommonJS de
Strapi. Le transfert média séquentiel a ensuite atteint la limite de 20 minutes.
La reprise utilise les checksums déposés avec les objets déjà copiés, quatre
workers et un compteur de progression ; elle a terminé les 29 objets restants.
La réécriture des URLs exclut les vues PostGIS. Ces opérations sont consignées
dans `/home/ubuntu/ops-journal.md`. La production a été vérifiée en HTTP 200/204,
avec les mêmes pods et compteurs de redémarrage qu'avant la préparation.

Les contrôles HTTP du déployeur utilisent le User-Agent `gthdf-delivery`. Un
contrôle avec le User-Agent Python par défaut a reçu 403 de Cloudflare alors
que les mêmes endpoints répondaient correctement avec le client du déployeur
et depuis le Mac.


### Incident de la première promotion et reprise

La première tentative du 11 septembre, de 14:22 à 14:24 UTC, a été annulée :
la preuve publique du frontend a expiré après 30 secondes ; la sonde directe
CMS a également enregistré un timeout de deux secondes parmi 210 requêtes.
Les images historiques et leur recette en lecture seule ont été restaurées.
Aucune base ni donnée média n’a été restaurée ou supprimée. Cette tentative
ne permet pas d’annoncer une absence d’interruption.

Les anciennes instances ne disposaient pas du délai `preStop` du nouveau
manifeste. La reprise rend le retrait du trafic explicite : instance temporaire
prête, sélection exclusive par le Service et contrôle des EndpointSlices,
attente de 15 secondes, remplacement de l’ancienne instance, puis seconde
attente avant nettoyage. La procédure a passé 182 contrôles en staging et sa
recette complète avant la seconde promotion. Les Services retrouvent ensuite
leurs sélecteurs habituels ; aucun Deployment temporaire n’est conservé.

La seconde tentative utilise les mêmes digests qualifiés, une nouvelle sauvegarde
PostgreSQL et les schémas CMS identiques (37 fichiers). Les données, PVC,
StatefulSets, Ingress et certificats de production restent conservés. Le quota
applicatif passe à 8 CPU/8 Gio de limites pour permettre le remplacement ; il
ne réserve pas cette capacité en permanence. Les clés S3 sont remplacées par
l’identité GTHF autorisée. Le retour arrière ne restaure jamais la base automatiquement.

Les preuves privées `bootstrap/production-promotion-proof.json` (échec),
`bootstrap/production-promotion-proof-2.json` (reprise), leurs échantillons
`production-origin-samples*.json`, snapshots et sauvegardes sont conservés.
Les scripts ponctuels `operator-tools/bootstrap-production.py` et
`operator-tools/traffic-cutover.py` sont consignés sur le serveur avec le journal
`/home/ubuntu/ops-journal.md` ; la livraison courante reste le déployeur versionné.
