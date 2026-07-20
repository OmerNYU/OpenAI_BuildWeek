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
    expect(operations.prepareIsolatedWorktree).not.toHaveBeenCalled();
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
    expect(operations.prepareIsolatedWorktree).toHaveBeenCalledWith(
      canonicalSourcePath,
      "investigation-31"
    );
    expect(operations.cleanupIsolatedWorktree).not.toHaveBeenCalled();
  });

  it("sanitizes a preparation failure without independently cleaning a workspace", async () => {
    const operations = createOperations({
      preparation: failedPreparation("invalid_destination")
    });
    const workspace = new LocalRepositoryWorkspace(operations);

    await expect(workspace.prepare("C:/source", "investigation-31")).resolves.toEqual(preparationFailure());
    expect(operations.cleanupIsolatedWorktree).not.toHaveBeenCalled();
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
  preparation?: Awaited<ReturnType<typeof import("../src/repository/worktree/index.js").prepareIsolatedWorktree>>;
  cleanup?: Awaited<ReturnType<typeof import("../src/repository/index.js").cleanupIsolatedWorktree>>;
} = {}) {
  return {
    preflightRepository: vi.fn(async () => options.preflight ?? ({
      status: "ready" as const,
      repositoryPath: "C:/canonical/source"
    })),
    prepareIsolatedWorktree: vi.fn(async () => options.preparation ?? ({
      status: "prepared" as const,
      investigationId: "investigation-31",
      sourceRepositoryPath: "C:/canonical/source",
      worktreePath: "C:/FailSpec/worktrees/investigation-31"
    })),
    cleanupIsolatedWorktree: vi.fn(async () => options.cleanup ?? ({ status: "cleaned" as const }))
  };
}

function failedPreparation(failure: "invalid_destination" | "creation_failed" | "metadata_failed") {
  return { status: "failed" as const, failure: { code: failure } };
}

function preparationFailure() {
  return {
    status: "failed",
    message: "The repository could not be prepared safely."
  };
}
