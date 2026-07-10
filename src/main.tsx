import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
// Style-stack foundation (ADR-0049/0050): Tailwind v4 entry + shadcn token
// system load first so the legacy v0 component rules in styles.css can consume
// the tokens via var(--primary) etc.
import "./app.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
