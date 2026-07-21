# Investigation flow and accessibility requirements

## User flow

1. Read the trusted-local repository requirement.
2. Enter the five required report fields; optionally disclose technical context.
3. Submit once and receive an explicit pending state.
4. Follow the current stage, elapsed time, and ordered investigation timeline while polling.
5. Review results as separate analysis evidence, execution evidence, and verification classification.
6. Start another investigation when needed.

## Design principles

- **Progressive disclosure:** optional logs and screenshot paths do not distract from the minimum viable report.
- **Honest progress:** the UI only displays statuses and messages delivered by the investigation API.
- **Clear evidence boundaries:** a generated test or non-zero exit never appears as a verified result by itself.
- **Recovery:** errors are concise, announced, and do not discard the last known investigation.

## Accessibility checklist

- Inputs retain visible labels, hints, validation messages, and focus indicators.
- Buttons communicate pending state and are at least 44px high.
- The current server status uses a polite live region; the elapsed timer does not create repeated announcements.
- Progress has a semantic `progressbar`; current/completed stages use text as well as colour.
- The layout collapses to one column on narrow screens and remains keyboard-operable.
