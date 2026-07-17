import type { Investigation } from "@failspec/contracts";

export interface InvestigationStore {
  save(investigation: Investigation): Promise<void>;
  getById(id: string): Promise<Investigation | undefined>;
}
