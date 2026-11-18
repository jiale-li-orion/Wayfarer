import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Ref } from "../shared/types";
import { rpc } from "./rpc";
import { EnvironmentPanel } from "./EnvironmentPanel";
import "./environment.css";
function App() {
  const [roots, setRoots] = useState<Ref[]>([]),
    [index, setIndex] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    void rpc("bootstrap")
      .then((v) => setRoots(v.roots))
      .catch((e) => setError(String(e)));
  }, []);
  return (
    <main>
      <header>
        <h1>项目环境</h1>
        <select
          aria-label="项目根目录"
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
        >
          {roots.map((r, i) => (
            <option key={r.endpoint + r.path} value={i}>
              {r.endpoint} · {r.path}
            </option>
          ))}
        </select>
      </header>
      {error && <p role="alert">{error}</p>}
      {roots[index] && (
        <EnvironmentPanel
          key={roots[index].endpoint + roots[index].path}
          target={roots[index]}
          navigate={(ref) => void rpc("locate", { ref })}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
