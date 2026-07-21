import type { CodexFailureCategory } from "@failspec/contracts";

export class CodexFailure extends Error {
  constructor(readonly category: CodexFailureCategory) {
    super(category);
  }
}
