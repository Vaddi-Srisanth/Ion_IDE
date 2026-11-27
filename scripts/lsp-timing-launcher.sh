#!/bin/sh
set -eu
base=${0%/*}
IFS= read -r node < "$base/pyright-node.txt"
IFS= read -r proxy < "$base/pyright-proxy.txt"
IFS= read -r timing < "$base/pyright-timing.txt"
IFS= read -r entry < "$base/pyright-entry.txt"
exec "$node" "$proxy" "$timing" "$entry" "$@"
