#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG PYTHONPATH PYTHONHOME
test "$#" -eq 0
directory=/var/tmp/holy127-q-f4f5a94-20261029a
receipt=$directory/qualification.json
lock=/run/lock/holy-sheet-release/release.lock
exec 9<>"$lock"
/usr/bin/flock -n 9
for ancestor in /var /usr/local /usr/local/sbin; do
  test ! -L "$ancestor"
  test "$(/usr/bin/stat -c %u:%g "$ancestor")" = "0:0"
  mode=$(/usr/bin/stat -c %a "$ancestor")
  test $((0$mode & 0002)) -eq 0
done
test "$(/usr/bin/stat -c %u:%g:%a /var/tmp)" = "0:0:1777"
test ! -L "$0"
test "$(/usr/bin/stat -c %u:%g:%a "$0")" = "0:0:555"
test ! -L "$directory"
test ! -L "$receipt"
test "$(/usr/bin/stat -c %u:%g:%a "$directory")" = "0:0:700"
test "$(/usr/bin/stat -c %u:%g:%a "$receipt")" = "0:0:600"
exec /usr/bin/cat "$receipt"
