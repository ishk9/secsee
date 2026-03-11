import type { ValidationContext, ValidationResult } from "../../../types/index.js";
import { BaseValidator } from "./chain.js";

export class HeaderValidator extends BaseValidator {
  protected async validate(
    context: ValidationContext,
  ): Promise<ValidationResult> {
    const { endpoint, response } = context;
    const expectedContentType = endpoint.request.contentType;

    const actualContentType = (
      response.headers["content-type"] ?? ""
    ).toLowerCase();

    const passed =
      !expectedContentType ||
      actualContentType.startsWith(expectedContentType.toLowerCase());

    return {
      validatorName: "HeaderValidator",
      passed,
      message: passed
        ? `Content-Type header matches expected`
        : `Expected content-type "${expectedContentType}", got "${actualContentType}"`,
      details: { expected: expectedContentType, actual: actualContentType },
    };
  }
}
