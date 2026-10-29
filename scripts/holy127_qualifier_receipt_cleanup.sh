#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG PYTHONPATH PYTHONHOME
test "$#" -eq 0
directory=/var/tmp/holy127-q-f4f5a94-20261029a
receipt=$directory/qualification.json
lock=/run/holy-sheet-release/release.lock
for ancestor in /run /run/holy-sheet-release; do
  test ! -L "$ancestor"
  test "$(/usr/bin/stat -c %u:%g "$ancestor")" = "0:0"
  mode=$(/usr/bin/stat -c %a "$ancestor")
  test $((0$mode & 0022)) -eq 0
done
test ! -L "$lock"
test "$(/usr/bin/stat -c %u:%a:%F "$lock")" = "0:660:regular file"
exec 9<>"$lock"
/usr/bin/flock -n 9
for ancestor in /var /usr/local /usr/local/sbin; do
  test ! -L "$ancestor"
  test "$(/usr/bin/stat -c %u:%g "$ancestor")" = "0:0"
  mode=$(/usr/bin/stat -c %a "$ancestor")
  test $((0$mode & 0022)) -eq 0
done
test "$(/usr/bin/stat -c %u:%g:%a /var/tmp)" = "0:0:1777"
test ! -L "$0"
test "$(/usr/bin/stat -c %u:%g:%a "$0")" = "0:0:555"
test ! -L "$directory"
test ! -L "$receipt"
test "$(/usr/bin/stat -c %u:%g:%a "$directory")" = "0:0:700"
test "$(/usr/bin/stat -c %u:%g:%a "$receipt")" = "0:0:600"
test "$(/usr/bin/find "$directory" -mindepth 1 -maxdepth 1 -printf '%f\n')" = "qualification.json"
/usr/bin/sha256sum "$receipt"
/usr/bin/rm -- "$receipt"
/usr/bin/rmdir -- "$directory"
