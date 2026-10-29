# Known behavior for separate Product triage

Observed during HOLY128 testing, not changed or claimed fixed by HOLY128.

An API-created blank heading with explicit `content:[]` is serialized by the current editor without the content property. The existing editable setup emits that normalized body through onUpdate, causing an initial save/version increase even with no outline action.

Independent Product diagnostic read: matched noncanonical control and outline action each operation200, version2→3; sole body diff `/content/3/content:[]` removed; no captured docChanged transaction. Canonical empty-heading fixture omits content; matched control/action each0operations, version2→2, identical document,0docChanged transactions. Payloads/timings retained in Engineer5 test-results/holy128-normalization-control and holy128-normalization-canonical directories. This is evidence of a baseline normalization/save behavior; no broader production prevalence or current viewer mutation is asserted.

Product created HOLY-130 Bug/InProgress and assigned Engineer2 on29October after126parked. Scope: narrow setup/update persistence boundary, no read-time rewrite/migration, retain explicit-empty fixture regression and prove real edits/undo/recovery stillsave. HOLY128 keeps canonicalfixtures/zero-writeassertions;130 fixes the separately reproduced baseline behavior. No other engineer owns130 or automatic range expansion.
