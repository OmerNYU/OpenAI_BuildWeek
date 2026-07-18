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

export class InvestigationService {
  constructor(
    private readonly store: InvestigationStore,
    private readonly codexAdapter: CodexAdapter,
    private readonly runnerAdapter: RunnerAdapter
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
    return this.runWorkflow(investigation);
  }

  getById(id: string): Promise<Investigation | undefined> {
    return this.store.getById(id);
  }

  private async runWorkflow(investigation: Investigation): Promise<Investigation> {
    let lastPersisted = structuredClone(investigation);

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

    try {
      await transition("preflight", "Mock preflight completed.");
      await transition("analyzing", "Analyzing the reported failure.");
      const hypothesis = await this.codexAdapter.analyze(investigation.request);
      investigation.hypothesis = hypothesis;
      await transition("hypothesis_ready", "Reproduction hypothesis is ready.");
      await transition("generating_test", "Generating a regression test.");
      const generatedTest = await this.codexAdapter.generateTest({
        request: investigation.request,
        hypothesis
      });
      investigation.generatedTestContent = generatedTest.content;
      investigation.generatedTestPath = generatedTest.path;
      await transition("test_ready", "Generated test is ready.");
      await transition("executing", "Running the generated test.");
      investigation.execution = await this.runnerAdapter.run({
        repositoryPath: investigation.request.repositoryPath,
        generatedTest
      });
      investigation.verdictExplanation = "The deterministic mock runner returned the expected reproduction signal.";
      investigation.recommendedNextStep = "Review the generated regression test before running it against a real repository.";
      await transition("verified", "Mock reproduction verified.");
      return investigation;
    } catch (error: unknown) {
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
    investigation.generatedTestPath ??= current.generatedTestPath;
    investigation.generatedTestContent ??= current.generatedTestContent;
    investigation.execution ??= current.execution;

    if (!canTransition(investigation.status, "execution_error")) {
      throw error;
    }

    const message = "Investigation workflow failed.";
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
