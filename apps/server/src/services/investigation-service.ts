import { randomUUID } from "node:crypto";
import {
  type Investigation,
  type InvestigationRequest,
  type InvestigationStatus,
  generatedTestStagingResultSchema,
  runnerOutputSchema,
  verificationResultSchema,
  type GeneratedTestStagingResult,
  type VerificationResult
} from "@failspec/contracts";
import {
  assertTransition,
  canTransition,
  type CodexAdapter,
  type GeneratedTest,
  type VerificationInput,
  type RunnerAdapter
} from "@failspec/core";
import type { InvestigationStore } from "../storage/investigation-store.js";
import type { WorkflowScheduler } from "../scheduling/workflow-scheduler.js";
import type { RepositoryWorkspace } from "../repository/repository-workspace.js";

export type InvestigationRuntimeMode = "mock" | "local";

export type GeneratedTestStager = (
  worktreePath: string,
  content: string
) => Promise<GeneratedTestStagingResult>;

export type VerificationClassifier = (input: VerificationInput) => VerificationResult;

export class InvestigationService {
  constructor(
    private readonly store: InvestigationStore,
    private readonly codexAdapter: CodexAdapter,
    private readonly runnerAdapter: RunnerAdapter,
    private readonly scheduler: WorkflowScheduler,
    private readonly repositoryWorkspace: RepositoryWorkspace,
    private readonly generatedTestStager: GeneratedTestStager,
    private readonly verificationClassifier: VerificationClassifier
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
      await persist();
      const staging = generatedTestStagingResultSchema.safeParse(
        await this.generatedTestStager(preparation.workspace.workspacePath, generatedTest.content)
      );
      if (!staging.success || staging.data.status !== "staged") {
        throw new WorkflowFailure("The generated test could not be staged safely.");
      }
      const stagedGeneratedTest: GeneratedTest = {
        content: generatedTest.content,
        path: staging.data.stagedTestPath
      };
      investigation.generatedTestPath = stagedGeneratedTest.path;
      await transition("test_ready", "Generated test is ready.");
      await transition("executing", "Running the generated test.");
      const runnerOutput = runnerOutputSchema.safeParse(await this.runnerAdapter.run({
        repositoryPath: preparation.workspace.workspacePath,
        generatedTest: stagedGeneratedTest
      }));
      if (!runnerOutput.success) {
        throw new WorkflowFailure("The generated test execution returned invalid results.");
      }
      investigation.execution = runnerOutput.data.execution;
      investigation.executionEvidence = runnerOutput.data.evidence;
      await persist();
      if (!(await cleanup())) {
        throw new WorkflowFailure("The repository workspace could not be cleaned up safely.");
      }
      let verification;
      try {
        verification = verificationResultSchema.safeParse(this.verificationClassifier({
          request: investigation.request,
          hypothesis: analysis.hypothesis,
          execution: runnerOutput.data.execution,
          evidence: runnerOutput.data.evidence
        }));
      } catch {
        throw new WorkflowFailure("The execution evidence could not be classified safely.");
      }
      if (!verification.success) {
        throw new WorkflowFailure("The execution evidence could not be classified safely.");
      }
      investigation.verification = verification.data;
      investigation.verdictExplanation = verification.data.explanation;
      investigation.recommendedNextStep = verification.data.recommendedNextStep;
      await transition(verification.data.verdict, terminalMessage(verification.data.verdict));
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
    investigation.executionEvidence ??= current.executionEvidence;

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

function terminalMessage(verdict: VerificationResult["verdict"]): string {
  if (verdict === "verified") return "Reproduction verified.";
  if (verdict === "partial") return "Investigation completed with partial evidence.";
  if (verdict === "not_reproduced") return "The generated test did not reproduce the reported failure.";
  return "Execution evidence could not be classified as a valid reproduction.";
}
