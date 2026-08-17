import { describe, expect, it } from 'vitest';

import { type AIModel, mergeClickDzModels } from './models';

const model = (id: string, isDefault = false): AIModel => ({
  id,
  name: id,
  version: id,
  category: 'Test',
  isPro: false,
  isDefault,
});

describe('mergeClickDzModels', () => {
  it('preserves provider models and restores every missing ClickDz model', () => {
    const result = mergeClickDzModels([model('some-provider-model', true)]);

    expect(result[0]).toMatchObject({ id: 'some-provider-model', isDefault: true });
    // The single curated Gateway model is always present alongside whatever
    // the server returned.
    expect(new Set(result.map(item => item.id))).toEqual(
      new Set(['some-provider-model', 'alibaba/qwen3.7-flash'])
    );
  });

  it('defaults to the Gateway chat model when the provider gives no default', () => {
    const result = mergeClickDzModels([]);
    expect(result.find(item => item.isDefault)?.id).toBe(
      'alibaba/qwen3.7-flash'
    );
  });
});
