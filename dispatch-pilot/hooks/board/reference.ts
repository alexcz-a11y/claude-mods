// What the card says of the complexity reading of a message's reference images (#63), in a person's words. The reading is
// recorded as data on the decision (`LogEntry.reference`); this only words it, never reads the images again (ADR 0004).

import { COMPLEXITY_LEVELS } from '../decision/complexity.ts'
import type { ReferenceRecord } from '../core/report.ts'

/**
 * What a person reads of each of the five levels (`COMPLEXITY_LEVELS`, in the same order): its name and what it is. Kept apart from
 * the table the decision model reads (decision/complexity.ts): the model's words are English, a person's are Chinese, and changing
 * one must not touch the other.
 */
const LEVEL_WORDS: readonly { name: string; note: string }[] = [
  { name: '极简单', note: '一个朴素的形状或平面图形，几乎没有细节' },
  { name: '简单', note: '几个朴素的元素、排得简单，细节很少' },
  { name: '中等', note: '数量适中的不同部分，有一些细节或样式' },
  { name: '较复杂', note: '很多不同的部分，细节精细，材质、光照或特效有多层' },
  { name: '很复杂', note: '大量精细的细节，部分很多，或有许多相互作用的效果' },
]

/**
 * The reading in words: `level` ("3/4 较复杂"), what that level is (`note`), how many images it came from, and that it is only a
 * hint (the effort level is still the decision model's, from the whole request).
 */
export function referenceWords(record: ReferenceRecord): { level: string; note: string; images: string; hint: string } {
  const level = LEVEL_WORDS[record.level]
  return {
    level: `${record.level}/${COMPLEXITY_LEVELS.length - 1} ${level?.name ?? ''}`.trim(),
    note: level?.note ?? '',
    images: `来自 ${record.images} 张图`,
    hint: '只作提示，档位仍由决策模型定',
  }
}
