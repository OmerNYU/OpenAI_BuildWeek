import {
  cleanupIsolatedWorktree,
  prepareIsolatedWorktreeAttempt
} from "./worktree/index.js";
import { preflightRepository } from "./preflight.js";

export interface PreparedRepositoryWorkspace {
  sourceRepositoryPath: string;
  workspacePath: string;
}

export type RepositoryWorkspacePreparation =
  | { status: "prepared"; workspace: PreparedRepositoryWorkspace }
  | { status: "failed"; message: string };

export type RepositoryWorkspaceCleanup =
  | { status: "cleaned" }
  | { status: "failed"; message: string };

export interface RepositoryWorkspace {
  prepare(
    sourceRepositoryPath: string,
    investigationId: string
  ): Promise<RepositoryWorkspacePreparation>;

  cleanup(investigationId: string): Promise<RepositoryWorkspaceCleanup>;
}

interface RepositoryWorkspaceOperations {
  preflightRepository: typeof preflightRepository;
  prepareIsolatedWorktreeAttempt: typeof prepareIsolatedWorktreeAttempt;
  cleanupIsolatedWorktree: typeof cleanupIsolatedWorktree;
}

const defaultOperations: RepositoryWorkspaceOperations = {
  preflightRepository,
  prepareIsolatedWorktreeAttempt,
  cleanupIsolatedWorktree
};

export class PassThroughRepositoryWorkspace implements RepositoryWorkspace {
  async prepare(
    sourceRepositoryPath: string,
    investigationId: string
  ): Promise<RepositoryWorkspacePreparation> {
    void investigationId;
    return {
      status: "prepared",
      workspace: {
        sourceRepositoryPath,
        workspacePath: sourceRepositoryPath
      }
    };
  }

  async cleanup(investigationId: string): Promise<RepositoryWorkspaceCleanup> {
    void investigationId;
    return { status: "cleaned" };
  }
}

export class LocalRepositoryWorkspace implements RepositoryWorkspace {
  constructor(
    private readonly operations: RepositoryWorkspaceOperations = defaultOperations
  ) {}

  async prepare(
    sourceRepositoryPath: string,
    investigationId: string
  ): Promise<RepositoryWorkspacePreparation> {
    try {
      const preflight = await this.operations.preflightRepository(sourceRepositoryPath);
      if (preflight.status !== "ready") {
        return preparationFailed();
      }

      const worktree = await this.operations.prepareIsolatedWorktreeAttempt(
        preflight.repositoryPath,
        investigationId
      );
      if (worktree.status !== "prepared") {
        if (worktree.cleanupAuthorized) {
          await this.operations.cleanupIsolatedWorktree(investigationId).catch(() => undefined);
        }
        return preparationFailed();
      }

      return {
        status: "prepared",
        workspace: {
          sourceRepositoryPath: preflight.repositoryPath,
          workspacePath: worktree.worktreePath
        }
      };
    } catch {
      return preparationFailed();
    }
  }

  async cleanup(investigationId: string): Promise<RepositoryWorkspaceCleanup> {
    try {
      const cleanup = await this.operations.cleanupIsolatedWorktree(investigationId);
      return cleanup.status === "cleaned" ? cleanup : cleanupFailed();
    } catch {
      return cleanupFailed();
    }
  }
}

function preparationFailed(): RepositoryWorkspacePreparation {
  return {
    status: "failed",
    message: "The repository could not be prepared safely."
  };
}

function cleanupFailed(): RepositoryWorkspaceCleanup {
  return {
    status: "failed",
    message: "The repository workspace could not be cleaned up safely."
  };
}
