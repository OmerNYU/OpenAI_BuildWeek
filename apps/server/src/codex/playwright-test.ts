import {
  validateGeneratedTestSource,
  type GeneratedTestSourceFailure
} from "../generated-test/index.js";

export type PlaywrightTestValidationResult =
  | { valid: true; errors: [] }
  | { valid: false; errors: string[]; failure: GeneratedTestSourceFailure };

export function validateGeneratedPlaywrightTest(
  content: string
): PlaywrightTestValidationResult {
  const validation = validateGeneratedTestSource(content);
  if (validation.valid) {
    return { valid: true, errors: [] };
  }

  return {
    valid: false,
    failure: validation.failure,
    errors: [
      validation.failure === "typescript_parse_failed"
        ? "Generated test must be valid TypeScript"
        : "Generated test must match the approved generated-test policy"
    ]
  };
}
