import { describe, it, expect } from 'vitest';
import { needsConsent } from '../../src/ui/consent-modal';

describe('needsConsent', () => {
  it('never for localhost', () => {
    expect(needsConsent('http://localhost:11434/v1', [])).toBe(false);
  });
  it('true for a remote host not yet consented, false once consented', () => {
    expect(needsConsent('https://api.openai.com/v1', [])).toBe(true);
    expect(needsConsent('https://api.openai.com/v1', ['api.openai.com'])).toBe(false);
  });
});
