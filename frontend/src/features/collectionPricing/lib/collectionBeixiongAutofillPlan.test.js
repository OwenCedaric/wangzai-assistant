import { describe, expect, it } from 'vitest';

import {
  collectionBeixiongDefinitionPhase,
  createCollectionBeixiongPhasePlan,
} from './collectionBeixiongAutofillPlan.js';

describe('collectionBeixiongAutofillPlan', () => {
  it('compiles live Ozon fields into the five North Bear stages', () => {
    const definitions = [
      { id: '1', name: 'Бренд', isDictionary: true },
      { id: '2', name: 'Материал', isDictionary: true, isCollection: true },
      { id: '3', name: 'Вес', valueType: 'Decimal' },
      { id: '4', name: 'Rich Content описание', valueType: 'String' },
      { id: '5', name: 'Поисковые теги', valueType: 'String' },
    ];

    expect(definitions.map(collectionBeixiongDefinitionPhase)).toEqual([
      'structured-title', 'multi-select', 'text-number', 'description', 'tags',
    ]);
    const plan = createCollectionBeixiongPhasePlan({ globalDefinitions: definitions });
    expect(plan.map((item) => item.id)).toEqual([
      'structured-title', 'multi-select', 'text-number', 'description', 'tags',
    ]);
    expect(plan.every((item) => item.globalDefinitions.length === 1)).toBe(true);
  });
});
