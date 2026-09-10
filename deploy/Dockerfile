# The deploy bundle: the fifth image, and the one that is never run.
#
# A customer VM used to hold a full `git clone` of this repository, because `docker compose` needs
# the compose file and the scripts on the machine and that was the only way they got there. It put
# the whole source on every customer's disk — the thing going private is meant to end — and it
# stopped working the day the repository went private (2026-09-10): the clone was anonymous
# HTTPS, and the fleet's `git pull` died with it.
#
# So the files a VM needs ride the same channel and tag as the four runtime images, and IMAGE_TAG
# selects one consistent set of five. A VM extracts them without starting anything:
#
#   docker create --name laf-deploy ghcr.io/laf-labs/openbot-deploy:$IMAGE_TAG
#   docker cp laf-deploy:/deploy/. /home/ubuntu/openbot/
#   docker rm laf-deploy
#
# so nothing in here may assume a `.git` directory, and a deployment directory is these files plus
# its own `.env`, which the copy never touches. What goes in is exactly what the fleet tool and a
# person on the VM reference: the compose file, `scripts/upgrade.sh` and `scripts/restore.sh`
# (`laf restore` runs the latter; the nightly backup script is the fleet's own and is not here),
# `.env.example` for the names a `.env` may carry, and VERSION for reading what a VM runs.
#
# FROM scratch, because it holds files and no runtime. `docker create` still refuses an image with
# no command, so a CMD is set that nothing ever executes. VERSION is written by a COPY heredoc and
# not a RUN so that no instruction here executes anything at all — which is what lets images.yml
# build both architectures on one runner, in seconds, with no emulation.

FROM scratch

# Filled by images.yml. The defaults name a build nobody published, honestly.
ARG REVISION=unknown
ARG CHANNEL=local

COPY docker-compose.yml .env.example /deploy/
# The mode is set here rather than trusted from the context: the scripts are run by path from the
# deployment directory, and a checkout on a filesystem that dropped the bit would ship one that
# `Permission denied`s.
COPY --chmod=755 scripts/upgrade.sh scripts/restore.sh /deploy/scripts/
# The channel is the one this build was made FOR: `edge` from main, `vX.Y.Z` from a tag. `:stable`
# is only ever an alias minted onto one of those in the merge job, so a VM on IMAGE_TAG=stable reads
# here what stable resolved to — which is the question.
COPY <<EOF /deploy/VERSION
revision=${REVISION}
channel=${CHANNEL}
EOF

CMD ["/deploy/VERSION"]
