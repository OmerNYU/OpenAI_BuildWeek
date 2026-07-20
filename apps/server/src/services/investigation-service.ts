import { randomUUID } from "node:crypto";
import {
  type Investigation,
  type InvestigationRequest,
  type InvestigationStatus
} from "@failspec/contracts";
import {
  assertTransition,
  canTransition,
  type CodexAdapter,
  type RunnerAdapter
} from "@failspec/core";
import type { InvestigationStore } from "../storage/investigation-store.js";
import type { WorkflowScheduler } from "../scheduling/workflow-scheduler.js";
import type { RepositoryWorkspace } from "../repository/repository-workspace.js";

export class InvestigationService {
  constructor(
    private readonly store: InvestigationStore,
    private readonly codexAdapter: CodexAdapter,
    private readonly runnerAdapter: RunnerAdapter,
    private readonly scheduler: WorkflowScheduler,
    private readonly repositoryWorkspace: RepositoryWorkspace
  ) {}

  async create(request: InvestigationRequest): Promise<Investigation> {
    const now = new Date().toISOString();
    const investigation: Investigation = {
      id: randomUUID(),
      request,
      status: "created",
      timeline: [{ status: "created", at: now, message: "Investigation created." }],
      createdAt: now,
      updatedAt: now
    };

    await this.store.save(investigation);
    const initialSnapshot = structuredClone(investigation);
    const workflowInvestigation = structuredClone(investigation);
    this.scheduler.schedule(async () => {
      await this.runWorkflow(workflowInvestigation);
    });
    return initialSnapshot;
  }

  getById(id: string): Promise<Investigation | undefined> {
    return this.store.getById(id);
  }

  private async runWorkflow(investigation: Investigation): Promise<Investigation> {
    let lastPersisted = structuredClone(investigation);
    let preparedWorkspace = false;
    let cleanupAttempted = false;

    const persist = async () => {
      await this.store.save(investigation);
      lastPersisted = structuredClone(investigation);
    };

    const transition = async (status: InvestigationStatus, message: string) => {
      assertTransition(investigation.status, status);
      investigation.status = status;
      investigation.updatedAt = new Date().toISOString();
      investigation.timeline.push({ status, at: investigation.updatedAt, message });
      await persist();
    };

    const cleanup = async (): Promise<boolean> => {
      cleanupAttempted = true;
      try {
        return (await this.repositoryWorkspace.cleanup(investigation.id)).status === "cleaned";
      } catch {
        return false;
      }
    };

    try {
      await transition("preflight", "Repository preflight started.");
      const preparation = await this.repositoryWorkspace.prepare(
        investigation.request.repositoryPath,
        investigation.id
      );
      if (preparation.status !== "prepared") {
        throw new WorkflowFailure("The repository could not be prepared safely.");
      }
      preparedWorkspace = true;
      const workspaceRequest = {
        ...investigation.request,
        repositoryPath: preparation.workspace.workspacePath
      };
      await transition("analyzing", "Analyzing the reported failure.");
      const analysis = await this.codexAdapter.analyze(workspaceRequest);
      investigation.hypothesis = analysis.hypothesis;
      investigation.analysisEvidence = analysis.evidence;
      await transition("hypothesis_ready", "Reproduction hypothesis is ready.");
      await transition("generating_test", "Generating a regression test.");
      const generatedTest = await this.codexAdapter.generateTest({
        request: workspaceRequest,
        hypothesis: analysis.hypothesis
      });
      investigation.generatedTestContent = generatedTest.content;
      investigation.generatedTestPath = generatedTest.path;
      await transition("test_ready", "Generated test is ready.");
      await transition("executing", "Running the generated test.");
      const runnerOutput = await this.runnerAdapter.run({
        repositoryPath: preparation.workspace.workspacePath,
        generatedTest
      });
      investigation.execution = runnerOutput.execution;
      investigation.verdictExplanation = "The deterministic mock runner returned the expected reproduction signal.";
      investigation.recommendedNextStep = "Review the generated regression test before running it against a real repository.";
      if (!(await cleanup())) {
        throw new WorkflowFailure("The repository workspace could not be cleaned up safely.");
      }
      await transition("verified", "Mock reproduction verified.");
      return investigation;
    } catch (error: unknown) {
      if (preparedWorkspace && !cleanupAttempted) {
        await cleanup();
      }
      return this.recordWorkflowError(lastPersisted, investigation, error);
    }
  }

  private async recordWorkflowError(
    lastPersisted: Investigation,
    current: Investigation,
    error: unknown
  ): Promise<Investigation> {
    const investigation = structuredClone(lastPersisted);
    investigation.hypothesis ??= current.hypothesis;
    investigation.analysisEvidence ??= current.analysisEvidence;
    investigation.generatedTestPath ??= current.generatedTestPath;
    investigation.generatedTestContent ??= current.generatedTestContent;
    investigation.execution ??= current.execution;

    if (!canTransition(investigation.status, "execution_error")) {
      throw error;
    }

    const message = error instanceof WorkflowFailure
      ? error.message
      : "Investigation workflow failed.";
    assertTransition(investigation.status, "execution_error");
    investigation.status = "execution_error";
    investigation.updatedAt = new Date().toISOString();
    investigation.timeline.push({
      status: "execution_error",
      at: investigation.updatedAt,
      message
    });
    investigation.verdictExplanation = `${message} Review the recorded investigation evidence.`;
    investigation.recommendedNextStep = "Resolve the reported workflow error and retry the investigation.";
    await this.store.save(investigation);
    return investigation;
  }
}

class WorkflowFailure extends Error {}
