export type LogSink = (line: string) => void;
export class Profiler {
  private stopped = false;
  stop() {
    this.stopped = true;
  }
  constructor(private sink: LogSink) {}
  record(stage: string, fields: Record<string, any> = {}) {
    if (this.stopped) return;
    this.sink(
      JSON.stringify({ at: new Date().toISOString(), stage, ...fields }),
    );
  }
  async time<T>(
    stage: string,
    fields: Record<string, any>,
    run: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    try {
      const value = await run();
      this.record(stage, {
        ...fields,
        ms: +(performance.now() - start).toFixed(2),
        ok: true,
      });
      return value;
    } catch (e) {
      this.record(stage, {
        ...fields,
        ms: +(performance.now() - start).toFixed(2),
        ok: false,
        error: String(e),
      });
      throw e;
    }
  }
}
