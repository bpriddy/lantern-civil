// Hand-written client code. Civil generates the typed boundary client at
// src/civil/client.ts on every transpile (docs/boundary-type-sync.md); this file
// imports it. Change a boundary io schema and the types below move with it — a drift
// between this call and the backend becomes a type error here, not a runtime surprise.
import { classify, type ClassifyInput } from './civil/client';

export async function run(input: ClassifyInput) {
  const record = await classify(input);
  // record is typed from the boundary's output schema: record.category is the
  // schema's enum, record.confidence a number — autocompleted, checked at build.
  console.log(`${record.category} (${record.confidence})`);
  return record;
}
