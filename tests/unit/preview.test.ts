import { describe, it, expect } from 'vitest';
import { extractPreview } from '../../src/ui/preview';

describe('extractPreview', () => {
  it('strips LF frontmatter and a leading heading', () => {
    expect(extractPreview('---\ntags: [secret]\n---\n\n# Title\nVisible body.')).toBe('Visible body.');
  });

  it('strips frontmatter written with Windows line endings', () => {
    expect(extractPreview('---\r\ntags: [secret]\r\n---\r\n\r\nVisible body after frontmatter.'))
      .toBe('Visible body after frontmatter.');
  });

  it('leaves a body that merely contains a rule', () => {
    expect(extractPreview('Intro\n---\nmore')).toBe('Intro --- more');
  });

  it('truncates to 140 characters', () => {
    expect(extractPreview('x'.repeat(300))).toHaveLength(140);
  });
});
