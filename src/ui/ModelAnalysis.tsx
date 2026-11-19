import { ModelBehavior } from "./ModelBehavior";
import React, { useEffect, useRef, useState } from "react";

type Call = (method: string, args?: any) => Promise<any>;
const fmt = (v: number | undefined | null) =>
  v == null ? "—" : Number(v.toPrecision(5)).toString();

export function ModelAnalysis({ call }: { call: Call }) {
  const [record, setRecord] = useState<any>();
  const [events, setEvents] = useState<any[]>([]);
  const [probes, setProbes] = useState<any[]>([]);
  const [follow, setFollow] = useState(true);
  const [attempt, select] = useState<number>();
  const [step, setStep] = useState<any>();
  const [sampleId, setSample] = useState("");
  const [detail, setDetail] = useState("");
  const [clip, setClip] = useState<string>();
  const [heatMetric, setHeatMetric] = useState("step");
  const audioRequest = useRef(0);
  useEffect(
    () => () => {
      audioRequest.current++;
    },
    [],
  );
  useEffect(
    () => () => {
      if (clip) URL.revokeObjectURL(clip);
    },
    [clip],
  );
  async function listen(file: string) {
    const request = ++audioRequest.current;
    setClip(undefined);
    try {
      const result = await call("modelAudio", {
        ref: { endpoint: record.ref.endpoint, path: file },
      });
      if (request !== audioRequest.current) return;
      const chunks = result.chunks.map((chunk: string) =>
        Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0)),
      );
      setClip(URL.createObjectURL(new Blob(chunks, { type: result.type })));
    } catch (err) {
      if (request === audioRequest.current) setError(String(err));
    }
  }
  const [error, setError] = useState("");
  const cursor = useRef(0);
  const latest = useRef<number | undefined>(undefined);
  const following = useRef(follow);
  following.current = follow;

  const openGeneration = useRef(0);
  useEffect(() => {
    const version = openGeneration.current;
    let active = true;
    (async () => {
      const saved = await call("modelAnalysis");
      if (!saved?.ref || !active || version !== openGeneration.current) return;
      const run = await call("modelAnalysis", { ref: saved.ref });
      if (!active || version !== openGeneration.current) return;
      setFollow(saved.follow);
      select(saved.attempt);
      setRecord(run);
    })().catch((err) => {
      if (active) setError(String(err));
    });
    return () => {
      active = false;
    };
  }, [call]);
  async function open() {
    openGeneration.current++;
    try {
      const picked = await call("pickModelRun");
      if (!picked) return;
      cursor.current = 0;
      latest.current = undefined;
      select(undefined);
      setStep(undefined);
      setEvents([]);
      setProbes([]);
      setFollow(true);
      setDetail("");
      setSample("");
      setError("");
      audioRequest.current++;
      setClip(undefined);
      setRecord(picked);
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    if (!record || record.run.type === "behavior") return;
    let active = true,
      busy = false,
      closed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      clearTimeout(timer);
      if (!active || closed || document.hidden || busy) return;
      busy = true;
      let delay = 2500;
      try {
        const page = await call("modelAnalysis", {
          ref: record.ref,
          view: "events",
          cursor: cursor.current,
        });
        if (!active) return;
        cursor.current = page.cursor;
        if (page.events.length) {
          setEvents((old) => old.concat(page.events).slice(-120));
          const incoming = page.events.filter((e: any) => e.kind === "probe");
          if (incoming.length)
            setProbes((old) => old.concat(incoming).slice(-64));
          const updates = page.events.filter((e: any) => e.kind === "step");
          if (updates.length) {
            latest.current = updates[updates.length - 1].attempt;
            if (following.current) select(latest.current);
          }
          closed = page.events.some((e: any) => e.kind === "closed");
        }
        if (page.more) delay = 50;
      } catch (err) {
        if (active) {
          setError(String(err));
          closed = true;
        }
      } finally {
        busy = false;
        if (active && !closed && !document.hidden)
          timer = setTimeout(poll, delay);
      }
    }
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [record, call]);

  useEffect(() => {
    let active = true;
    audioRequest.current++;
    setClip(undefined);
    setStep(undefined);
    setSample("");
    setDetail("");
    if (record && attempt != null)
      call("modelAnalysis", { ref: record.ref, view: "step", attempt }).then(
        (v) => {
          if (active) {
            setStep(v.step);
            setError("");
          }
        },
        (err) => {
          if (active) setError(String(err));
        },
      );
    return () => {
      active = false;
    };
  }, [record, attempt, call]);

  const samples =
    step?.microbatches.flatMap((m: any) =>
      m.samples.map((s: any, i: number) => ({ m, s, key: m.index + "-" + i })),
    ) ?? [];
  const picked = samples.find((x: any) => x.key === sampleId);
  const heat = events
    .filter((e) => e.kind === "step" && e.moduleChanges?.length)
    .slice(-24);
  const names = Array.from(
    new Set<string>(
      heat.flatMap((e) => e.moduleChanges.map((m: any) => m.name)),
    ),
  );
  const peak = Math.max(
    0,
    ...heat.flatMap((e) => e.moduleChanges.map((m: any) => m[heatMetric] ?? 0)),
  );
  const module = step?.modules.find((m: any) => m.name === detail);
  const checkpoints = probes.filter(
    (e) => attempt == null || e.attempt <= attempt,
  );
  useEffect(() => {
    if (record)
      void call("modelSelection", {
        ref: record.ref,
        attempt,
        follow,
        module: detail || undefined,
        sample: picked?.s.id,
      }).catch((err) => setError(String(err)));
  }, [record, attempt, follow, detail, picked?.s.id, call]);
  return (
    <section className="model-analysis">
      <header>
        <h1>模型分析</h1>
        <button onClick={open}>打开实验记录</button>
      </header>
      {error && <p role="alert">{error}</p>}
      {record?.run.type === "behavior" && (
        <ModelBehavior
          record={record}
          call={call}
          listen={listen}
          clip={clip}
          stop={() => {
            audioRequest.current++;
            setClip(undefined);
          }}
        />
      )}
      {record && record.run.type !== "behavior" && (
        <>
          <h2>{record.run.runId}</h2>
          <p>
            Rank {record.run.rank}　·　{record.run.precision}　·　梯度累计{" "}
            {record.run.accumulation}　·　可训练参数{" "}
            {record.run.trainable?.toLocaleString()} /{" "}
            {record.run.parameters?.toLocaleString()}
          </p>
          <div className="model-nav">
            <label>
              更新尝试{" "}
              <input
                type="number"
                min="1"
                aria-label="更新尝试"
                value={attempt ?? ""}
                onChange={(e) => {
                  setFollow(false);
                  select(e.target.value ? Number(e.target.value) : undefined);
                }}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => {
                  setFollow(e.target.checked);
                  if (e.target.checked) select(latest.current);
                }}
              />{" "}
              跟随最新更新
            </label>
          </div>
          <div className="model-timeline">
            {events
              .filter((e) => e.kind === "step")
              .map((e) => (
                <button
                  title={"最后一个 microbatch 的 loss " + fmt(e.loss)}
                  key={e.seq}
                  aria-pressed={e.attempt === attempt}
                  onClick={() => {
                    setFollow(false);
                    select(e.attempt);
                  }}
                >
                  {e.attempt}
                </button>
              ))}
          </div>
          {events.at(-1)?.dropped > 0 && (
            <p>
              事件流丢弃 {events.at(-1).dropped} 条通知，可按尝试编号查回更新。
            </p>
          )}
          {events.at(-1)?.error && <p role="alert">{events.at(-1).error}</p>}
          {step && (
            <>
              <h2>更新 {step.attempt}</h2>
              <p>
                {step.skipped ? "优化器跳步" : "优化器已执行"}　·　学习率{" "}
                {fmt(step.lr)}　·　本段已执行 {step.completedInSegment}{" "}
                次　·　耗时 {fmt(step.stepHostMs)} ms
              </p>
              {heat.length > 0 && (
                <>
                  <label>
                    模块 × 更新　
                    <select
                      value={heatMetric}
                      onChange={(e) => setHeatMetric(e.target.value)}
                    >
                      {[
                        ["step", "本步有效变化"],
                        ["cumulative", "相对底座偏移"],
                        ["gradA", "A 梯度（裁剪后）"],
                        ["gradB", "B 梯度（裁剪后）"],
                      ].map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <table>
                    <thead>
                      <tr>
                        <th>模块</th>
                        {heat.map((e) => (
                          <th key={e.seq}>{e.attempt}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {names.map((n) => (
                        <tr key={n}>
                          <td>{n}</td>
                          {heat.map((e) => {
                            const v = e.moduleChanges.find(
                              (m: any) => m.name === n,
                            )?.[heatMetric];
                            return (
                              <td
                                key={e.seq}
                                style={{
                                  backgroundColor:
                                    v == null
                                      ? undefined
                                      : `rgba(49,153,135,${0.08 + 0.6 * (peak ? v / peak : 0)})`,
                                }}
                              >
                                <button
                                  onClick={() => {
                                    setFollow(false);
                                    select(e.attempt);
                                  }}
                                >
                                  {fmt(v)}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <h3>参与这次更新的样本</h3>
              <table>
                <thead>
                  <tr>
                    {[
                      "Microbatch",
                      "样本",
                      "有效监督位置",
                      "加权损失和",
                      "权重和",
                      "模式权重",
                      "批次 loss",
                    ].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {samples.map(({ m, s, key }: any) => (
                    <tr key={key}>
                      <td>{m.index}</td>
                      <td>
                        <button
                          onClick={() => {
                            audioRequest.current++;
                            setClip(undefined);
                            setSample(key);
                          }}
                        >
                          {s.id || "查看样本"}
                        </button>
                      </td>
                      <td>{s.supervised}</td>
                      <td>{fmt(s.numerator)}</td>
                      <td>{fmt(s.weightSum)}</td>
                      <td>{fmt(s.modeWeight)}</td>
                      <td>{fmt(m.loss)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {picked && (
                <div>
                  <p>
                    {picked.m.normalization}　·　样本 loss{" "}
                    {fmt(picked.s.sampleLoss)}　·　输入 {picked.s.tokens}{" "}
                    token　·　补齐后 {picked.s.paddedLength}
                  </p>
                  {picked.s.prompt?.map((p: string, i: number) => (
                    <p key={i}>{p}</p>
                  ))}
                  {picked.s.response?.length > 0 && (
                    <p>参考回答　{picked.s.response.join(" ")}</p>
                  )}
                  {picked.s.source?.map((f: string) => (
                    <button key={f} onClick={() => listen(f)}>
                      试听 · {f.split(/[\\/]/).at(-1)}
                    </button>
                  ))}
                  {clip && <audio controls src={clip} />}
                  {picked.s.positions?.length > 0 && (
                    <table>
                      <thead>
                        <tr>
                          <th>输入位置 → 目标位置</th>
                          <th>目标 token</th>
                          <th>权重</th>
                          <th>损失贡献</th>
                        </tr>
                      </thead>
                      <tbody>
                        {picked.s.positions.map((p: any) => (
                          <tr key={p.targetPosition}>
                            <td>
                              {p.inputPosition} → {p.targetPosition}
                            </td>
                            <td>{p.target}</td>
                            <td>{p.weight}</td>
                            <td>{fmt(p.contribution)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
              <p>
                等数据 {fmt(step.dataWaitHostMs)} ms　·　前向{" "}
                {fmt(
                  step.microbatches.reduce(
                    (acc: number, m: any) => acc + m.forwardHostMs,
                    0,
                  ),
                )}{" "}
                ms　·　反向 {fmt(step.backwardHostMs)} ms　·　优化器{" "}
                {fmt(step.optimizerHostMs)} ms（主机计时）
              </p>
              <h3>参数更新</h3>
              <p>
                裁剪前总梯度范数 {fmt(step.clip?.preGlobal)}　·　裁剪阈值{" "}
                {fmt(step.clip?.maxNorm)}　·　梯度缩放 {fmt(step.scaler)}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>模块</th>
                    <th>本步变化</th>
                    <th>累计偏移</th>
                    <th>本步 / 底座</th>
                  </tr>
                </thead>
                <tbody>
                  {step.modules.map((m: any) => (
                    <tr key={m.name}>
                      <td>
                        <button onClick={() => setDetail(m.name)}>
                          {m.name}
                        </button>
                      </td>
                      <td>{fmt(m.step)}</td>
                      <td>{fmt(m.cumulative)}</td>
                      <td>{fmt(m.ratio)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {module && (
                <p>
                  裁剪前 A / B　{fmt(module.pre?.[0])} / {fmt(module.pre?.[1])}
                  　　裁剪后 A / B　{fmt(module.post?.[0])} /{" "}
                  {fmt(module.post?.[1])}
                </p>
              )}
            </>
          )}
          {checkpoints.length > 0 && (
            <>
              <h3>固定样本 · Checkpoint</h3>
              <table>
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>相对 Base 的最大 logits 差</th>
                    <th>相对 Step 0 的差</th>
                    <th>预测 token（首个位置）</th>
                  </tr>
                </thead>
                <tbody>
                  {checkpoints.map((e) => (
                    <tr key={e.seq}>
                      <td>{e.label}</td>
                      <td>{fmt(e.delta)}</td>
                      <td>{fmt(e.trainingDelta)}</td>
                      <td>{e.top?.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <details>
            <summary>运行身份与实际注入</summary>
            {record.run.recipe && (
              <p>
                配方声明　rank {record.run.recipe.lora_rank}　·　alpha{" "}
                {record.run.recipe.lora_alpha}　·　dropout{" "}
                {record.run.recipe.lora_dropout}　·　
                {record.run.recipe.lora_target}
              </p>
            )}
            <p>
              {record.run.gitCommit && "观测器 " + record.run.gitCommit}　
              {record.run.publisherCommit &&
                "训练源码 " + record.run.publisherCommit}
            </p>
            {Object.entries(
              record.run.sources ??
                (record.run.source
                  ? {
                      loss: {
                        path: record.run.source,
                        sha256: record.run.sourceSha256,
                        line: record.run.sourceLine,
                      },
                    }
                  : {}),
            ).map(([key, loc]: [string, any]) => (
              <button
                key={key}
                onClick={() =>
                  call("openModelSource", {
                    ref: { endpoint: record.ref.endpoint, path: loc.path },
                    sha256: loc.sha256,
                    line: loc.line,
                  }).catch((e) => setError(String(e)))
                }
              >
                {(
                  {
                    loss: "损失计算",
                    collator: "样本组批",
                    update: "参数更新",
                    sample: "样本记录",
                  } as Record<string, string>
                )[key] ?? key}{" "}
                · 第 {loc.line} 行
              </button>
            ))}
            {record.run.modules?.map((m: any) => (
              <p key={m.name}>
                {m.name}　A {m.A.join("×")}　B {m.B.join("×")}　scale{" "}
                {m.scaling}
              </p>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
