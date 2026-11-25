import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAntigravityResilientProvider } from "./server/provider.ts";
import { Usage } from "./server/usage.ts";

export default function contribute(server: PluginServerContext) {
  const usage = new Usage();
  server.registerUsageSource(usage.registration());
  server.registerProvider(createAntigravityResilientProvider());
  return () => {};
}
