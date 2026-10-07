import React from "react";
import ReactDOM from "react-dom/client";
import { resolveAuthMode } from "@carelik/auth";
import "@/index.css";
import type { AwsEnv } from "@/aws/aws-runtime";

const root = ReactDOM.createRoot(document.getElementById("root")!);

// Explicit provider selection. Unset = the CURRENT production build
// (Supabase) exactly as before. "cognito" = the AWS Service Verification
// build; its module graph never creates a Supabase client.
if (resolveAuthMode(import.meta.env.VITE_AUTH_PROVIDER) === "cognito") {
  void Promise.all([import("@/aws/aws-root"), import("@/aws/aws-runtime")]).then(async ([{ AwsApp, AwsConfigurationError }, { createAwsRuntime, loadRuntimeEnv }]) => {
    try {
      const runtime = createAwsRuntime(await loadRuntimeEnv(import.meta.env as unknown as AwsEnv));
      root.render(
        <React.StrictMode>
          <AwsApp runtime={runtime} />
        </React.StrictMode>
      );
    } catch (error) {
      root.render(<AwsConfigurationError message={error instanceof Error ? error.message : "Invalid configuration."} />);
    }
  });
} else {
  void Promise.all([import("@/App"), import("@/providers/app-providers")]).then(([{ App }, { AppProviders }]) => {
    root.render(
      <React.StrictMode>
        <AppProviders>
          <App />
        </AppProviders>
      </React.StrictMode>
    );
  });
}
