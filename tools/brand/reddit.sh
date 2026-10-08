#!/bin/sh
# Renders tools/brand/reddit.html to three 1200×1200 PNGs in tools/brand/reddit/.
set -e; cd "$(dirname "$0")"; mkdir -p reddit
for n in 1 2 3; do
  chromium --headless --no-sandbox --hide-scrollbars --disable-gpu --window-size=1200,1200 \
    --virtual-time-budget=8000 --screenshot="$PWD/reddit/lattice-$n.png" "file://$PWD/reddit.html?n=$n" 2>/dev/null
done
ls reddit
