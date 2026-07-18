import { investigationSchema, type Investigation, type InvestigationRequest } from "@failspec/contracts";

export class InvestigationApiError extends Error {}

type InvestigationOperation = "create" | "get";

export async function createInvestigation(
  request: InvestigationRequest,
  signal?: AbortSignal
): Promise<Investigation> {
  return requestInvestigation("create", "/api/investigations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal
  });
}

export async function getInvestigation(
  id: string,
  signal?: AbortSignal
): Promise<Investigation> {
  return requestInvestigation("get", `/api/investigations/${encodeURIComponent(id)}`, { signal });
}

async function requestInvestigation(
  operation: InvestigationOperation,
  url: string,
  init: RequestInit
): Promise<Investigation> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new InvestigationApiError("Unable to reach the investigation service. Try again.");
  }

  if (!response.ok) {
    throw new InvestigationApiError(publicErrorFor(operation, response.status));
  }

  const body = await readJson(response);
  const parsedInvestigation = investigationSchema.safeParse(body);
  if (!parsedInvestigation.success) {
    throw new InvestigationApiError("The investigation service returned an invalid response.");
  }

  return parsedInvestigation.data;
}

function publicErrorFor(operation: InvestigationOperation, status: number): string {
  if (operation === "create") {
    return status === 400
      ? "Please review the bug report fields and try again."
      : "Unable to start the investigation. Try again.";
  }

  return status === 404
    ? "The investigation could not be found. Start another investigation to try again."
    : "Unable to refresh investigation progress. Start another investigation to retry.";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
