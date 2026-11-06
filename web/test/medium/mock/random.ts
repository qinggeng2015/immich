export class SeededRandom {
  constructor(private seed: number) {}

  next() {
    this.seed = (this.seed * 1_664_525 + 1_013_904_223) % 2_147_483_647;
    return this.seed / 2_147_483_647;
  }

  nextInt(min: number, max: number) {
    return Math.floor(this.next() * (max - min)) + min;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from an empty list');
    }
    return items[this.nextInt(0, items.length)];
  }

  pickMany<T>(items: readonly T[], count: number): T[] {
    if (count > items.length) {
      throw new Error(`Cannot pick ${count} items from a list of ${items.length}`);
    }
    const indexes = new Set<number>();
    while (indexes.size < count) {
      indexes.add(this.nextInt(0, items.length));
    }
    return [...indexes].map((index) => items[index]);
  }
}
