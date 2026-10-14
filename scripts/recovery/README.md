# Résilience GTHF sur le banc infra-sincere

## Summary

Ce profil appartient à GTHF ; le cycle de vie de la VM appartient à
`infra-sincere`. La campagne qualifie les médias CMS, les publications et les
lectures publiques frontend par quatorze Golden Journeys, avec de vrais arrêts de processus et trois coupures
QEMU. Les preuves portent les révisions et digests candidats. Le banc refuse une
cible inconnue, une réservation étrangère et les paramètres de production.
Une phase séparée qualifie aussi la convergence de livraison entre deux vraies
images frontend. Le profil reste en cours de qualification : sa présence ne vaut
pas succès E2E.

## Synthèse

Le manifeste privé désigne le consommateur `gthf`, une campagne, l’UUID de la VM,
les trois révisions source et quatre images immuables. `infra.lock.json` épingle
le contrôleur commun, dont le checkout doit être propre. Les opérations passent
par celui-ci : identité, réservation, disques, processus et réseau sont vérifiés.
Les accès applicatifs utilisent exclusivement des tunnels SSH sur loopback.

La VM possède PostgreSQL/PostGIS/pgvector, un vrai MinIO, le CMS candidat et deux
instances frontend. Les identifiants sont générés par campagne ; aucun dump ou
secret de production n’est copié. Le stockage SQL et S3 reste durable entre les
coupures. Les répertoires temporaires applicatifs sont en mémoire et disparaissent
au reboot. L’installation refuse un état préexistant au lieu de l’écraser.

Les Golden Journeys contrôlent les acquittements, les droits et les reçus, les
uploads incomplets, les objets reçus avant commit, une réponse perdue après
remplacement, la suppression, les dépendances tardives et un deuxième crash
pendant la reprise. Ils couvrent aussi publication interrompue, cache public
chaud/froid, processus mort/bloqué, preview et révocation confirmée. La reprise
métier doit se terminer en 300 secondes après retour des dépendances.
Un SIGKILL après réception des objets et révocation des droits vérifie que la
reprise autonome refuse le commit et nettoie ces objets, sans créer de média.
Une image avec plusieurs formats vérifie le nettoyage d’un transfert partiel.
Une suppression mixte de médias et dossiers imbriqués est interrompue après
le premier enfant : le reçu partiel reste exact, la reprise termine le même lot,
le réessai ne duplique rien et les autres médias restent intacts.
Un import URL est interrompu par SIGKILL après réception de ses objets et avant
commit. Sa reprise produit un seul fichier et un reçu propriétaire ; le replay
SSE fonctionne après retrait de la source HTTP, sans refetch. Une URL changée
est refusée avec la même clé.
Une partition réseau frontends→CMS dure réellement 601 secondes après le
remplacement B→C, avec le même CMS, son worker et MinIO actifs. Les anciennes
versions A/B, les publications, villes et octets GPX/géométrie doivent rester
disponibles. La suppression explicite du média C nettoie A/B/C et préserve un
média indépendant. La NetworkPolicy VM autorise DNS/MinIO et est retirée dans
`finally`. La disponibilité chaude reste distincte du refus d’une instance froide.

Les pauses CMS ne sont activables que par la configuration et le volume de la
campagne isolée ; le contrôleur externe réalise les SIGKILL. Le harnais conserve
chaque tentative, y compris les échecs, sans inventer un succès après un simple
HTTP 200. Les archives restent privées. Une validation ici ne remplace pas les
Golden Journeys de staging, les contrôles de production ni la surveillance.

Limites : MinIO qualifie le protocole et la persistance, pas l’infrastructure du
fournisseur S3 de production. Le catalogue est synthétique et représente un calcul
déjà validé ; cette suite ne requalifie pas ses algorithmes géographiques.

## Annexes

### Commandes reproductibles

Prérequis : réservation et qualification du socle via les commandes de
`infra-sincere/scripts/qualification/`, puis son checkout au SHA épinglé sous
`/home/ubuntu/source/infra-sincere-qualification-vm`. La VM doit être isolée,
MicroK8s 1.35.6 révision 9072 prêt, avant toute installation GTHF.

Le client vérifie la révision et les empreintes de `vm.py` et `provision-vm.py`,
puis exécute leurs copies privées sous `/run` avec Python isolé. Une modification
masquée dans l’index Git ou après sa vérification ne peut changer les octets
exécutés. La fin normale, une exception et SIGTERM nettoient cette copie ;
SIGKILL ne peut exécuter ce nettoyage. Les droits sudo existants restent la
frontière de confiance, sans règle privilégiée supplémentaire.

