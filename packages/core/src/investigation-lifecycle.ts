import {
  type InvestigationStatus,
  terminalInvestigationStatuses
} from "@failspec/contracts";

const transitions: Record<InvestigationStatus, readonly InvestigationStatus[]> = {
  created: ["preflight"],
  preflight: ["analyzing", "execution_error"],
  analyzing: ["hypothesis_ready", "execution_error"],
  hypothesis_ready: ["generating_test"],
  generating_test: ["test_ready", "execution_error"],
  test_ready: ["executing"],
  executing: ["verified", "partial", "not_reproduced", "execution_error"],
  verified: [],
  partial: [],
  not_reproduced: [],
  execution_error: []
};

export function isTerminalStatus(status: InvestigationStatus): boolean {
  return terminalInvestigationStatuses.includes(
    status as (typeof terminalInvestigationStatuses)[number]
  );
}

export function canTransition(
  from: InvestigationStatus,
  to: InvestigationStatus
): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: InvestigationStatus, to: InvestigationStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid investigation transition: ${from} -> ${to}`);
  }
}
