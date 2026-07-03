import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { AppProviders } from "./app/providers";
import { loadFrontendRuntimeConfig } from "./app/runtime-config";
import { createFrontendRuntimeAdapters } from "./app/runtime-adapters";
import "./styles/global.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

const runtime = createFrontendRuntimeAdapters(loadFrontendRuntimeConfig());

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppProviders walletAdapter={runtime.walletAdapter}>
      <App
        authTokenProvider={runtime.authTokenProvider}
        ingestionApi={runtime.ingestionApi}
        jobStatusProvider={runtime.jobStatusProvider}
        submissionRuntimeNote={runtime.submissionRuntimeNote}
      />
    </AppProviders>
  </React.StrictMode>,
);