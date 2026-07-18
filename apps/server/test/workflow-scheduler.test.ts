import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessWorkflowScheduler } from "../src/scheduling/workflow-scheduler.js";

describe("InProcessWorkflowScheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defers work until after schedule returns", async () => {
    const completed = deferred<void>();
    const task = vi.fn(async () => {
      completed.resolve(undefined);
    });
    const scheduler = new InProcessWorkflowScheduler();

    scheduler.schedule(task);

    expect(task).not.toHaveBeenCalled();
    await completed.promise;
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("logs and observes rejected task promises", async () => {
    const expectedError = new Error("scheduled task rejected");
    const logged = deferred<void>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      logged.resolve(undefined);
    });
    const scheduler = new InProcessWorkflowScheduler();

    scheduler.schedule(() => Promise.reject(expectedError));

    await logged.promise;
    expect(consoleError).toHaveBeenCalledWith("Background investigation workflow failed.", expectedError);
  });

  it("logs and observes synchronous task throws", async () => {
    const expectedError = new Error("scheduled task threw");
    const logged = deferred<void>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      logged.resolve(undefined);
    });
    const scheduler = new InProcessWorkflowScheduler();

    scheduler.schedule(() => {
      throw expectedError;
    });

    await logged.promise;
    expect(consoleError).toHaveBeenCalledWith("Background investigation workflow failed.", expectedError);
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
