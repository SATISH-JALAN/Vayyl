export interface WitnessCalculator {
  calculateWitness(input: Record<string, unknown>, sanityCheck?: boolean): Promise<bigint[]>;
}

declare const builder: (code: ArrayBuffer | Uint8Array, options?: unknown) => Promise<WitnessCalculator>;

export default builder;
