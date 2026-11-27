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

  it('strips a leading heading written with Windows line endings', () => {
    expect(extractPreview('---\r\ntags: [secret]\r\n---\r\n\r\n# Title\r\nVisible body.')).toBe(
      'Visible body.',
    );
    expect(extractPreview('# Title\r\n')).toBe('');
    expect(extractPreview('Visible body.\r\nSecond line.')).toBe('Visible body. Second line.');
  });

  it('leaves a body that merely contains a rule', () => {
    expect(extractPreview('Intro\n---\nmore')).toBe('Intro --- more');
  });

  it('keeps a leading horizontal rule that is not frontmatter', () => {
    expect(extractPreview('---\nA paragraph after a horizontal rule.')).toBe(
      '--- A paragraph after a horizontal rule.',
    );
  });

  it('strips empty frontmatter before the body', () => {
    expect(extractPreview('---\n---\nbody')).toBe('body');
  });

  it('strips empty frontmatter written with Windows line endings', () => {
    expect(extractPreview('---\r\n---\r\nbody')).toBe('body');
  });

  it('strips empty frontmatter with no body', () => {
    expect(extractPreview('---\n---')).toBe('');
  });

  it('truncates to 140 characters', () => {
    expect(extractPreview('x'.repeat(300))).toHaveLength(140);
  });
});
