import { describe, expect, it } from 'vitest';
import { buildRoute, createNavigationIntent, toRouteString } from '../src/navigation/router';

describe('navigation', () => {
  it('builds route strings', () => {
    expect(toRouteString(buildRoute('details', 'abc'))).toBe('details:abc');
    expect(buildRoute('search', null, 'all').screen).toBe('search');
  });

  it('builds intents', () => {
    const intent = createNavigationIntent({ screen: 'details', itemId: 'x1', sectionId: 'row-1' }, 'Movie', 'details');
    expect(intent.kind).toBe('details');
    expect(intent.targetId).toBe('x1');
    expect(intent.metadata?.rowId).toBe('row-1');
  });
});
