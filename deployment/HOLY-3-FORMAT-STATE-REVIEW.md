# HOLY-3 formatting selection checkpoint

The formatting toolbar now derives state from the actual selected text or current typing marks. Bold/italic/underline/strike expose mixed state through aria-pressed, a dotted visual treatment and a mixed-formatting tooltip. Colour and highlight selectors show explicit disabled Mixed options for heterogeneous ranges. Highlight is controlled by selection state instead of retaining an unrelated previous selection's UI value. No synthetic mixed value is written into the document.

The collector visits only the selected range, uses constant-size aggregate state, ignores unselected adjacent text and respects an explicitly cleared stored-mark set at a caret. It does not dispatch transactions, modify structure or create history.

Evidence: six focused cases cover uniform compatible styles, partial marks, mixed palettes, adjacent exclusions, multiple paragraphs, typing marks/clear state and non-text atoms. Combined local regression: 331 passed; sixteen opt-in service cases were skipped in that default run. Typecheck and production build passed. Native local browser selection of partly italic/highlighted synthetic text exposed mixed Italic and Mixed highlights; selecting plain text reset the controls to default/none. Both synthetic style changes were undone. Screenshot: surrounding workspace outputs/holy-sheet/overnight-20261026/HOLY-3-mixed-formatting.png.

Full keyboard/touch/screen-reader and browser-matrix acceptance remains open. No claim of staging identity, AC2/3/22 completion or BugOff acceptance is made by these client checks.
