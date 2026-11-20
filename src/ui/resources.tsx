import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ModelAnalysis } from "./ModelAnalysis";
import { RunsPanel, JobPerformance } from "./PerformanceViews";
import "./resources.css";
declare const acquireVsCodeApi: () => {
  postMessage(v: any): void;
  setState(v: any): void;
  getState(): any;
};
const api = acquireVsCodeApi();
let seq = 0;
const pending = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
const listeners = new Set<(v: any) => void>();
function rpc(method: string, args: any = {}) {
  const id = ++seq;
  api.postMessage({ id, method, args });
  return new Promise<any>((resolve, reject) =>
    pending.set(id, { resolve, reject }),
  );
}
window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p?.reject(Error(m.error)) : p?.resolve(m.result);
  } else listeners.forEach((f) => f(m));
});
window.addEventListener("pagehide", () => {
  pending.forEach((p) => p.reject(Error("View hidden")));
  pending.clear();
  listeners.clear();
});
function Report() {
  const [request, setRequest] = useState<any>(api.getState() ?? {}),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const open = (r: any) => {
      if (active && r) {
        setRequest(r);
        api.setState(r);
      }
    };
    const event = (m: any) => {
      if (m.type === "open") open(m.request);
    };
    listeners.add(event);
    void rpc("bootstrap")
      .then((v) => open(v.selection))
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
      listeners.delete(event);
    };
  }, []);
  return (
    <main className="resources-root">
      {error && <p role="alert">{error}</p>}
      {request.view === "model" && (
        <ModelAnalysis
          key={request.ref?.path}
          call={rpc}
          initialRef={request.ref}
        />
      )}
      {request.view === "runs" && (
        <RunsPanel
          key={request.ref?.path}
          call={rpc}
          initialRef={request.ref}
        />
      )}
      {request.view === "job" && (
        <JobPerformance id={request.jobId} call={rpc} />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Report />);
