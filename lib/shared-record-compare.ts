import { z } from "zod";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { buildRecordComparison, type CompareSide, type RecordComparison } from "./record-compare-contract";
import { recordValueEmpty, type RecordField } from "./shared-record-types";
import { SharedRecordRepository, type RecordContext, type Stored } from "./shared-records";

const requestSchema = z.object({ recordIds: z.array(z.string().uuid()).min(2).max(4) }).strict();

/**
 * Side-by-side field comparison of records the member can already view.
 * Forbidden fields and hidden neighbour records are omitted entirely.
 * Trash uses the same read rule as opening a record: a trashed id is unavailable.
 */
export class SharedRecordCompareRepository extends SharedRecordRepository {
  async compare(ctx: RecordContext, input: unknown): Promise<RecordComparison> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new DocumentError("Review the record comparison.", "record_compare_validation", 400);
    if (new Set(parsed.data.recordIds).size !== parsed.data.recordIds.length) throw new DocumentError("Choose distinct records.", "record_compare_validation", 400);
    return this.transaction(ctx, async (tx) => {
      const sides: CompareSide[] = [];
      for (const recordId of parsed.data.recordIds) {
        const stored = await this.raw(tx, ctx, recordId, "view");
        if (sides.some((side) => side.id === stored.id)) throw new DocumentError("Choose distinct records.", "record_compare_validation", 400);
        sides.push(await this.side(tx, ctx, stored));
      }
      return buildRecordComparison(sides);
    });
  }

  private async side(tx: Sql, ctx: RecordContext, stored: Stored): Promise<CompareSide> {
    const fields = await this.fields(tx, ctx, stored.collection);
    const storedValues = await this.filtered(tx, ctx, stored.collection, stored.field_values, fields);
    const projected = await this.projectCalculated(tx, ctx, stored.collection, storedValues, fields);
    const comparable: CompareSide["fields"] = [
      { key: "name", label: "Name", kind: "text", value: stored.name },
      { key: "state", label: "State", kind: "text", value: stored.state === "archived" ? "archived" : "active" },
    ];
    if (stored.parent_organisation_id) {
      try {
        const parent = await this.raw(tx, ctx, stored.parent_organisation_id);
        comparable.push({
          key: "parentOrganisation",
          label: "Parent organisation",
          kind: "record",
          value: { id: parent.id, name: parent.name, state: parent.state === "archived" ? "archived" : "active" },
        });
      } catch (error) {
        if (!(error instanceof DocumentError && (error.status === 403 || error.status === 404))) throw error;
      }
    }
    for (const field of fields) {
      if (!(await this.fieldAllowed(tx, ctx, stored.collection, field, "view"))) continue;
      const value = await this.expose(tx, ctx, field, projected.values[field.key]);
      if (field.deprecated && recordValueEmpty(value)) continue;
      comparable.push({ key: field.key, label: field.label, kind: field.kind, value });
    }
    const seen = new Set(comparable.map((field) => field.key));
    for (const calculated of projected.calculated) {
      if (seen.has(calculated.fieldKey)) continue;
      const kind = typeof calculated.value === "number" ? "number" : typeof calculated.value === "boolean" ? "boolean" : "text";
      comparable.push({ key: calculated.fieldKey, label: calculated.label, kind, value: projected.values[calculated.fieldKey] });
    }
    return {
      id: stored.id,
      name: stored.name,
      collection: stored.collection,
      state: stored.state === "archived" ? "archived" : "active",
      version: stored.version,
      fields: comparable,
    };
  }

  private async expose(tx: Sql, ctx: RecordContext, field: RecordField, value: unknown) {
    if (field.kind !== "record") return value;
    if (!Array.isArray(value)) return undefined;
    const links: { id: string; name: string; state: "active" | "archived" }[] = [];
    for (const item of value) {
      if (typeof item !== "string") continue;
      try {
        const target = await this.raw(tx, ctx, item);
        links.push({ id: target.id, name: target.name, state: target.state === "archived" ? "archived" : "active" });
      } catch (error) {
        if (!(error instanceof DocumentError && (error.status === 403 || error.status === 404))) throw error;
      }
    }
    return links;
  }
}
