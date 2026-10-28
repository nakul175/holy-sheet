#!/bin/sh
set -eu
test "$#" -eq 0
directory=/var/tmp/holy127-q-f4f5a94-20261029a
receipt=$directory/qualification.json
test ! -L "$directory"
test ! -L "$receipt"
test "$(stat -c %u:%g:%a "$directory")" = "0:0:700"
test "$(stat -c %u:%g:%a "$receipt")" = "0:0:600"
exec /usr/bin/cat "$receipt"
