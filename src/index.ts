// Keep this entry point free of application imports: the listener must survive
// broken application code, failed integrations, and slow device startup.
import { startSupervisor } from "./runtime/supervisor";

await startSupervisor({ watch: process.argv.includes("--watch") });
