interface CodexJsonlEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

export function extractCodexAgentMessage(stdout: string): string {
  let agentMessage: string | undefined;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    let event: CodexJsonlEvent;
    try {
      event = JSON.parse(line) as CodexJsonlEvent;
    } catch {
      throw new Error("Codex returned invalid JSONL output");
    }

    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      agentMessage = event.item.text;
    }
  }

  if (!agentMessage) {
    throw new Error("Codex did not return an agent message");
  }

  return agentMessage;
}
