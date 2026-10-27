# HOLY-3 bounded legacy conversion rehearsal

The prototype converter previously trusted array order, could generate helper IDs
that collided with original block IDs and silently flattened parent relationships
or downgraded unknown types to paragraphs. Synthetic regressions reproduced these
conditions before the fix.

Supported flat prototype blocks now convert in stored position order. Original
IDs, literal text/whitespace/Unicode, heading mapping and checklist values remain
intact. Generated list/text IDs reserve every original ID first and remain within
the document ID limit. Conversion validates the resulting document before returning.

Nested or mixed-page sources, duplicate IDs/positions, unsupported fields/types,
invalid values and checked state on a non-checklist block stop with an explicit
review error. The source is never mutated. This is intentional refusal to discard
information; an explicit mapping/import plan is still needed for those sources.

A disposable filesystem-backed SQL test converts a representative fixture, saves
it through the real repository, closes the database, reopens it with migrations
and compares the complete document view. Its temporary database is removed after
the test. No staging/user database or existing prototype storage is changed.

This supplies bounded AT26 conversion/cold-persistence evidence. It does not import
actual legacy production data, qualify arbitrary nested legacy trees, demonstrate
an app revision rollback, or close the remaining AT26/AT38 acceptance gates. The
incompatible-version client fallback is recorded separately. No new migration or
deployment is introduced.
