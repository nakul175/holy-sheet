#!/bin/sh
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG PYTHONPATH PYTHONHOME

if [ "$#" -ne 0 ]; then
  echo "HOLY-127 installer accepts no arguments" >&2
  exit 64
fi

test "$(/usr/bin/id -u)" -eq 0

source_root=/var/tmp/holy127-installer-rootpath-v2/source
bundle_parent=/opt/holy-sheet-qualification
bundle=/opt/holy-sheet-qualification/holy127-4c1fdbda6becaf76
entrypoint=/usr/local/sbin/holy127-q-f4f5a94
receipt_entrypoint=/usr/local/sbin/holy127-q-f4f5a94-receipt
cleanup_entrypoint=/usr/local/sbin/holy127-q-f4f5a94-cleanup
sudoers=/etc/sudoers.d/holy127-q-f4f5a94
lock_parent=/run/lock/holy-sheet-release
lock_file=/run/lock/holy-sheet-release/release.lock
stage_suffix=.holy127-install-rootpath-v2.pending

created_bundle_parent=0
created_lock_parent=0
created_lock_file=0
committed_bundle=0
committed_entrypoint=0
committed_receipt_entrypoint=0
committed_cleanup_entrypoint=0
committed_sudoers=0
staged_bundle=0
staged_entrypoint=0
staged_receipt_entrypoint=0
staged_cleanup_entrypoint=0
staged_sudoers=0

bundle_stage=${bundle}${stage_suffix}
entrypoint_stage=${entrypoint}${stage_suffix}
receipt_entrypoint_stage=${receipt_entrypoint}${stage_suffix}
cleanup_entrypoint_stage=${cleanup_entrypoint}${stage_suffix}
sudoers_stage=${sudoers}${stage_suffix}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  [ "$staged_bundle" -eq 0 ] || /usr/bin/rm -rf -- "$bundle_stage" 2>/dev/null || true
  [ "$staged_entrypoint" -eq 0 ] || /usr/bin/rm -f -- "$entrypoint_stage" 2>/dev/null || true
  [ "$staged_receipt_entrypoint" -eq 0 ] || /usr/bin/rm -f -- "$receipt_entrypoint_stage" 2>/dev/null || true
  [ "$staged_cleanup_entrypoint" -eq 0 ] || /usr/bin/rm -f -- "$cleanup_entrypoint_stage" 2>/dev/null || true
  [ "$staged_sudoers" -eq 0 ] || /usr/bin/rm -f -- "$sudoers_stage" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    [ "$committed_sudoers" -eq 0 ] || /usr/bin/rm -f -- "$sudoers"
    [ "$committed_cleanup_entrypoint" -eq 0 ] || /usr/bin/rm -f -- "$cleanup_entrypoint"
    [ "$committed_receipt_entrypoint" -eq 0 ] || /usr/bin/rm -f -- "$receipt_entrypoint"
    [ "$committed_entrypoint" -eq 0 ] || /usr/bin/rm -f -- "$entrypoint"
    [ "$committed_bundle" -eq 0 ] || /usr/bin/rm -rf -- "$bundle"
    [ "$created_lock_file" -eq 0 ] || /usr/bin/rm -f -- "$lock_file"
    [ "$created_lock_parent" -eq 0 ] || /usr/bin/rmdir -- "$lock_parent" 2>/dev/null || true
    [ "$created_bundle_parent" -eq 0 ] || /usr/bin/rmdir -- "$bundle_parent" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "HOLY-127 installer refused: $1" >&2
  exit 1
}

verify_safe_ancestor() {
  path=$1
  test ! -L "$path" || fail "symlink ancestor: $path"
  test -d "$path" || fail "missing directory ancestor: $path"
  test "$(/usr/bin/stat -c %u:%g "$path")" = "0:0" || fail "non-root ancestor: $path"
  mode=$(/usr/bin/stat -c %a "$path")
  test $((0$mode & 0022)) -eq 0 || fail "writable ancestor: $path"
}

verify_regular_source() {
  relative=$1
  expected=$2
  path=$source_root/$relative
  test ! -L "$path" || fail "symlink source: $relative"
  test -f "$path" || fail "missing source: $relative"
  test "$(/usr/bin/stat -c %u:%g "$path")" = "0:0" || fail "non-root source: $relative"
  mode=$(/usr/bin/stat -c %a "$path")
  test $((0$mode & 0022)) -eq 0 || fail "writable source: $relative"
  actual=$(/usr/bin/sha256sum "$path")
  actual=${actual%% *}
  test "$actual" = "$expected" || fail "hash mismatch: $relative"
}

