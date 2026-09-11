import { describe, it, expect } from 'vitest';
import { headingFromBreadcrumb } from '../../src/ui/open-note';

describe('headingFromBreadcrumb', () => {
  it('returns undefined for a title-only breadcrumb (intro/no-heading match)', () => {
    expect(headingFromBreadcrumb('My Note')).toBeUndefined();
  });

  it('returns undefined for an empty breadcrumb', () => {
    expect(headingFromBreadcrumb('')).toBeUndefined();
  });

  it('returns the heading for a title + one heading breadcrumb', () => {
    expect(headingFromBreadcrumb('My Note > H1')).toBe('H1');
  });

  it('returns the last segment for a title + two headings breadcrumb', () => {
    expect(headingFromBreadcrumb('My Note > H1 > H2')).toBe('H2');
  });

  it('returns the last segment for a deeper trail (3+ headings)', () => {
    expect(headingFromBreadcrumb('My Note > H1 > H2 > H3')).toBe('H3');
  });
});
