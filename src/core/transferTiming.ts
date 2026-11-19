type Phase = "read" | "write" | "verify";
type Span = { phase: Phase; startMs: number; durationMs: number };

export interface TransferTimingRecord {
  executionMs: number;
  spans: Span[];
  totals: Partial<Record<Phase, number>>;
  clipped?: boolean;
}

export class TransferTiming {
  private started = performance.now();
  private spans: Span[] = [];
  private phases = new Map<
    Phase,
    { active: number; start: number; total: number }
  >();
  private clipped = false;

  start(phase: Phase) {
    const data = this.phases.get(phase) ?? { active: 0, start: 0, total: 0 };
    this.phases.set(phase, data);
    if (data.active++ === 0) data.start = performance.now();
    return () => {
      if (--data.active > 0) return;
      const durationMs = performance.now() - data.start;
      data.total += durationMs;
      this.spans.push({
        phase,
        startMs: data.start - this.started,
        durationMs,
      });
      if (this.spans.length > 96) {
        this.spans.shift();
        this.clipped = true;
      }
    };
  }

  async measure<T>(phase: Phase, action: () => Promise<T>) {
    const done = this.start(phase);
    try {
      return await action();
    } finally {
      done();
    }
  }

  finish(previous?: TransferTimingRecord): TransferTimingRecord {
    const offset = previous?.executionMs ?? 0;
    const spans = [
      ...(previous?.spans ?? []),
      ...this.spans.map((span) => ({
        ...span,
        startMs: span.startMs + offset,
      })),
    ];
    const totals = { ...previous?.totals };
    for (const [phase, data] of this.phases)
      totals[phase] = (totals[phase] ?? 0) + data.total;
    return {
      executionMs: offset + performance.now() - this.started,
      spans: spans.slice(-96),
      totals,
      clipped: this.clipped || previous?.clipped || spans.length > 96,
    };
  }
}
