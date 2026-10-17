#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { isAbsolute } from "node:path";
import { loadDataDirectory } from "./config.js";

const usage = "Usage: telegramvisor start [--data-dir <absolute-path>]\n       telegramvisor auth forge [--data-dir <absolute-path>]\n";

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(usage);
    return;
  }
  const action = args[0] === "start" ? "start" : args[0] === "auth" && args[1] === "forge" ? "forge" : null;
  const options = args.slice(action === "forge" ? 2 : 1);
  if (action === null || (options.length !== 0 &&
    (options.length !== 2 || options[0] !== "--data-dir" || !isAbsolute(options[1]!)))) {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  if (options[1]) process.env.DATA_DIRECTORY = options[1];
  if (action === "start") {
    await import("./main.js");
    return;
  }
  try {
    const { forgeDashboardToken } = await import("./service-auth.js");
    const issued = await forgeDashboardToken(loadDataDirectory());
    process.stdout.write(`${issued.token}\n`);
  } catch {
    process.stderr.write("Could not issue a sign-in token. Run as the account that runs Telegramvisor, after the service has initialized. If it uses a custom state directory, pass --data-dir <absolute-path> or the same DATA_DIRECTORY. Pending tokens expire after five minutes.\n");
    process.exitCode = 1;
  }
};

await main();
