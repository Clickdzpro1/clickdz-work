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
    const result = mergeClickDzModels([model('gpt-5.5', true)]);

    expect(result[0]).toMatchObject({ id: 'gpt-5.5', isDefault: true });
    expect(new Set(result.map(item => item.id))).toEqual(
      new Set([
        'cdz-ultra',
        'cdz-council',
        'cdz-sage',
        'cdz-architect',
        'cdz-scholar',
        'cdz-flash',
        'cdz-polyglot',
        'claude-opus-4-8',
        'gemini-3.1-pro-preview',
        'gpt-5.5',
        'claude-sonnet-4-6',
        'gemini-3.5-flash',
        'gpt-5.4',
        'claude-haiku-4-5',
        'gpt-5.4-mini',
      ])
    );
  });

  it('defaults to cdz-ultra when the provider gives no default', () => {
    const result = mergeClickDzModels([]);
    expect(result.find(item => item.isDefault)?.id).toBe('cdz-ultra');
  });
});
