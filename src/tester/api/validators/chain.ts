import type { IValidationHandler } from "./base.js";
import { StatusCodeValidator } from "./status-code.js";
import { HeaderValidator } from "./headers.js";
import { BodySchemaValidator } from "./body-schema.js";
import { DbStateValidator } from "./db-state.js";

export type { IValidationHandler } from "./base.js";
export { BaseValidator } from "./base.js";

export function buildValidationChain(): IValidationHandler {
  const status = new StatusCodeValidator();
  const headers = new HeaderValidator();
  const body = new BodySchemaValidator();
  const db = new DbStateValidator();
  status.setNext(headers).setNext(body).setNext(db);
  return status;
}
