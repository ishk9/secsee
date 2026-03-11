import type {
  SchemaField,
  ValidationContext,
  ValidationResult,
} from "../../../types/index.js";
import { BaseValidator } from "./chain.js";

export class BodySchemaValidator extends BaseValidator {
  protected async validate(
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const { endpoint, response } = context;

    const matchingStatus = endpoint.response.statusCodes.find(
      (sc) => sc.code === response.status,
    );

    if (!matchingStatus) {
      return {
        validatorName: "BodySchemaValidator",
        passed: true,
        message: `No schema defined for status ${response.status}, skipping body validation`,
      };
    }

    const errors = validateObject(
      response.body as Record<string, unknown> | null | undefined,
      matchingStatus.bodySchema,
      "",
    );

    return {
      validatorName: "BodySchemaValidator",
      passed: errors.length === 0,
      message:
        errors.length === 0
          ? "Response body matches schema"
          : `Schema validation failed: ${errors.join("; ")}`,
      details: errors.length > 0 ? errors : undefined,
    };
  }
}

function validateObject(
  value: unknown,
  schema: Record<string, SchemaField>,
  path: string,
): string[] {
  const errors: string[] = [];

  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    if (Object.keys(schema).length > 0) {
      errors.push(`${path || "root"}: expected object, got ${typeof value}`);
    }
    return errors;
  }

  const obj = value as Record<string, unknown>;

  for (const [key, field] of Object.entries(schema)) {
    const fieldPath = path ? `${path}.${key}` : key;
    const fieldValue = obj[key];

    if (fieldValue === undefined) {
      if (field.required) {
        errors.push(`${fieldPath}: required field missing`);
      }
      continue;
    }

    errors.push(...validateField(fieldValue, field, fieldPath));
  }

  return errors;
}

function validateField(
  value: unknown,
  field: SchemaField,
  path: string,
): string[] {
  const errors: string[] = [];

  if (value === null || value === undefined) {
    if (field.required) {
      errors.push(`${path}: required but got ${value}`);
    }
    return errors;
  }

  const actualType = Array.isArray(value) ? "array" : typeof value;

  if (field.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array, got ${actualType}`);
      return errors;
    }
    if (field.children) {
      for (let i = 0; i < value.length; i++) {
        errors.push(
          ...validateObject(
            value[i] as Record<string, unknown>,
            field.children,
            `${path}[${i}]`,
          ),
        );
      }
    }
  } else if (field.type === "object") {
    if (actualType !== "object") {
      errors.push(`${path}: expected object, got ${actualType}`);
      return errors;
    }
    if (field.children) {
      errors.push(
        ...validateObject(
          value as Record<string, unknown>,
          field.children,
          path,
        ),
      );
    }
  } else if (actualType !== field.type) {
    errors.push(`${path}: expected ${field.type}, got ${actualType}`);
  }

  return errors;
}
