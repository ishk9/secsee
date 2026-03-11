import type { ValidationContext, ValidationResult } from "../../../types/index.js";
import { BaseValidator } from "./chain.js";

export class StatusCodeValidator extends BaseValidator {
  protected async validate(
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const { endpoint, response } = context;
    const allowed = endpoint.response.statusCodes.map((sc) => sc.code);
    const passed = allowed.includes(response.status);

    return {
      validatorName: "StatusCodeValidator",
      passed,
      message: passed
        ? `Status ${response.status} is expected`
        : `Status ${response.status} not in expected codes [${allowed.join(", ")}]`,
      details: { expected: allowed, actual: response.status },
    };
  }
}
