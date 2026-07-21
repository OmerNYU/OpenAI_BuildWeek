import { validateGeneratedTestSource } from "../generated-test/index.js";

export interface PlaywrightTestValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateGeneratedPlaywrightTest(
  content: string
): PlaywrightTestValidationResult {
  const validation = validateGeneratedTestSource(content);
  if (validation.valid) {
    return { valid: true, errors: [] };
  }

  return {
    valid: false,
    errors: [
      validation.failure === "typescript_parse_failed"
        ? "Generated test must be valid TypeScript"
        : "Generated test must match the approved generated-test policy"
    ]
  };
}
