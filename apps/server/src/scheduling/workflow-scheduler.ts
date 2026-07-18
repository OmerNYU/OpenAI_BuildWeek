export interface WorkflowScheduler {
  schedule(task: () => Promise<void>): void;
}

export type BackgroundTaskErrorObserver = (error: unknown) => void;

export class InProcessWorkflowScheduler implements WorkflowScheduler {
  constructor(
    private readonly observeTaskError: BackgroundTaskErrorObserver = logBackgroundTaskError
  ) {}

  schedule(task: () => Promise<void>): void {
    setImmediate(() => {
      void Promise.resolve().then(task).catch((error: unknown) => {
        this.observeTaskError(error);
      });
    });
  }
}

function logBackgroundTaskError(error: unknown): void {
  console.error("Background investigation workflow failed.", error);
}
