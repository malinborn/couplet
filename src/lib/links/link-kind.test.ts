import { describe, it, expect } from 'vitest';
import { opensAsDocument } from './link-kind';

describe('opensAsDocument', () => {
  it.each([
    '/p/plan.md',
    '/p/PLAN.MARKDOWN',
    '/p/notes.txt',
    '/p/data.csv',
    '/p/data.tsv',
    '/p/.env',
    '/p/.env.local',
    '/p/prod.env',
    '/p/.zshrc',
    '/p/main.py',
    '/p/config.json',
    '/p/run.sh',
    '/p/page.html',
  ])('%s opens as a document', (path) => {
    expect(opensAsDocument(path)).toBe(true);
  });

  it.each([
    '/p/diagram.png',
    '/p/spec.pdf',
    '/p/run.command',
    '/p/Couplet.app',
    '/p/archive.zip',
    '/p/LICENSE',
    '/p/folder',
  ])('%s is shown in Finder instead', (path) => {
    expect(opensAsDocument(path)).toBe(false);
  });
});
