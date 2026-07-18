import type {
  GeneratedTestStagingFailureCode,
  RepositoryPreflightFailureCode,
  WorktreeFailureCode
} from "@failspec/contracts";

type FailureCode =
  | GeneratedTestStagingFailureCode
  | RepositoryPreflightFailureCode
  | WorktreeFailureCode;

const failureMessages: Record<FailureCode, string> = {
  unsafe_path: "Repository path is not supported.",
  not_git_repository: "Repository must be a Git repository.",
  dirty_repository: "Repository has uncommitted changes.",
  unsupported_framework: "Repository framework is not supported.",
  playwright_not_configured: "Repository must have Playwright configured.",
  unsupported_package_manager: "Repository package manager is not supported.",
  unsupported_script: "Repository does not expose a supported script.",
  inspection_failed: "Repository preflight could not be completed.",
  invalid_destination: "Worktree destination is not supported.",
  creation_failed: "Worktree could not be prepared.",
  metadata_failed: "Worktree metadata could not be recorded.",
  cleanup_failed: "Worktree cleanup could not be completed.",
  invalid_encoding: "Generated test must use UTF-8 text.",
  file_too_large: "Generated test exceeds the allowed size.",
  typescript_parse_failed: "Generated test is not valid TypeScript.",
  disallowed_import: "Generated test uses an unsupported import.",
  disallowed_api: "Generated test uses an unsupported API.",
  write_failed: "Generated test could not be staged."
};

export function failureMessageFor(code: FailureCode): string {
  return failureMessages[code];
}
