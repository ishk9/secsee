import type { ValidationContext, ValidationResult } from "../../../types/index.js";
import { StatusCodeValidator } from "./status-code.js";
import { HeaderValidator } from "./headers.js";
import { BodySchemaValidator } from "./body-schema.js";
import { DbStateValidator } from "./db-state.js";

export interface IValidationHandler {
  setNext(handler: IValidationHandler): IValidationHandler;
  handle(context: ValidationContext): Promise<ValidationResult[]>;
}

export abstract class BaseValidator implements IValidationHandler {
  private nextHandler?: IValidationHandler;

  setNext(handler: IValidationHandler): IValidationHandler {
    this.nextHandler = handler;
    return handler;
  }

  async handle(context: ValidationContext): Promise<ValidationResult[]> {
    const result = await this.validate(context);
    const results = [result];
    if (this.nextHandler) {
      results.push(...(await this.nextHandler.handle(context)));
    }
    return results;
  }

  protected abstract validate(
    context: ValidationContext,
  ): Promise<ValidationResult>;
}

export function buildValidationChain(): IValidationHandler {
  const status = new StatusCodeValidator();
  const headers = new HeaderValidator();
  const body = new BodySchemaValidator();
  const db = new DbStateValidator();
  status.setNext(headers).setNext(body).setNext(db);
  return status;
}
