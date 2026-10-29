# Engineer 2: inspect and open document hyperlinks

NJ authorizes a separate standalone assignment while HOLY-134 remains parked.
Engineer 2 owns this single next story. Create a new Holy Sheet BTF story and
return its actual identifier before coding; do not reuse a parked story.

As a reader or editor, I can inspect a document hyperlink, copy its destination,
and explicitly open it without accidentally changing my document.

Source audit: Engineer 2's e620c0c8a26d1912ba3fcb8dfb0169f37b29b711
contains the existing link mark, safeUrl validation, and Edit link dialog in
components/editor/rich-editor.tsx. Link openOnClick is false. There is no
document hyperlink inspector. Consume the equivalent current-main interfaces
after checking its actual revision; no future records, search, collaboration,
identity provisioning or other engineer's unfinished feature is required.

Acceptance criteria and mapped scenarios/cases/scripts, one per row:

1. Activating an existing text hyperlink offers a compact, accessible inspector
   showing the full destination with explicit Open and Copy actions. Merely
   inspecting never navigates. Cover owner/editor/viewer rendering and links
   spanning formatted text. Do not intercept dedicated page-reference blocks.
2. Validate at action time with the existing URL contract. Reject unsafe or
   malformed destinations. HTTP(S) opens with opener isolation; approved mailto,
   tel and internal page links retain their existing scheme semantics. No URL
   fetching, previews, analytics or new network permission is introduced.
3. Copy succeeds with clear feedback; denied/unavailable clipboard provides a
   selectable destination and honest failure feedback. No success on rejection.
   Test Unicode destinations, long URLs and HTML-like labels as plain text.
4. Support keyboard activation, labelled controls, Escape dismissal, focus
   return and pointer use. At narrow widths and actual browser zoom the
   inspector stays within the viewport. It adds no permanent toolbar clutter.
5. Inspection/open/copy create zero editor transactions, saves or history/undo
   changes. Preserve editor selection. Viewers get no editing controls; any
   existing Edit action remains restricted to current write permission. Dismiss
   on page/account/access change, removed link, or unmount; never display stale
   content from a previous document. Test rapid switches and permission loss.
6. Bound work to the activated link; no document-wide scan on each selection or
   pointer movement. Test large documents and repeated open/close. Preserve
   code-wrap, heading navigation, focus mode, table status, editing and normal
   browser link semantics through focused integrated regression checks.

Before implementation create six mapped Bug Off scenarios, cases and executable
manual scripts with preconditions, exact actions and expected results. Record
automated evidence separately from manual/staging outcomes. Include negative,
accessibility, permission, failure/retry and performance checks above, plus all
applicable normal repository checks; CI alone is not full acceptance.

Use dedicated component/helper/styles/tests and a minimal editor-host seam.
Read applicable AGENTS.md and installed Next guides before changing code. Avoid
other engineers' active host logic. Record the goal truthfully using the goal
tool; preserve unfinished prior goal scope if that tool cannot replace it.

HOLY-134 remains unfinished and held: qualified application release route,
fresh capacity proof and Product-issued serialized staging slot are required.
No shared heavy staging job or deployment is authorized by this assignment.
Progress this new story through local/browser/CI qualification, then request its
own release gates. Publication, merge and deployment follow their applicable
existing authorization boundaries. Do not alter the frozen c27 production
candidate, production DB settings, secrets, accounts or schedules.

Update BTF and all Bug Off mappings/results before advancing or parking. Raise
any concrete newly discovered dependency to Product; do not silently narrow
acceptance or begin another story.

Owner checkpoint: actual BTF story HOLY-137 is In Progress; Bug Off folder 162 maps AC1–AC6 to cases 2472–2477 respectively. Owner reports scenarios/manual scripts, preconditions and expected results saved before coding. No execution or acceptance pass claimed. Source audit and implementation are the sole active work; HOLY-134 remains held.
