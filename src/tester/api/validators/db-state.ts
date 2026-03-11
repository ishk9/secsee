import type {
  DbDiff,
  ValidationContext,
  ValidationResult,
} from "../../../types/index.js";
import { BaseValidator } from "./chain.js";

export class DbStateValidator extends BaseValidator {
  protected async validate(
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const { endpoint, dbBefore, dbAfter } = context;
    const dbOps = endpoint.dbInteractions;

    if (dbOps.length === 0 || !dbBefore || !dbAfter) {
      return {
        validatorName: "DbStateValidator",
        passed: true,
        message: "No DB interactions to validate",
      };
    }

    const diff = computeDiff(dbBefore.rows, dbAfter.rows);
    const errors: string[] = [];

    for (const op of dbOps) {
      switch (op.operation) {
        case "create":
          if (diff.inserted.length === 0) {
            errors.push(
              `Expected insertion in ${op.table} but no rows were inserted`,
            );
          }
          break;
        case "delete":
          if (diff.deleted.length === 0) {
            errors.push(
              `Expected deletion in ${op.table} but no rows were deleted`,
            );
          }
          break;
        case "update":
          if (diff.modified.length === 0) {
            errors.push(
              `Expected update in ${op.table} but no rows were modified`,
            );
          }
          break;
        case "read":
          break;
      }
    }

    return {
      validatorName: "DbStateValidator",
      passed: errors.length === 0,
      message:
        errors.length === 0
          ? "DB state changes match expected operations"
          : `DB validation failed: ${errors.join("; ")}`,
      details: { diff, errors },
    };
  }
}

function computeDiff(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): DbDiff {
  const beforeKeys = new Map<string, Record<string, unknown>>();
  for (const row of before) {
    const key = JSON.stringify(row);
    beforeKeys.set(key, row);
  }

  const afterKeys = new Map<string, Record<string, unknown>>();
  for (const row of after) {
    const key = JSON.stringify(row);
    afterKeys.set(key, row);
  }

  const inserted: Record<string, unknown>[] = [];
  const deleted: Record<string, unknown>[] = [];

  for (const [key, row] of afterKeys) {
    if (!beforeKeys.has(key)) {
      inserted.push(row);
    }
  }

  for (const [key, row] of beforeKeys) {
    if (!afterKeys.has(key)) {
      deleted.push(row);
    }
  }

  const modified: { before: Record<string, unknown>; after: Record<string, unknown> }[] = [];

  if (deleted.length > 0 && inserted.length > 0) {
    const idField = findIdField(deleted[0]);
    if (idField) {
      const deletedById = new Map(
        deleted.map((r) => [String(r[idField]), r]),
      );
      const remainingInserted: Record<string, unknown>[] = [];

      for (const ins of inserted) {
        const id = String(ins[idField]);
        const del = deletedById.get(id);
        if (del) {
          modified.push({ before: del, after: ins });
          deletedById.delete(id);
        } else {
          remainingInserted.push(ins);
        }
      }

      return {
        inserted: remainingInserted,
        deleted: [...deletedById.values()],
        modified,
      };
    }
  }

  return { inserted, deleted, modified };
}

function findIdField(row: Record<string, unknown>): string | undefined {
  const candidates = ["id", "_id", "uuid", "ID"];
  return candidates.find((c) => c in row);
}