verify_absent() {
  test ! -e "$1" && test ! -L "$1" || fail "install target already exists: $1"
}

verify_safe_ancestor /var
test ! -L /var/tmp || fail "symlink ancestor: /var/tmp"
test "$(/usr/bin/stat -c %u:%g:%a /var/tmp)" = "0:0:1777" || fail "unsafe /var/tmp"
test ! -L "${source_root%/source}" || fail "symlink source root parent"
test "$(/usr/bin/stat -c %u:%g:%a "${source_root%/source}")" = "0:0:700" || fail "unsafe source root parent"
test ! -L "$source_root" || fail "symlink source root"
test "$(/usr/bin/stat -c %u:%g:%a "$source_root")" = "0:0:500" || fail "unsafe source root"
for source_directory in "$source_root/scripts" "$source_root/deployment"; do
  test ! -L "$source_directory" || fail "symlink source directory"
  test -d "$source_directory" || fail "missing source directory"
  test "$(/usr/bin/stat -c %u:%g "$source_directory")" = "0:0" || fail "non-root source directory"
  mode=$(/usr/bin/stat -c %a "$source_directory")
  test $((0$mode & 0022)) -eq 0 || fail "writable source directory"
done

# Verify every one of the 14 frozen manifest payloads before any mutation.
verify_regular_source scripts/holy127_disposable_staging_qualifier.py 4c1fdbda6becaf76b7ca33698737074b50af5d0884d845f1a1c52ff3c0fa8b86
verify_regular_source scripts/holy127_backup_orchestrator.py f1f4655f0129167ae9a2c85e5165780674ad5272aacb59e457eaa8e81ee1d79c
verify_regular_source scripts/hs_release_guard.py 2732a41da67239772b5232c4a616638f22d5de947763e142f1a95a32644c8495
verify_regular_source scripts/holy127_bounded_stream.py 8c874d97c9f6e86be0581ed82c4fff5ab1e539bf57b562c598c5c846040077e2
verify_regular_source scripts/test_holy127_disposable_staging_qualifier.py a93f11d5d7455bc812a292ee41f135f0dbe6e42fb704d16b79714fe27492ac01
verify_regular_source scripts/test_holy127_qualifier_entrypoints.py c723c84148b958238ff8c629fd57eb7f217a6deee8a6f29633bbc0a8adf3d925
verify_regular_source scripts/test_holy127_backup_orchestrator.py 8e56992b0d2f71292b3295f592f7a03766e374b9f659239abf8c8c9b73906724
verify_regular_source scripts/test_holy127_bounded_stream.py d05e29ea56a3b7fec91a1e9b0d0a97e954fb4c1770088231d3c8d4dc3d15af44
verify_regular_source scripts/test_hs_release_guard.py 6a7d3a6544a1e1548b79abdaf55e260c0e2071e1b2409cbf88a382045ea80b40
verify_regular_source deployment/HOLY-127-DISPOSABLE-STAGING-QUALIFICATION.md 0e4ba90764e539608d0aa54094164e0dd1034a37f999067c8feb07619f1b77d8
verify_regular_source deployment/HOLY-127-RELEASE-PACKET.md 754f8997696d270890c4ac6aacba4e3ffab272fe51a1f8b3568e60c9a6c61517
verify_regular_source scripts/holy127_qualifier_entrypoint.sh b8a7c8162e8167b7cd35abde7189c7308a0fba15fe9af79ff9add056b1ed1fa7
verify_regular_source scripts/holy127_qualifier_receipt_collect.sh 64b4f1311029bb64b265824c40a541c806ae3955bfe0b1558eff4e7dd6a8b695
verify_regular_source scripts/holy127_qualifier_receipt_cleanup.sh 349297d0f11330568dffaf8c3486ff4e21af962237ba982324020ac76646910a

# Keep the qualifier bundle outside the hs-staging-owned live application tree.
# Every ancestor of the separate qualification path is root-owned and immutable.
for ancestor in / /opt /usr /usr/local /usr/local/sbin /etc /etc/sudoers.d /run /run/lock; do
  verify_safe_ancestor "$ancestor"
done

if [ -e "$bundle_parent" ] || [ -L "$bundle_parent" ]; then
  verify_safe_ancestor "$bundle_parent"
else
  /usr/bin/install -d -o 0 -g 0 -m 0555 "$bundle_parent"
  created_bundle_parent=1
fi

