import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { mockServer, BASE_ROUTES, CARDS, ISSUER } from "./testApi.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Rule 19 Mock/Real toggle", () => {
  it("an incomplete live configuration: Real is disabled with the server's reason and clicking it does nothing", async () => {
    let switched = false;
    const server = mockServer({
      ...BASE_ROUTES(),
      'GET /api/config': () => ({ body: { customer: { name: 'PingOne Lab' }, issuer: null, mode: 'mock', source: 'mock', realAvailable: false, realReason: 'Real (live) is not available: the live settings are incomplete. Set the PingOne environment id and every client id and secret on the Settings page.' } }),
      'PUT /api/mode': () => { switched = true; return { status: 409, body: { error: 'real_not_available', message: 'Real (live) is not available.' } }; },
    });
    render(<App />);
    await waitFor(() => expect(server.calls.some((c) => c.path === '/api/config')).toBe(true), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId('mode-select').querySelector('option[value="real"]')).toBeDisabled(), { timeout: 3000 });
    expect(screen.getByTestId('mode-select').querySelector('option[value="real"]').getAttribute('title')).toMatch(/Settings page/);
    await userEvent.selectOptions(screen.getByTestId('mode-select'), 'real');
    expect(switched).toBe(false, 'a disabled Real option never reaches the server');
    expect(screen.getByTestId('mode-select')).toHaveValue('mock');
  });

  it('a loaded info stays in sync after a switch: the pressed button follows /api/info', async () => {
    let source = 'real';
    mockServer({
      ...BASE_ROUTES(),
      'GET /api/config': () => ({ body: { customer: { name: 'PingOne Lab' }, issuer: ISSUER, mode: source === 'real' ? 'live' : 'mock', source, realAvailable: true, realReason: null } }),
      'GET /api/info': () => ({ body: { source, realAvailable: true, realReason: null, mode: source === 'real' ? 'live' : 'mock' } }),
      'PUT /api/mode': (body) => { source = body.mode === 'real' ? 'real' : 'mock'; return { body: { mode: source === 'real' ? 'live' : 'mock', source } }; },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('mode-select')).toHaveValue('real'), { timeout: 3000 });
    await userEvent.selectOptions(screen.getByTestId('mode-select'), 'mock');
    await waitFor(() => expect(screen.getByTestId('mode-select')).toHaveValue('mock'));
  });
});
