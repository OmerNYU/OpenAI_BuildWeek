import { describe, expect, it, vi } from "vitest";
import {
  LocalRepositoryWorkspace,
  PassThroughRepositoryWorkspace
} from "../src/repository/repository-workspace.js";

describe("PassThroughRepositoryWorkspace", () => {
  it("deterministically uses arbitrary submitted paths without repository operations", async () => {
    const workspace = new PassThroughRepositoryWorkspace();

    await expect(workspace.prepare("not-a-git-repository", "investigation-31")).resolves.toEqual({
      status: "prepared",
      workspace: {
        sourceRepositoryPath: "not-a-git-repository",
        workspacePath: "not-a-git-repository"
      }
    });
    await expect(workspace.cleanup("investigation-31")).resolves.toEqual({ status: "cleaned" });
  });
});

describe("LocalRepositoryWorkspace", () => {
  it("sanitizes a preflight failure without preparing or cleaning a worktree", async () => {
    const operations = createOperations({
      preflight: { status: "unsupported", failure: { code: "not_git_repository" } }
    });
    const workspace = new LocalRepositoryWorkspace(operations);

    await expect(workspace.prepare("C:/source", "investigation-31")).resolves.toEqual(preparationFailure());
    expect(operations.prepareIsolatedWorktreeAttempt).not.toHaveBeenCalled();
    expect(operations.cleanupIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("prepares with the canonical preflight path and returns the isolated workspace", async () => {
    const canonicalSourcePath = "C:/canonical/source";
    const worktreePath = "C:/FailSpec/worktrees/investigation-31";
    const operations = createOperations({
      preflight: { status: "ready", repositoryPath: canonicalSourcePath },
      preparation: {
        status: "prepared",
        investigationId: "investigation-31",
        sourceRepositoryPath: canonicalSourcePath,
        worktreePath
      }
    });
    const workspace = new LocalRepositoryWorkspace(operations);

    await expect(workspace.prepare("C:/source", "investigation-31")).resolves.toEqual({
      status: "prepared",
      workspace: { sourceRepositoryPath: canonicalSourcePath, workspacePath: worktreePath }
    });
    expect(operations.prepareIsolatedWorktreeAttempt).toHaveBeenCalledWith(
      canonicalSourcePath,
      "investigation-31"
    );
    expect(operations.cleanupIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("does not roll back an invalid destination", async () => {
    const operations = createOperations({
      attempt: failedAttempt("invalid_destination", false)
    });
    const workspace = new LocalRepositoryWorkspace(operations);

    await expect(workspace.prepare("C:/source", "investigation-31")).resolves.toEqual(preparationFailure());
    expect(operations.cleanupIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("does not roll back a pre-existing worktree destination", async () => {
    const operations = createOperations({
      attempt: failedAttempt("invalid_destination", false)
    });
    const workspace = new LocalRepositoryWorkspace(operations);

    await expect(workspace.prepare("C:/source", "investigation-31")).resolves.toEqual(preparationFailure());
    expect(operations.cleanupIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("does not roll back a pre-existing ownership record", async () => {
    const operations = createOperations({
      attempt: failedAttempt("invalid_destination", false)
    });
    const workspace = new LocalRepositoryWorkspace(operations);

    await expect(workspace.prepare("C:/source", "investigation-31")).resolves.toEqual(preparationFailure());
    expect(operations.cleanupIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("does not roll back a failure before initial ownership metadata exists", async () => {
    const operations = createOperations({
      attempt: failedAttempt("creation_failed", false)
    });
    const workspace = new LocalRepositoryWorkspace(operations);

    await expect(workspace.prepare("C:/source", "investigation-31")).resolves.toEqual(preparationFailure());
    expect(operations.cleanupIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("rolls back once after Git creation fails following metadata creation", async () => {
    const operations = createOperations({
      attempt: failedAttempt("creation_failed", true)
    });
    const workspace = new LocalRepositoryWorkspace(operations);

    await expect(workspace.prepare("C:/source", "investigation-31")).resolves.toEqual(preparationFailure());
    expect(operations.cleanupIsolatedWorktree).toHaveBeenCalledTimes(1);
    expect(operations.cleanupIsolatedWorktree).toHaveBeenCalledWith("investigation-31");
  });

  it("rolls back once after the final metadata update fails", async () => {
    const operations = createOperations({
      attempt: failedAttempt("metadata_failed", true)
    });
    const workspace = new LocalRepositoryWorkspace(operations);

    await expect(workspace.prepare("C:/source", "investigation-31")).resolves.toEqual(preparationFailure());
    expect(operations.cleanupIsolatedWorktree).toHaveBeenCalledTimes(1);
  });

  it("keeps an unrecognized failed Git-add rollback private", async () => {
    const operations = createOperations({
      attempt: failedAttempt("creation_failed", true),
      cleanup: { status: "failed", failure: { code: "cleanup_failed" } }
    });
    const workspace = new LocalRepositoryWorkspace(operations);

    const result = await workspace.prepare("C:/source", "investigation-31");

    expect(result).toEqual(preparationFailure());
    expect(JSON.stringify(result)).not.toContain("creation_failed");
    expect(JSON.stringify(result)).not.toContain("cleanup_failed");
    expect(operations.cleanupIsolatedWorktree).toHaveBeenCalledTimes(1);
  });

  it("maps cleanup results to the sanitized orchestration result", async () => {
    const cleaned = new LocalRepositoryWorkspace(createOperations());
    const failed = new LocalRepositoryWorkspace(createOperations({
      cleanup: { status: "failed", failure: { code: "cleanup_failed" } }
    }));

    await expect(cleaned.cleanup("investigation-31")).resolves.toEqual({ status: "cleaned" });
    await expect(failed.cleanup("investigation-31")).resolves.toEqual({
      status: "failed",
      message: "The repository workspace could not be cleaned up safely."
    });
  });
});

function createOperations(options: {
  preflight?: Awaited<ReturnType<typeof import("../src/repository/index.js").preflightRepository>>;
  attempt?: Awaited<ReturnType<typeof import("../src/repository/worktree/index.js").prepareIsolatedWorktreeAttempt>>;
  cleanup?: Awaited<ReturnType<typeof import("../src/repository/index.js").cleanupIsolatedWorktree>>;
} = {}) {
  return {
    preflightRepository: vi.fn(async () => options.preflight ?? ({
      status: "ready" as const,
      repositoryPath: "C:/canonical/source"
    })),
    prepareIsolatedWorktreeAttempt: vi.fn(async () => options.attempt ?? ({
      status: "prepared" as const,
      sourceRepositoryPath: "C:/canonical/source",
      worktreePath: "C:/FailSpec/worktrees/investigation-31"
    })),
    cleanupIsolatedWorktree: vi.fn(async () => options.cleanup ?? ({ status: "cleaned" as const }))
  };
}

function failedAttempt(
  failure: "invalid_destination" | "creation_failed" | "metadata_failed",
  cleanupAuthorized: boolean
) {
  return { status: "failed" as const, failure, cleanupAuthorized };
}

function preparationFailure() {
  return {
    status: "failed",
    message: "The repository could not be prepared safely."
  };
}
