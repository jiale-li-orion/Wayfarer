import type { Ref } from "../shared/types";
/** One visible target, one in-flight probe; invalidations merge, stale replies are dropped. */
export class CapacityRefresh {
  private ref?: Ref;
  private visible = false;
  private revision = 0;
  private dirty = false;
  private running = false;
  private timer?: NodeJS.Timeout;
  constructor(
    private probe: (ref: Ref) => Promise<any>,
    private deliver: (value: any) => void,
    private fail: (error: string) => void,
    private delay = 150,
  ) {}
  watch(ref?: Ref) {
    this.revision++;
    this.ref = ref;
    this.visible = !!ref;
    this.dirty = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (ref) this.request();
  }
  request() {
    if (!this.visible) return;
    this.dirty = true;
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.delay);
    this.timer.unref();
  }
  private async run() {
    if (!this.visible || !this.ref || !this.dirty) return;
    this.dirty = false;
    this.running = true;
    const revision = this.revision,
      ref = this.ref;
    try {
      const value = await this.probe(ref);
      if (this.visible && revision === this.revision) this.deliver(value);
    } catch (e) {
      if (this.visible && revision === this.revision) this.fail(String(e));
    } finally {
      this.running = false;
      if (this.dirty) this.request();
    }
  }
  dispose() {
    this.watch();
  }
}
