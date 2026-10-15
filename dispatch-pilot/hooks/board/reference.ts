// What the card says of the complexity reading of a message's reference images (#63), in a person's words. The reading is
// recorded as data on the decision (`LogEntry.reference`); this only words it, never reads the images again (ADR 0004).

import { COMPLEXITY_LEVELS } from '../decision/complexity.ts'
import type { ReferenceRecord } from '../core/report.ts'

/**
 * The reading in words: `level` ("3/4 较复杂"), what that level is (`note`), how many images it came from, and that it is only a
 * hint (the effort level is still the decision model's, from the whole request).
 */
export function referenceWords(record: ReferenceRecord): { level: string; note: string; images: string; hint: string } {
  const level = COMPLEXITY_LEVELS[record.level]
  return {
    level: `${record.level}/${COMPLEXITY_LEVELS.length - 1} ${level?.zh.name ?? ''}`.trim(),
    note: level?.zh.note ?? '',
    images: `来自 ${record.images} 张图`,
    hint: '只作提示，档位仍由决策模型定',
  }
}
