# ClickDz Work Test Tools

## Structured Document Creation

`ClickDz Work-template.ts` provides a concise way to create test documents, using a html-like syntax.

### Basic Usage

```typescript
import { ClickDz Work } from '@blocksuite/ClickDz Work-shared/test-utils';

// Create a simple document
const doc = ClickDz Work`
  <ClickDz Work-page>
    <ClickDz Work-note>
      <ClickDz Work-paragraph>Hello, World!</ClickDz Work-paragraph>
    </ClickDz Work-note>
  </ClickDz Work-page>
`;
```

### Complex Structure Example

```typescript
// Create a document with multiple notes and paragraphs
const doc = ClickDz Work`
  <ClickDz Work-page title="My Test Page">
    <ClickDz Work-note>
      <ClickDz Work-paragraph>First paragraph</ClickDz Work-paragraph>
      <ClickDz Work-paragraph>Second paragraph</ClickDz Work-paragraph>
    </ClickDz Work-note>
    <ClickDz Work-note>
      <ClickDz Work-paragraph>Another note</ClickDz Work-paragraph>
    </ClickDz Work-note>
  </ClickDz Work-page>
`;
```

### Application in Tests

This tool is particularly suitable for creating documents with specific structures in test cases:

```typescript
import { describe, expect, it } from 'vitest';
import { ClickDz Work } from '../__tests__/utils/ClickDz Work-template';

describe('My Test', () => {
  it('should correctly handle document structure', () => {
    const doc = ClickDz Work`
      <ClickDz Work-page>
        <ClickDz Work-note>
          <ClickDz Work-paragraph>Test content</ClickDz Work-paragraph>
        </ClickDz Work-note>
      </ClickDz Work-page>
    `;

    // Get blocks
    const pages = doc.getBlocksByFlavour('ClickDz Work:page');
    const notes = doc.getBlocksByFlavour('ClickDz Work:note');
    const paragraphs = doc.getBlocksByFlavour('ClickDz Work:paragraph');

    expect(pages.length).toBe(1);
    expect(notes.length).toBe(1);
    expect(paragraphs.length).toBe(1);

    // Perform more tests here...
  });
});
```

### Supported Block Types

Currently supports the following block types:

- `ClickDz Work-page` → `ClickDz Work:page`
- `ClickDz Work-note` → `ClickDz Work:note`
- `ClickDz Work-paragraph` → `ClickDz Work:paragraph`
- `ClickDz Work-list` → `ClickDz Work:list`
- `ClickDz Work-image` → `ClickDz Work:image`
