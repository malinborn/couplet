import { describe, it, expect } from 'vitest';
import { findCodeLanguage, FILENAME_LANGUAGE, isShellConfig, MARKDOWN_EXTENSIONS, isMarkdownBuffer } from './file-language';

describe('isShellConfig', () => {
  it('returns true for .zshrc', () => {
    expect(isShellConfig('.zshrc')).toBe(true);
  });

  it('returns true for .bashrc', () => {
    expect(isShellConfig('.bashrc')).toBe(true);
  });

  it('returns true for .profile', () => {
    expect(isShellConfig('.profile')).toBe(true);
  });

  it('returns true for .bash_profile', () => {
    expect(isShellConfig('.bash_profile')).toBe(true);
  });

  it('returns false for foo.py', () => {
    expect(isShellConfig('foo.py')).toBe(false);
  });

  it('returns false for .env', () => {
    expect(isShellConfig('.env')).toBe(false);
  });

  it('returns false for .gitignore', () => {
    expect(isShellConfig('.gitignore')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isShellConfig('.ZSHRC')).toBe(true);
  });
});

describe('findCodeLanguage', () => {
  describe('extensionless shell config dotfiles', () => {
    it.each(Object.keys(FILENAME_LANGUAGE))('every mapped dotfile %s resolves to a real descriptor', (file) => {
      const lang = findCodeLanguage(file, file.replace(/^\./, ''));
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe(FILENAME_LANGUAGE[file]);
    });

    it('resolves .zshrc to Shell', () => {
      const lang = findCodeLanguage('.zshrc', 'zshrc');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });

    it('resolves .bashrc to Shell', () => {
      const lang = findCodeLanguage('.bashrc', 'bashrc');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });

    it('resolves .bash_profile to Shell', () => {
      const lang = findCodeLanguage('.bash_profile', 'bash_profile');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });

    it('resolves .profile to Shell', () => {
      const lang = findCodeLanguage('.profile', 'profile');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });

    it('resolves .zshenv to Shell', () => {
      const lang = findCodeLanguage('.zshenv', 'zshenv');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });

    it('resolves .zprofile to Shell', () => {
      const lang = findCodeLanguage('.zprofile', 'zprofile');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });

    it('resolves .aliases to Shell', () => {
      const lang = findCodeLanguage('.aliases', 'aliases');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });

    it('resolves .functions to Shell', () => {
      const lang = findCodeLanguage('.functions', 'functions');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });

    it('is case-insensitive for basename', () => {
      const lang = findCodeLanguage('.ZSHRC', 'ZSHRC');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });
  });

  describe('extension fallback', () => {
    it('resolves Python by extension', () => {
      const lang = findCodeLanguage('foo.py', 'py');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Python');
    });

    it('resolves Rust by extension', () => {
      const lang = findCodeLanguage('foo.rs', 'rs');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Rust');
    });

    it('resolves Shell by .sh extension', () => {
      const lang = findCodeLanguage('deploy.sh', 'sh');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });

    it('resolves Shell by .bash extension', () => {
      const lang = findCodeLanguage('script.bash', 'bash');
      expect(lang).not.toBeNull();
      expect(lang?.name).toBe('Shell');
    });

    it('returns null for unknown extension', () => {
      const lang = findCodeLanguage('mystery.xyz', 'xyz');
      expect(lang).toBeNull();
    });

    it('does NOT match non-shell dotfiles (allowlist only)', () => {
      // .gitignore/.dockerignore/.editorconfig deliberately stay plain text
      expect(findCodeLanguage('.gitignore', 'gitignore')).toBeNull();
      expect(findCodeLanguage('.dockerignore', 'dockerignore')).toBeNull();
      expect(findCodeLanguage('.editorconfig', 'editorconfig')).toBeNull();
    });

    it('returns null for an extensionless file with empty ext', () => {
      // bare basename, no dot → ext '' must not match any language
      expect(findCodeLanguage('makefile', '')).toBeNull();
    });

    it('resolves Markdown by extension', () => {
      const lang = findCodeLanguage('notes.md', 'md');
      // language-data includes Markdown; main point is extension path works
      expect(lang).not.toBeNull();
    });
  });
});

