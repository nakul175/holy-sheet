#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset DOCKER_CONTEXT DOCKER_CONFIG PYTHONPATH PYTHONHOME

if [ "$#" -ne 0 ]; then
  echo "HOLY-127 qualifier accepts no arguments" >&2
  exit 64
fi

bundle=/opt/holy-sheet-staging/qualification/holy127-4c1fdbda6becaf76
test "$(/usr/bin/id -u)" -eq 0

verify_ancestor() {
  path=$1
  test ! -L "$path"
  test "$(/usr/bin/stat -c %u:%g "$path")" = "0:0"
  mode=$(/usr/bin/stat -c %a "$path")
  test $((0$mode & 0022)) -eq 0
}

for ancestor in /opt /opt/holy-sheet-staging /opt/holy-sheet-staging/qualification "$bundle" /usr/local /usr/local/sbin; do
  verify_ancestor "$ancestor"
done
test ! -L "$0"
test "$(/usr/bin/stat -c %u:%g:%a "$0")" = "0:0:555"

verify_file() {
  expected=$1
  path=$2
  test ! -L "$path"
  test "$(/usr/bin/stat -c %u:%g:%a "$path")" = "0:0:444"
  actual=$(/usr/bin/sha256sum "$path")
  actual=${actual%% *}
  test "$actual" = "$expected"
}

verify_file 8e6cd93ad616d631b5242d372a265e0b80c65684bae75dd96f226b104aaccd63 "$bundle/holy127_disposable_staging_qualifier.py"
verify_file f1f4655f0129167ae9a2c85e5165780674ad5272aacb59e457eaa8e81ee1d79c "$bundle/holy127_backup_orchestrator.py"
verify_file 2732a41da67239772b5232c4a616638f22d5de947763e142f1a95a32644c8495 "$bundle/hs_release_guard.py"

umask 077
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DOCKER_HOST=unix:///var/run/docker.sock /usr/bin/python3 -I -c 'import runpy,sys;sys.path.insert(0,"/opt/holy-sheet-staging/qualification/holy127-4c1fdbda6becaf76");runpy.run_path("/opt/holy-sheet-staging/qualification/holy127-4c1fdbda6becaf76/holy127_disposable_staging_qualifier.py",run_name="__main__")'