Depuis le checkout frontend propre du candidat, avec Node 24 :

```sh
npm run infra:recovery:images -- \
  --run-id gthf-recovery-CAMPAGNE \
  --uuid UUID-DE-LA-RESERVATION \
  --cms-source /home/ubuntu/source/gthf/recovery-29/gthf-cms

npm run test:e2e:recovery -- --target vm \
  --manifest /home/ubuntu/.local/state/infra-sincere/qualification-vm/gthf-recovery-CAMPAGNE/manifest-CMS-FRONTEND.json \
  --phase prepare

npm run test:e2e:recovery -- --target vm \
  --manifest /home/ubuntu/.local/state/infra-sincere/qualification-vm/gthf-recovery-CAMPAGNE/manifest-CMS-FRONTEND.json
```

Les substitutions en majuscules sont les valeurs exactes rendues par les outils,
pas des valeurs à inventer. `prepare` est réservé à une campagne fraîche et
qualifie seulement son installation ; la commande sans `--phase` exécute les
Golden Journeys. Un changement du contenu testé exige une nouvelle qualification.

Après les fixtures, `--phase journal` vérifie l’identité de la campagne, réduit
le seul déploiement CMS identifié à zéro et attend la disparition de ses pods.
Il exécute ensuite dans l’image candidate le contrôle du journal avec le vrai
PostgreSQL. Les baux artificiellement expirés ne concurrencent aucun autre CMS.
La phase ne redémarre jamais automatiquement une ancienne image après migration.
`--phase install` remplace ensuite les applications par les images du manifeste,
sans réinitialiser les données ; les images PostgreSQL et MinIO doivent rester
identiques. La qualification complète porte ensuite sur ce nouveau manifeste.

Après diagnostic d’un échec d’installation, `--phase resume-prepare` accepte
uniquement la même réservation, identité, namespace et les mêmes identifiants,
avant le premier Job de fixtures. `--phase resume-fixtures` exige des Jobs
échoués et arrêtés, aucun déploiement applicatif et aucun résultat de fixtures
déjà validé. Les anciennes tentatives restent conservées. Le seeding SQL est
transactionnel ; une reprise de l’ancien préfixe éditorial est limitée à son
contenu synthétique exact, sans opération média. Aucun de ces modes ne qualifie
une reprise métier ni n’efface la base pour masquer un échec.

Les builds utilisent une archive Git figée, jamais un checkout qui peut évoluer
pendant Docker. L’export OCI conserve son index, son manifeste Linux amd64 et sa
configuration, vérifiés par SHA256 ; le format Docker historique sans RepoTags
est écarté. Le harnais vérifie aussi les images des init-containers Next.
Toutes les phases exigent le checkout propre à la révision du manifeste.
`dependency-images.json` fige les images et archives PostgreSQL/MinIO dès le
premier build de la campagne ; les builds applicatifs suivants les réutilisent
après vérification d’identité et de checksum, sans changer les dépendances durables.

Avant livraison, reprendre `infra:recovery:images` avec les deux options
`--published-cms /CHEMIN-CAMPAGNE/candidate-cms.json` et
`--published-frontend /CHEMIN-CAMPAGNE/candidate-frontend.json` : ce sont les
publications privées copiées depuis les branches GitHub `gthf-release`, avec les
checkouts aux SHA exacts de main. Le contrôleur vérifie les workflows main
réussis, le déployeur commun, les noms GHCR, les digests et labels de révision,
ainsi que les capacités CMS `io.gthf.media-recovery=2` et
`io.gthf.media-batch-recovery=1`, puis importe ces images sans les reconstruire. Le manifeste obtenu porte le
suffixe `-published` et les références CI. Ces digests sont ceux à requalifier
avant staging et production. Suspendre le réconciliateur durant cette étape.
Les fixtures d’une tentative échouée restent conservées ; chaque nouvelle
publication interrompue reçoit un slug propre à la tentative.

### Identité, preuves et nettoyage

Le namespace invité est toujours `gthf-recovery`. La base et le bucket dérivent
de l’UUID. Aucun paramètre ne permet de fournir une URL CMS, une base externe ou
un kubeconfig hôte. Les tunnels hôte 33137/33100/33101/33190 ne sont accessibles
que par loopback et ont une durée bornée à une heure.

