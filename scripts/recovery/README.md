# Résilience GTHF sur le banc infra-sincere

## Summary

Ce profil appartient à GTHF ; le cycle de vie de la VM appartient à
`infra-sincere`. La campagne qualifie les médias CMS, les publications et les
lectures publiques frontend après de vrais arrêts de processus et trois coupures
QEMU. Les preuves portent les révisions et digests candidats. Le banc refuse une
cible inconnue, une réservation étrangère et les paramètres de production.
Le profil est en cours de qualification : sa présence ne vaut pas succès E2E.

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
Une image avec plusieurs formats vérifie le nettoyage d’un transfert partiel.
La panne frontend dure réellement plus de 300 secondes pour dépasser les TTL ;
les assertions portent sur les publications, les villes et les octets GPX/géométrie.

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

Après les fixtures et avant les pods CMS permanents, `--phase journal` exécute
dans l’image candidate le contrôle du journal avec le vrai PostgreSQL. Les baux
artificiellement expirés de ce contrôle ne doivent concurrencer aucun autre CMS.
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
