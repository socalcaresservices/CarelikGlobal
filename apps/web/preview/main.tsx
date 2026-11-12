// PREVIEW ONLY. The real routes and screens (apps/web/src/aws) with a fake sign-in and the replayed synthetic data. Built into ONE html file by preview/build.mjs.
import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import "@/index.css";
import { AwsRoutes } from "@/aws/aws-root";
import { EnvironmentProvider } from "@/aws/environment-marker";
import { createAwsApiClient, createAwsPublicApiClient } from "@/lib/aws-api";
import { PreviewBadge } from "./badge";
import { createPreviewFetch, type PreviewData } from "./replay";

const data = JSON.parse(document.getElementById("preview-data")!.textContent!) as PreviewData;
const params = new URLSearchParams(location.search);
const persona = data.personas[params.get("as") ?? ""] ? params.get("as")! : data.meta.personas[0]!;
const previewFetch = createPreviewFetch(data, persona);
window.fetch = previewFetch;

const auth = {
  subscribe: () => () => {},
  getSession: async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "preview@example.invalid", emailVerified: true }, access_token: "preview", expires_at: 4_000_000_000 }),
  getAccessToken: async () => "preview",
  signIn: () => {}, handleCallback: async () => {}, startPasswordReset: async () => {}, signOut: async () => { location.search = ""; },
} as unknown as CognitoAuthClient;
const api = createAwsApiClient({ baseUrl: "https://preview.invalid", getAccessToken: () => auth.getAccessToken(), fetch: previewFetch });
const publicApi = createAwsPublicApiClient("https://preview.invalid", previewFetch);
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false }, mutations: { retry: 0 } } });
const sha7 = data.meta.sha.slice(0, 7);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <QueryClientProvider client={queryClient}>
        <CognitoAuthProvider client={auth}>
          <EnvironmentProvider marker={{ kind: "test", label: `PREVIEW ${sha7} — synthetic data only, nothing is saved` }}>
            <AwsRoutes api={api} publicApi={publicApi} />
            <PreviewBadge data={data} persona={persona} />
          </EnvironmentProvider>
        </CognitoAuthProvider>
      </QueryClientProvider>
    </HashRouter>
  </React.StrictMode>,
);
