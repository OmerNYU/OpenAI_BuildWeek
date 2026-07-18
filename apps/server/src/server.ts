import { createApp } from "./app.js";
import { createRuntimeDependencies } from "./runtime-dependencies.js";

const port = Number(process.env.PORT ?? 3001);
const app = createApp(createRuntimeDependencies({ env: process.env }));

app.listen(port, () => {
  console.log(`FailSpec server listening on http://localhost:${port}`);
});
