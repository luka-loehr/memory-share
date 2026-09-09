/**
 * A counting semaphore. Upload concurrency has to be bounded across the whole
 * run rather than per file: four files each opening four parts is sixteen
 * sockets, which is exactly the thing `--concurrency 4` was meant to prevent.
 */
export class Semaphore {
  private available: number;
  private readonly waiting: (() => void)[] = [];

  constructor(slots: number) {
    this.available = Math.max(1, Math.floor(slots));
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return this.release();
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return this.release();
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) this.available++;
      else next();
    };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }
}
