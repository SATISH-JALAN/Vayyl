// Ambient type for the circom-generated witness calculator (vendored from
// circuits/build/*/witness_calculator.js). Builder compiles the wasm and
// returns a calculator whose calculateWitness returns the full witness vector.
declare module './witness_calculator.js' {
  export interface WitnessCalculator {
    calculateWitness(input: Record<string, unknown>, sanityCheck?: boolean): Promise<bigint[]>;
  }
  const builder: (code: ArrayBuffer | Uint8Array, options?: unknown) => Promise<WitnessCalculator>;
  export default builder;
}
