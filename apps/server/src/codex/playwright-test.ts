export interface PlaywrightTestValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateGeneratedPlaywrightTest(
  content: string
): PlaywrightTestValidationResult {
  const errors: string[] = [];

  if (!/["']@playwright\/test["']/.test(content)) {
    errors.push("Generated test must import @playwright/test");
  }

  if (!/\btest\s*\(/.test(content)) {
    errors.push("Generated test must declare a Playwright test");
  }

  if (!/\.(?:goto|click|fill|check|selectOption|press)\s*\(/.test(content)) {
    errors.push("Generated test must include a user interaction");
  }

  if (!/\bexpect\s*\(/.test(content)) {
    errors.push("Generated test must include an assertion");
  }

  return { valid: errors.length === 0, errors };
}
