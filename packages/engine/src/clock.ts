export class VirtualClock {
  readonly #virtual: number;
  readonly #real: number;
  readonly #realNow: () => number;

  constructor(start: string | Date, realNow: () => number = () => performance.now()) {
    this.#realNow = realNow;
    this.#virtual = new Date(start).getTime();
    this.#real = realNow();
    if (Number.isNaN(this.#virtual)) throw new Error("Invalid virtual clock start time");
  }

  now(): Date {
    return new Date(this.#virtual + (this.#realNow() - this.#real));
  }
}