if [ -e "$lock_parent" ] || [ -L "$lock_parent" ]; then
  verify_safe_ancestor "$lock_parent"
else
  /usr/bin/install -d -o 0 -g 0 -m 0755 "$lock_parent"
  created_lock_parent=1
fi

if [ -e "$lock_file" ] || [ -L "$lock_file" ]; then
  test ! -L "$lock_file" || fail "symlink release lock"
  test "$(/usr/bin/stat -c %u:%g:%a:%F "$lock_file")" = "0:0:660:regular file" || fail "incompatible release lock"
else
  : > "$lock_file"
  /usr/bin/chown 0:0 "$lock_file"
  /usr/bin/chmod 0660 "$lock_file"
  created_lock_file=1
fi

exec 9<>"$lock_file"
/usr/bin/flock -n 9 || fail "shared release lock is busy"

for target in "$bundle" "$entrypoint" "$receipt_entrypoint" "$cleanup_entrypoint" "$sudoers" \
  "$bundle_stage" "$entrypoint_stage" "$receipt_entrypoint_stage" "$cleanup_entrypoint_stage" "$sudoers_stage"; do
  verify_absent "$target"
done

umask 077
/usr/bin/install -d -o 0 -g 0 -m 0555 "$bundle_stage"
staged_bundle=1
/usr/bin/install -o 0 -g 0 -m 0444 "$source_root/scripts/holy127_disposable_staging_qualifier.py" "$bundle_stage/holy127_disposable_staging_qualifier.py"
/usr/bin/install -o 0 -g 0 -m 0444 "$source_root/scripts/holy127_backup_orchestrator.py" "$bundle_stage/holy127_backup_orchestrator.py"
/usr/bin/install -o 0 -g 0 -m 0444 "$source_root/scripts/hs_release_guard.py" "$bundle_stage/hs_release_guard.py"
/usr/bin/install -o 0 -g 0 -m 0555 "$source_root/scripts/holy127_qualifier_entrypoint.sh" "$entrypoint_stage"
staged_entrypoint=1
/usr/bin/install -o 0 -g 0 -m 0555 "$source_root/scripts/holy127_qualifier_receipt_collect.sh" "$receipt_entrypoint_stage"
staged_receipt_entrypoint=1
/usr/bin/install -o 0 -g 0 -m 0555 "$source_root/scripts/holy127_qualifier_receipt_cleanup.sh" "$cleanup_entrypoint_stage"
staged_cleanup_entrypoint=1

{
  echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/holy127-q-f4f5a94'
  echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/holy127-q-f4f5a94-receipt'
  echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/holy127-q-f4f5a94-cleanup'
} > "$sudoers_stage"
/usr/bin/chown 0:0 "$sudoers_stage"
/usr/bin/chmod 0440 "$sudoers_stage"
staged_sudoers=1
/usr/sbin/visudo -cf "$sudoers_stage" >/dev/null

# Commit only after every payload and the complete sudoers fragment validate.
/usr/bin/mv -T -- "$bundle_stage" "$bundle"
staged_bundle=0
committed_bundle=1
/usr/bin/mv -T -- "$entrypoint_stage" "$entrypoint"
staged_entrypoint=0
committed_entrypoint=1
/usr/bin/mv -T -- "$receipt_entrypoint_stage" "$receipt_entrypoint"
staged_receipt_entrypoint=0
committed_receipt_entrypoint=1
/usr/bin/mv -T -- "$cleanup_entrypoint_stage" "$cleanup_entrypoint"
staged_cleanup_entrypoint=0
committed_cleanup_entrypoint=1
/usr/bin/mv -T -- "$sudoers_stage" "$sudoers"
staged_sudoers=0
committed_sudoers=1
/usr/sbin/visudo -cf /etc/sudoers >/dev/null

# Verify the committed surfaces without executing the qualifier.
test "$(/usr/bin/stat -c %u:%g:%a "$bundle")" = "0:0:555"
test "$(/usr/bin/stat -c %u:%g:%a "$entrypoint")" = "0:0:555"
test "$(/usr/bin/stat -c %u:%g:%a "$receipt_entrypoint")" = "0:0:555"
test "$(/usr/bin/stat -c %u:%g:%a "$cleanup_entrypoint")" = "0:0:555"
test "$(/usr/bin/stat -c %u:%g:%a "$sudoers")" = "0:0:440"

trap - EXIT HUP INT TERM
echo "HOLY-127 fixed qualifier surfaces installed; qualification not executed"