Les preuves sont sous
`/home/ubuntu/.local/state/infra-sincere/qualification-vm/<run-id>/` : manifeste,
révisions/digests, chronologie JSONL, rapport de chaque tentative, résultats et
limites. Les identifiants et journaux détaillés sont privés, modes 0700/0600.
Les valeurs d’acquittement sont vérifiées avant et après les coupures.

Après livraison vérifiée : arrêter la VM, demander au contrôleur commun une
archive froide complète, vérifier son manifeste, nettoyer les seules ressources
identifiées puis libérer la réservation. Le processus de test ne libère jamais
automatiquement le banc lorsqu’il meurt ou échoue.

### Limites des caches et conservation des médias

Un objet global reçu avec succès ferme aussi un interrupteur demandé absent ou
invalide : une ancienne valeur `true` ne revient pas pendant une panne ultérieure.
Cette autorité est partagée entre projections qui contiennent le même champ ;
une projection qui ne le demande pas ne ferme pas les autres fonctionnalités.
Les erreurs de transport et les enveloppes JSON malformées restent des pannes
temporaires et peuvent utiliser le dernier résultat public validé.

Les anciennes versions publiques remplacées sont retenues tant que le fichier
logique existe, sans délai arbitraire de suppression : le fallback peut durer
aussi longtemps que la partition. Le coût de stockage suit les remplacements.
Leurs URL restent lisibles ; la suppression explicite et autorisée du fichier
libère tous ses historiques. Les nettoyages retenus ne sollicitent pas S3.
La capacité v1 ignore cette rétention : elle est refusée pour les candidats et
les retours arrière, et nécessite un remplacement `Recreate` vers v2.
La table additive `gthf_media_batches` exige en plus la capacité
`io.gthf.media-batch-recovery=1`, même si aucun lot n’est en attente. Un ancien
worker v2 sans cette capacité est arrêté avant le nouveau worker.

Le transfert partiel contient également une simulation annoncée du PUT tardif :
après le premier nettoyage réel, le harnais réinjecte les anciens octets à leur
ancienne clé MinIO et attend une nouvelle inspection automatique. Les clés du
retry et une collision étrangère doivent rester intactes. Cet objet étranger
synthétique reste intentionnellement dans la VM jusqu’au démontage. Ce contrôle
prouve la reprise de cet ordre de complétion, pas une panne du fournisseur S3.


### Source HTTP synthétique des imports URL

Le Golden Journey URL réutilise un PNG synthétique déjà acquitté dans le bucket de
la campagne. `withUrlFixture` vérifie UUID, réservation et namespace, puis crée un
Service temporaire vers le MinIO de cette VM avec l’adresse TEST-NET
`203.0.113.42:9000`. Une requête depuis le CMS doit lire les octets attendus et leur
SHA256 avant d’autoriser le scénario. Le helper retire ensuite ce Service avec
préconditions UID/resourceVersion, y compris après un échec. Aucun objet, réglage
S3, règle SSRF ou accès public n’est créé par ce helper.

Après un vrai SIGKILL avant commit, le reçu est repris en moins de 300 s et SQL/S3
prouvent un unique média. Le replay conserve la même clé après retrait du Service ;
il doit donc fonctionner sans téléchargement de la source. Les contrôles incluent
le refus de l’ancien admin sans clés, la séparation des propriétaires et le conflit
si la même clé désigne une autre URL. Cette source locale au banc préserve les
contrôles SSRF de Strapi ; elle ne qualifie pas la disponibilité d’un fournisseur
HTTP public. Les trois parcours navigateur URL sont une suite complémentaire dans
le dépôt CMS, via `npm run test:e2e:media-admin -- --url-fixture ...`.


### Convergence publique pendant un rollout — frontend #42

Depuis le checkout propre du candidat installé, exécuter séparément de la campagne
avec coupures :

```sh
npm run test:e2e:recovery -- --target vm --phase convergence \
  --manifest /chemin/prive/de/la/campagne/manifest-candidat.json \
  --previous-manifest /chemin/prive/de/la/meme/campagne/manifest-precedent.json
```

