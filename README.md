# AVADO Starknet Validator

`starknet.avado.dnp.dappnode.eth`: a Starknet full node and a Starknet staking validator on the
AVADO box, with a plain-language page at http://starknet.my.ava.do.

## What it does

- Runs **Juno** (Nethermind's Starknet node, v0.17.0) on Starknet mainnet. Juno checks Starknet
  against the **Ethereum node on the same AVADO** (Geth, Nethermind or Reth, found automatically
  over the AVADO network), so the box does not have to trust anyone's servers.
- **Fast start**: on an empty database it downloads the pruned copy the Juno team publishes
  (about 100 GB, `juno-snapshots.nethermind.io/files/mainnet-pruned/latest`) and unpacks it while
  downloading (no second copy on disk; resumes after a dropped connection; checks free space
  first). Juno then runs with `--prune-mode=4500` (about four epochs of history), which is all an
  attester needs. The owner can choose to sync from the first block instead.
- Runs Nethermind's **attestation tool** (`starknet-staking-v2` v0.3.1) once the owner has entered
  the operational account and Juno has caught up.
- Shows, in plain words: node state and progress, which Ethereum node it uses, the validator state,
  linked stake, STRK left for fees on the operational account, last attestation, attestations sent /
  confirmed / failed, current epoch, free disk space, and the two logs (secrets hidden).

## Keys: what the box keeps and what it does not

Starknet staking v2 uses three addresses: the **staking** address (holds the 20,000 STRK minimum,
cold), the **reward** address (cold) and the **operational** address (hot, signs attestations and
pays their fees). The page asks only for the operational account's address and private key. The
staking wallet, its key and its recovery phrase never touch the box; the page says so twice.

The operational key is stored in the package volume (`secrets/operational-key`, mode 600, written
atomically), passed to the attestation tool in its environment (never on the command line, where
every process could read it), never returned by the page API, and hidden in the logs the page shows.
"Stop and remove the key" deletes it. An external signer would avoid keeping even this key, but it
needs another always-on machine, which a home owner does not have; the operational account can only
attest and pay small fees, so the exposure is limited to the STRK left on it for fees.

## Network and ports

No host ports. On the AVADO network: 80 (page), 6060 / 6061 (Juno RPC, http / websocket, so wallets
on a device connected to the AVADO can use `http://starknet.my.ava.do:6060/v0_10`). Metrics stay on
127.0.0.1 inside the container. The page API has the same guards as the other AVADO pages: Host
allow-list (DNS rebinding) and a same-origin check plus a custom header on every change.

## Requirements

- Geth, Nethermind or Reth on mainnet on the same AVADO (synced). Without one, the page says
  "Install an Ethereum node first"; advanced owners can point it at another Ethereum node or,
  not recommended, at none.
- About 200 GB of free disk space (pruned copy plus growth). 4 CPU cores and 8 GB RAM are plenty.
- Docker 20.10.10+ on the host (bookworm base image, like AVADO Care and Rocket Pool).

## Build and test

`docker-compose.yml` builds `build/Dockerfile` from the repository root. The image build runs the
unit tests (`node --test`) and fails if one fails. Upstream images are pinned by digest.

    docker buildx build --platform linux/amd64 --load -f build/Dockerfile -t starknet-test .

## Licence and credits

GPL-3.0 (see LICENSE). Juno and starknet-staking-v2 are Apache-2.0, by Nethermind, copied unmodified
from their Docker images (see build/NOTICE). DAppNode's `DAppNodePackage-juno-generic` and
`DAppNodePackage-starknetstaking-generic` were read as a reference for how the two programs are
configured (no licence file in those repositories, so nothing was copied). Page styles come from the
AVADO Admin, Care and AI Connect pages.
