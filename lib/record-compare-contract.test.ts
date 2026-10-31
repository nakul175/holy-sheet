import { expect, it } from "vitest";
import { acceptedRecordComparison, buildRecordComparison, compareValueText, type CompareSide } from "./record-compare-contract";

const left = "00000000-0000-4000-8000-0000000000a1";
const middle = "00000000-0000-4000-8000-0000000000a2";
const right = "00000000-0000-4000-8000-0000000000a3";

function side(id: string, name: string, fields: CompareSide["fields"], collection = "organisations"): CompareSide {
  return { id, name, collection, state: "active", version: 1, fields };
}

it("marks changed, only-left, only-right and same values", () => {
  const comparison = buildRecordComparison([
    side(left, "Left", [
      { key: "name", label: "Name", kind: "text", value: "Left" },
      { key: "state", label: "State", kind: "text", value: "active" },
      { key: "core:notes", label: "Notes", kind: "long-text", value: "Left only note" },
      { key: "core:registration", label: "Registration reference", kind: "text", value: "   " },
      { key: "core:active", label: "Active", kind: "boolean", value: false },
    ]),
    side(middle, "Middle", [
      { key: "name", label: "Name", kind: "text", value: "Middle" },
      { key: "state", label: "State", kind: "text", value: "active" },
      { key: "core:notes", label: "Notes", kind: "long-text", value: "" },
      { key: "core:middle", label: "Middle only", kind: "text", value: "Centre" },
      { key: "core:active", label: "Active", kind: "boolean", value: false },
    ]),
    side(right, "Right", [
      { key: "name", label: "Name", kind: "text", value: "Right" },
      { key: "state", label: "State", kind: "text", value: "archived" },
      { key: "core:registration", label: "Registration reference", kind: "text", value: "REG-9" },
      { key: "core:active", label: "Active", kind: "boolean", value: false },
    ], "accounts"),
  ]);
  expect(comparison.mixedCollections).toBe(true);
  expect(comparison.fields.map((field) => [field.key, field.status])).toEqual([
    ["name", "changed"],
    ["state", "changed"],
    ["core:active", "same"],
    ["core:middle", "changed"],
    ["core:notes", "only-left"],
    ["core:registration", "only-right"],
  ]);
  expect(comparison.fields.find((field) => field.key === "core:notes")?.values[1]).toEqual({ recordId: middle, present: false });
  expect(comparison.fields.find((field) => field.key === "core:active")?.values[0].value).toBe(false);
});

it("drops unknown neighbour keys instead of rendering them", () => {
  const clean = buildRecordComparison([
    side(left, "Left", [{ key: "name", label: "Name", kind: "text", value: "Left" }, { key: "partner", label: "Partner", kind: "record", value: { id: right, name: "Visible partner", state: "active" } }]),
    side(right, "Right", [{ key: "name", label: "Name", kind: "text", value: "Right" }, { key: "partner", label: "Partner", kind: "record", value: [] }]),
  ]);
  expect(compareValueText({ id: right, name: "Visible partner", state: "active", secret: "hidden-salary-value" })).toBe("Visible partner");
  expect(JSON.stringify(acceptedRecordComparison({ ...clean, secretNeighbor: "hidden-salary-value" }))).not.toContain("hidden-salary-value");
  expect(acceptedRecordComparison({
    ...clean,
    fields: clean.fields.map((field) => field.key === "partner" ? { ...field, values: [{ recordId: left, present: true, value: { id: right, name: "Visible partner", state: "active", secret: "hidden-salary-value" } }, field.values[1]] } : field),
  })).toBeNull();
});