Les deux manifestes doivent désigner la même réservation et VM, avec deux révisions
et manifestes OCI frontend distincts. Seules les archives frontend, vérifiées
par SHA256, sont importées ; aucun CMS ou stockage n’est rétrogradé. Pour chacune
des deux images, l’export OCI `--runtime-only` place directement dans `index.json`
le descripteur du manifeste runtime existant. Tous les blobs sont copiés sans
modification et vérifiés par SHA256 avant l’import. Aucun manifeste applicatif
n’est régénéré. Le nom canonique, le type manifeste, les SHA256 du manifeste et de sa
configuration, Linux amd64 et le label de révision sont attestés avant les pods.
Un index renommé en digest runtime ou un import qui modifie ce digest sont
refusés ; une référence existante incorrecte n’est jamais écrasée. Les preuves
figurent dans `runtime-images.json`. Ces références restent dans le cache
containerd privé de la VM, comme les autres images de campagne. La phase ajoute
ses propres Deployments, Services ClusterIP, Secret synthétique et ConfigMap,
identifiés par UUID de VM, campagne, tentative et UID Kubernetes. Elle ne modifie
ni `frontend-a`, ni `frontend-b`, ni les données persistantes. Le contrôle tourne
dans la VM ; aucun endpoint supplémentaire n’est exposé sur l’hôte.

Le statut CRI peut annoncer le digest d’un index déjà importé, même si le pod
référence son manifeste runtime : containerd regroupe les références par
configuration et choisit un digest de dépôt. Le déployeur garde l’image demandée
exacte et les contrôles de readiness/init. Un alias n’est accepté qu’après
SHA256 de l’index, unique descripteur Linux amd64 vers le manifeste runtime exact,
puis SHA256 et tailles du manifeste et de sa configuration, plateforme et label
de révision. Partager seulement une configuration ne suffit pas. Chaque lecture
d’alias est limitée à cinq secondes et chaque blob de métadonnées à 16 Mio.
Les noms et `imageID` observés, puis leur preuve résolue, figurent dans
`componentVerification[].runtimeImages`, y compris l’identité refusée en cas
d’échec. Les digests runtime/config directement attendus restent acceptés.
La règle CRI est documentée dans la [source containerd 2.1.6](https://github.com/containerd/containerd/blob/v2.1.6/internal/cri/server/container_status.go#L40).

Cinq Golden Journeys utilisent les vrais serveurs Next et le gateway de l’image :
rollout avec `preStop` de dix secondes et ancienne connexion, révision publique
ancienne persistante, absence réelle d’endpoints amont, mauvaise image runtime,
et mauvaise image d’initialisation. Le pilote charge les octets exacts du
`release.py` candidat, puis appelle ses fonctions de vérification inchangées.
Seuls le namespace et le transport HTTP sont adaptés au banc. Les délais de
convergence sont les quatre-vingt-dix secondes réelles de la livraison ; aucune
horloge accélérée n’est présentée comme preuve E2E. Les deux mauvaises images
sont refusées avant la première tentative de preuve publique.
La vérification s’applique aussi à l’image précédente avant le rollout ; son
`baselineDeliveryEvidence` conserve les identités runtime et init. Une campagne
qui revendique la branche d’alias doit y constater les deux preuves de graphe
`verified-runtime-index-alias`, avec les digests exacts du manifeste précédent.

Le client HTTP maintient une vraie connexion `keep-alive`. Le wrapper du gateway
observe passivement les tuples TCP de son Agent, sans changer ses options ni son
code de proxy. Les lectures d’entretien sont séquentielles, à une seconde
d’intervalle, et cessent au début de la vérification publique. Le succès exige
l’ancienne révision et l’ancien UID en terminaison, ainsi que la réutilisation du
même tuple TCP vers la ClusterIP pendant le rollout. Avant celui-ci, les
EndpointSlices appartenant au Service doivent cibler uniquement l’ancien Pod
prêt ; le DNAT Kubernetes ne transforme pas l’adresse distante vue par le gateway
en PodIP. Si ce phénomène n’est pas observé, la tentative échoue et conserve ses observations : un rollout réussi
seul ne prétend pas reproduire l’ancienne connexion. La publication synthétique
et le refus de preview sont vérifiés après convergence.

Le pilote est borné à quinze minutes ; l’import et le nettoyage possèdent leurs
propres limites. `convergence.json` et les sorties privées du pilote détaillent
les observations et le SHA256 du vérificateur. Les ressources temporaires sont
retirées avec préconditions UID/resourceVersion, puis leur absence est contrôlée.
Une identité étrangère bloque le nettoyage. Une interruption conserve toujours
la réservation et exige une inspection avant reprise ; elle ne vaut jamais
qualification réussie. Aucun succès de cette phase n’est encore revendiqué par
la seule présence de ces scripts ou leurs tests locaux de garde-fous.