/**
 * `isMarkdownBuffer` exists for one caller that cannot afford to be wrong: the
 * JSON formatter decides from it whether it may write a ```json fence, and a
 * ``` line in a `.py` or `.cs` buffer is a syntax error inserted into the
 * user's source (#47).
 */
describe('isMarkdownBuffer', () => {
  describe('markdown-flavoured — these get a fence', () => {
    it('an untitled buffer', () => {
      expect(isMarkdownBuffer(null)).toBe(true);
      expect(isMarkdownBuffer(undefined)).toBe(true);
      expect(isMarkdownBuffer('')).toBe(true);
    });

    it('.md and .markdown', () => {
      expect(isMarkdownBuffer('/Users/me/notes.md')).toBe(true);
      expect(isMarkdownBuffer('/Users/me/notes.markdown')).toBe(true);
    });

    it('.txt, which md-mini also opens with live preview', () => {
      expect(isMarkdownBuffer('/Users/me/notes.txt')).toBe(true);
    });

    it('is case-insensitive about the extension', () => {
      expect(isMarkdownBuffer('/Users/me/NOTES.MD')).toBe(true);
    });

    it('a bare filename with no directory', () => {
      expect(isMarkdownBuffer('notes.md')).toBe(true);
    });
  });

  describe('code buffers — these never get a fence', () => {
    const codeFiles = [
      '/Users/me/data.json',
      '/Users/me/script.py',
      '/Users/me/Program.cs',
      '/Users/me/deploy.sh',
      '/Users/me/main.rs',
      '/Users/me/app.ts',
      '/Users/me/style.css',
      '/Users/me/config.yml',
      '/Users/me/index.html',
    ];

    for (const path of codeFiles) {
      it(path, () => {
        expect(isMarkdownBuffer(path)).toBe(false);
      });
    }

    it('a shell config dotfile, which has no extension but is not markdown', () => {
      expect(isMarkdownBuffer('/Users/me/.zshrc')).toBe(false);
      expect(isMarkdownBuffer('/Users/me/.bashrc')).toBe(false);
    });

    it('env files, which open in their own masking mode', () => {
      expect(isMarkdownBuffer('/Users/me/.env')).toBe(false);
      expect(isMarkdownBuffer('/Users/me/.env.local')).toBe(false);
      expect(isMarkdownBuffer('/Users/me/prod.env')).toBe(false);
    });

    it('a file with no extension at all', () => {
      // `path.split('.').pop()` returns the whole path here, which is in no
      // extension set — the same answer App.svelte's branch gives.
      expect(isMarkdownBuffer('/Users/me/README')).toBe(false);
    });
  });

  describe('agrees with App.svelte\'s open-file branch', () => {
    /**
     * A transcription of that branch, kept here so a change to either side
     * shows up as a failure rather than as a buffer that renders one way and
     * formats another. Keep in step with `handleOpen` in App.svelte.
     */
    function appSvelteBranch(path: string): 'env' | 'code' | 'markdown' {
      const basename = path.split('/').pop()?.toLowerCase() ?? '';
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const isEnvFile = basename.startsWith('.env') || ext === 'env';
      if (isEnvFile) return 'env';
      if (!MARKDOWN_EXTENSIONS.has(ext)) return 'code';
      return 'markdown';
    }

    const paths = [
      '/Users/me/notes.md',
      '/Users/me/notes.markdown',
      '/Users/me/notes.txt',
      '/Users/me/data.json',
      '/Users/me/script.py',
      '/Users/me/Program.cs',
      '/Users/me/deploy.sh',
      '/Users/me/.zshrc',
      '/Users/me/.env',
      '/Users/me/.env.local',
      '/Users/me/README',
      'notes.md',
    ];

    for (const path of paths) {
      it(path, () => {
        expect(isMarkdownBuffer(path)).toBe(appSvelteBranch(path) === 'markdown');
      });
    }
  });
});
