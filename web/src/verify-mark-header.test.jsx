import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, within } from '@testing-library/react';
import App from './App.jsx';
import { mockServer, BASE_ROUTES } from './testApi.js';

// The header shows this lab's own Verified / In progress mark, read from GET /api/shelf (the call ShelfLink makes). Through the lab-proxy that call reaches
// the shelf, whose payload lists every demo with its mark. The lab's own /api/shelf has only { shelfUrl }, so there is no mark when it is opened alone.
const here = path.dirname(fileURLToPath(import.meta.url));
beforeEach(() => { window.location.hash = '#/'; });
afterEach(() => { vi.unstubAllGlobals(); });

const mark = (status, label, extra = {}) => ({ status, label, note: '', updatedAt: '2026-11-15', source: 'shipped', ...extra });
const shelfApp = (shelf) => mockServer({ ...BASE_ROUTES(), 'GET /api/shelf': shelf });

describe('verification mark in the header', () => {
  it("shows this lab's own mark in the top menu, and no other lab's", async () => {
    shelfApp({ shelfUrl: 'http://shelf.example', demos: [
      { id: 'other-lab', verification: mark('in-progress', 'In progress') },
      { id: 'pingone-lab', verification: mark('verified', 'Verified', { note: 'Every card run on the mock' }) },
    ] });
    render(<App />);
    const bar = within(await screen.findByTestId('top-menu'));
    expect(await bar.findByText('Verified')).toBeInTheDocument();
    expect(bar.queryByText('In progress')).toBeNull();
    expect(document.querySelectorAll('.verify')).toHaveLength(1);
    expect(bar.getByText('Verified').closest('.verify')).toHaveAttribute('title', expect.stringContaining('Every card run on the mock'));
  });

  it('shows nothing when the lab is opened on its own port (only { shelfUrl }), when the shelf has no mark for it, or when the shelf is unreachable', async () => {
    for (const shelf of [{ shelfUrl: 'http://shelf.example' }, { shelfUrl: 'http://shelf.example', demos: [{ id: 'pingone-lab', verification: null }] },
      { shelfUrl: 'http://shelf.example', demos: [{ id: 'pingone-lab', verification: mark('none', 'None') }] }, { status: 503, body: { error: 'down' } }]) {
      const { calls } = shelfApp(shelf);
      const { unmount } = render(<App />);
      await screen.findByTestId('top-menu');
      await vi.waitFor(() => expect(calls.some((c) => c.path === '/api/shelf')).toBe(true)); // the shelf was asked, and still no badge
      await new Promise((r) => setTimeout(r, 20));
      expect(document.querySelector('.verify')).toBeNull();
      unmount();
    }
  });

  it('is wired in App.jsx for the lab\'s own shelf id, inside the top menu (this check fails if the line is removed)', () => {
    const src = fs.readFileSync(path.join(here, 'App.jsx'), 'utf8');
    const entry = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'docs', 'shelf-entry.json'), 'utf8'));
    expect(entry.id).toBe('pingone-lab');
    expect(src).toMatch(/<TopMenu[\s\S]*<VerifyMark id="pingone-lab" headers=\{[^\n]*currentWorkspace\(\)[^\n]*\} \/>\s*<\/TopMenu>/);
    expect(fs.readFileSync(path.join(here, 'main.jsx'), 'utf8')).toContain("import './components/VerifyMark.css';");
  });
});
