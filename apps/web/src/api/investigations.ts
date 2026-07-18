import {
  apiErrorResponseSchema,
  investigationSchema,
  type Investigation,
  type InvestigationRequest
} from "@failspec/contracts";

export class InvestigationApiError extends Error {}

export async function createInvestigation(
  request: InvestigationRequest,
  signal?: AbortSignal
): Promise<Investigation> {
  return requestInvestigation("/api/investigations", {
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
  return requestInvestigation(`/api/investigations/${encodeURIComponent(id)}`, { signal });
}

async function requestInvestigation(url: string, init: RequestInit): Promise<Investigation> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new InvestigationApiError("Unable to reach the investigation service. Try again.");
  }

  const body = await readJson(response);
  if (!response.ok) {
    const parsedError = apiErrorResponseSchema.safeParse(body);
    throw new InvestigationApiError(
      parsedError.success && parsedError.data.error.trim()
        ? parsedError.data.error
        : "The investigation request could not be completed."
    );
  }

  const parsedInvestigation = investigationSchema.safeParse(body);
  if (!parsedInvestigation.success) {
    throw new InvestigationApiError("The investigation service returned an invalid response.");
  }

  return parsedInvestigation.data;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
