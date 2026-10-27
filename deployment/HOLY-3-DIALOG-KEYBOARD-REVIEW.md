# HOLY-3 dialog keyboard checkpoint

Shared dialogs capture their return-focus target before autofocus children mount. Escape closes only the active dialog, respects IME/already-handled events and restores focus to the still-connected opener. Tab wraps around eligible controls, excluding disabled/hidden/inert/negative-tab elements and content inside closed details. Native editable regions and summary controls are included. Existing callers retain the same shared export/API.

Five focused DOM cases cover autofocus restoration, forward/reverse focus wrapping, nested Escape, composition/handled events and ordinary non-boundary keys. Combined regression: 370 local tests; sixteen opt-in service cases skipped in that default run. Typecheck and production build passed. Native local browser rehearsal opened Paste literal text, verified Shift+Tab reaches Cancel rather than disabled Insert, Tab wraps to Close and Escape returns to Paste literal text with the document still saved. Screenshot: surrounding workspace outputs/holy-sheet/overnight-20261026/HOLY-3-dialog-keyboard.png.

Full browser/touch/screen-reader and integrated acceptance remain open. This is not complete AC2/22, HOLY-3 or BugOff acceptance.
