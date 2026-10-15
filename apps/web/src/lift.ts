import type { LiftAnalysis, LiftInterpretation, LiftRunProgress, LiftUnit } from './project.js';

/**
 * Reading the repository, said in words (docs/lift-repo.md). Pure, so the strings
 * the author sees — and an agent transcript will repeat — are tested rather than
 * assembled inline in a component.
 */

const STAGE_WORDS: Record<LiftRunProgress['stage'], string> = {
  listing: 'Listing the repository',
  reading: 'Reading the code',
  analysing: 'Analysts are reading it area by area',
  refining: 'Weighing what they found',
  writing: 'Writing the civil/ documents',
  done: 'Finishing',
};

/** The stage in words, with "analysing 5 of 12 areas" while analysts are at work. */
export function liftProgressText(progress: LiftRunProgress | null): string {
  if (!progress) return 'Starting to read the repository…';
  const stage = STAGE_WORDS[progress.stage] ?? 'Reading the repository';
  if (progress.stage === 'analysing' && progress.areasTotal !== null && progress.areasTotal > 0) {
    const done = Math.min(progress.areasDone ?? 0, progress.areasTotal);
    return `${stage} — analysing ${done} of ${progress.areasTotal} area${progress.areasTotal === 1 ? '' : 's'}`;
  }
  return stage;
}

/** How far through the areas, 0..1, or null when the number of areas is not known. */
export function liftProgressFraction(progress: LiftRunProgress | null): number | null {
  if (!progress || progress.areasTotal === null || progress.areasTotal <= 0) return null;
  // Past the analysts, every area is done whatever the last count said.
  if (progress.stage === 'refining' || progress.stage === 'writing' || progress.stage === 'done') return 1;
  return Math.max(0, Math.min(1, (progress.areasDone ?? 0) / progress.areasTotal));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The agent stage's line in the result note: areas read against areas reused, and
 * how many claims were not believed. Null when there is nothing to say.
 */
export function liftAnalysisNote(analysis: LiftAnalysis | undefined): string | null {
  if (!analysis) return null;
  const parts: string[] = [];
  if (analysis.areas > 0) {
    const cached = Math.min(analysis.cachedAreas ?? 0, analysis.areas);
    parts.push(
      `${plural(analysis.areas, 'area')} read` +
        (cached > 0 ? `, ${cached} unchanged since the last read` : ''),
    );
  }
  const disbelieved = analysis.disbelieved.length;
  if (disbelieved > 0) {
    parts.push(
      analysis.claims > 0
        ? `${disbelieved} of ${plural(analysis.claims, 'claim')} not believed`
        : `${plural(disbelieved, 'claim')} not believed`,
    );
  } else if (analysis.claims > 0) {
    parts.push(`all ${plural(analysis.claims, 'claim')} believed`);
  }
  const line = parts.length > 0 ? `${parts.join('; ')}.` : null;
  return [line, analysis.note].filter(Boolean).join(' ') || null;
}

/** One plain sentence for a unit's confidence (docs/lift-repo.md, "Weighing"). */
export function confidenceSentence(
  confidence: NonNullable<LiftUnit['confidence']>,
  voices?: string[],
): string {
  switch (confidence) {
    case 'high':
      // High is either the reader with sound evidence, or two independent voices.
      return voices && voices.length > 0 && !voices.includes('reader')
        ? 'High confidence — independent voices agree'
        : 'High confidence — read directly from the code';
    case 'medium':
      return 'Medium — one analyst found it';
    case 'low':
      return 'Low — contested or the evidence was shaky';
  }
}

const ARTICLE: Record<string, string> = { analyst: 'an analyst', verifier: 'a verifier' };

/**
 * Who supports a unit, in words: "the reader, an analyst, and a verifier". Analysts
 * and verifiers are counted by kind; their areas are detail the inspector can carry
 * in a title. Null when no voice is recorded.
 */
export function voicesSentence(voices: string[] | undefined): string | null {
  if (!voices || voices.length === 0) return null;
  const counts = new Map<string, number>();
  for (const voice of voices) {
    const kind = voice.split(':')[0]!.trim();
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const order = ['reader', 'analyst', 'verifier'];
  const kinds = [...counts.keys()].sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
  );
  const words = kinds.map((kind) => {
    const n = counts.get(kind)!;
    if (kind === 'reader') return 'the reader';
    if (n === 1) return ARTICLE[kind] ?? `a ${kind}`;
    return `${n} ${kind}s`;
  });
  if (words.length === 0) return null;
  if (words.length === 1) return words[0]!;
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
}

/** "path" or "path:line" (or "path:12-20", read as line 12) into its parts. */
export function parseEvidence(item: string): { path: string; line?: number } | null {
  const trimmed = item.trim();
  if (!trimmed) return null;
  const match = /^(.+?):(\d+)(?:-\d+)?$/.exec(trimmed);
  if (match) {
    const line = Number(match[2]);
    return line > 0 ? { path: match[1]!, line } : { path: match[1]! };
  }
  return { path: trimmed };
}

/**
 * The reading's line in the result note (docs/interpretation.md): how many flows and
 * architecture angles were drawn, and where to look. Null when there was no reading.
 */
export function liftInterpretationNote(reading: LiftInterpretation | undefined): string | null {
  if (!reading || (reading.flows === 0 && reading.angles === 0)) return reading?.note ?? null;
  const drawn = [
    reading.flows ? `${plural(reading.flows, 'flow diagram')}` : '',
    reading.angles ? `${plural(reading.angles, 'architecture diagram')}` : '',
  ].filter(Boolean);
  return [`Read how it works and what it is built on: ${drawn.join(' and ')} — switch to Flow or Architecture at the top.`, reading.note]
    .filter(Boolean)
    .join(' ');
}
