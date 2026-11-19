import React, { useEffect, useState } from "react";
export function ModelBehavior({
  record,
  call,
  listen,
  clip,
  stop,
}: {
  record: any;
  call: (method: string, args: any) => Promise<any>;
  listen: (file: string) => Promise<void>;
  clip?: string;
  stop: () => void;
}) {
  const [result, setResult] = useState<any>();
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setResult(undefined);
    setSelected(0);
    setError("");
    call("modelAnalysis", { ref: record.ref, view: "behavior" }).then(
      (v) => {
        if (active) setResult(v.behavior);
      },
      (err) => {
        if (active) setError(String(err));
      },
    );
    return () => {
      active = false;
    };
  }, [record, call]);
  const pair = result?.pairs[selected];
  return (
    <section>
      <h2>{record.run.runId}</h2>
      <p>
        {record.run.task} · Dev · {record.run.datasetRevision}
      </p>
      {error && <p role="alert">{error}</p>}
      {result?.metrics.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>评价集</th>
              <th>Base 命中</th>
              <th>Adapter 命中</th>
              <th>变化</th>
            </tr>
          </thead>
          <tbody>
            {result.metrics.map((m: any) => (
              <tr key={m.name}>
                <td>{m.name}</td>
                <td>
                  {m.base} / {m.denominator}
                </td>
                <td>
                  {m.adapter} / {m.denominator}
                </td>
                <td>
                  {m.denominator
                    ? (((m.adapter - m.base) * 100) / m.denominator).toFixed(
                        2,
                      ) + " 个百分点"
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pair && (
        <>
          <label>
            固定样本　
            <select
              value={selected}
              onChange={(e) => {
                stop();
                setSelected(Number(e.target.value));
              }}
            >
              {result.pairs.map((p: any, i: number) => (
                <option value={i} key={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          </label>
          <p>
            {pair.condition}
            {pair.target && "参考答案　" + pair.target}
          </p>
          <table>
            <thead>
              <tr>
                <th>版本</th>
                <th>输出</th>
                <th>音频</th>
              </tr>
            </thead>
            <tbody>
              {["base", "adapter"].map((k) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{pair[k].prediction ?? "—"}</td>
                  <td>
                    {pair[k].audio && (
                      <button onClick={() => listen(pair[k].audio)}>
                        试听 {k}
                      </button>
                    )}
                    {pair[k].onset != null && (
                      <p>
                        {pair[k].clock}　{pair[k].onset.toFixed(3)}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pair.listeningNote && <p>试听笔记　{pair.listeningNote}</p>}
          {clip && <audio controls src={clip} />}
        </>
      )}
    </section>
  );
}
