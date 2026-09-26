const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      let html = readFileSync(resolve(__dirname, '../src/ui.html'), 'utf8');
      html = html.replace('__TOKEN__', '""');
      // Disable startup/network only; exercise the real render and request code.
      html = html.slice(0, html.lastIndexOf('  loadProjects(function ()')) + `
      window.fixture = { render: function(st) { current = 'session'; renderState(st, viewGen); }, following: function(v) { stick = v; if (v) userScrollUntil = 0; prevTop = scroller.scrollTop; }, requests: renderRequests, status: showStatus };
      </script></body></html>`;
      html = html.replace(/<script src=[^>]+><\/script>/g, '');
      await page.route('http://fixture/**', route => route.request().url() === 'http://fixture/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
      await page.goto('http://fixture/');
      const result = await page.evaluate(async () => {
        const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const messages = Array.from({ length: 45 }, (_, i) => ({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', time: Date.now(), segments: [{ type: 'text', text: ('Message ' + i + ' content. ').repeat(20) }], attachments: [], cost: 0.001, recordedCost: 0.001, durationMs: 1000, running: false, model: 'p/m', tokens: { input: 20, output: 10, cacheRead: 0 } }));
        messages[1] = { ...messages[1], durationMs: 2500, segments: [
          { id: 'progress', type: 'text', text: 'I will inspect the renderer first.' },
          { id: 'reasoning', type: 'thinking', text: 'The activity should be grouped by turn.', durationMs: 700 },
          { id: 'tool', type: 'tool', name: 'exec_command', title: 'npm test', status: 'completed', detail: 'tests passed' },
          { id: 'final', type: 'text', text: 'The final response stays visible.' },
        ] };
        messages[43] = { ...messages[43], durationMs: 2500, segments: [
          { id: 'progress-last', type: 'text', text: 'I will inspect `renderState` first.' },
          { id: 'reasoning-last', type: 'thinking', text: 'Keep the disclosure anchored while it expands. '.repeat(20), durationMs: 700 },
          { id: 'tool-last', type: 'tool', name: 'exec_command', title: 'run test', status: 'completed', detail: 'const passed = true;\n// fixture output\nreturn passed;' },
          { id: 'final-last', type: 'text', text: 'The final response remains below.' },
        ] };
        const state = { messages, status: 'idle', attention: [], usage: null };
        fixture.render(state); await frame();
        const firstTurn = document.querySelector('[data-mid="turn:m0"]');
        const activityText = firstTurn.querySelector('.activity-body').textContent;
        const finalText = firstTurn.querySelector('.turn-final').textContent;
        const grouped = activityText.includes('I will inspect') && activityText.includes('Ran commands') && activityText.includes('tests passed')
          && !activityText.includes('final response') && finalText.includes('final response') && !finalText.includes('I will inspect');
        const scroller = document.querySelector('#scroller');
        scroller.scrollTop = scroller.scrollHeight;
        fixture.following(true);
        const lastTurn = document.querySelector('[data-mid="turn:m42"]');
        lastTurn.querySelector('.activity > summary').click();
        await frame();
        const pinnedOffset = lastTurn.querySelector('.activity').getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
        const pinned = Math.abs(pinnedOffset) < 2;
        const highlighted = lastTurn.querySelectorAll('.syn-keyword, .syn-comment').length >= 3;
        const original = document.querySelector('[data-mid="m20"]');
        scroller.scrollTop = original.offsetTop - 80; fixture.following(false); await frame();
        const top = original.getBoundingClientRect().top;
        messages.push({ ...messages[44], id: 'm45' });
        messages[1] = { ...messages[1], segments: [{ type: 'text', text: 'Expanded previous message. '.repeat(400) }] };
        fixture.render(state); await frame();
        const delta = original.getBoundingClientRect().top - top;
        const identity = original === document.querySelector('[data-mid="m20"]');
        fixture.following(true); fixture.render(state); await frame();
        const bottomGap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        fixture.requests([{ kind: 'question', id: 'q', sessionID: 'session', session: 'Fixture', title: 'Choose', questions: [{ question: 'First', options: [{ label: 'A' }, { label: 'B' }], multiple: true }, { question: 'Second', options: [] }] }]);
        const requestArea = document.querySelector('#requests');
        const requestsBounded = requestArea.closest('footer') !== null && requestArea.scrollHeight >= requestArea.clientHeight;
        const custom = document.querySelector('.qcard fieldset:last-of-type input'); custom.value = 'Draft';
        fixture.requests([{ kind: 'question', id: 'q' }]);
        const composerInput = document.querySelector('#input');
        const composerFits = composerInput.clientWidth >= 220 && composerInput.placeholder === 'Message or command…';
        fixture.status('retry', 'Reconnecting…');
        const statusVisible = getComputedStyle(document.querySelector('#status')).display !== 'none';
        const rootStyle = getComputedStyle(document.documentElement);
        const palette = [rootStyle.getPropertyValue('--response-text').trim(), rootStyle.getPropertyValue('--response-heading').trim(), rootStyle.getPropertyValue('--activity-thought').trim()];
        return { delta, identity, bottomGap, draft: custom.value, sameInput: custom.isConnected, grouped, pinned, pinnedOffset, readingRoom: getComputedStyle(document.querySelector('#msgs')).getPropertyValue('--reading-room'), scrollTop: scroller.scrollTop, scrollMax: scroller.scrollHeight - scroller.clientHeight, highlighted, composerFits, requestsBounded, statusVisible, palette };
      });
      console.log(viewport.width, result);
      assert(result.grouped, 'assistant activity and final response must be separated by turn');
      assert(result.pinned, 'opening activity must pin its header in view instead of following the bottom');
      assert(result.highlighted, 'tool code must receive lightweight syntax highlighting');
      assert(result.identity, 'message element must stay mounted');
      assert(Math.abs(result.delta) < 2, 'reading anchor moved: ' + JSON.stringify(result));
      assert(result.bottomGap < 2, 'follow mode must stay at bottom');
      assert(result.sameInput && result.draft === 'Draft', 'question draft must survive refresh');
      assert(result.composerFits, 'composer input must retain readable placeholder space');
      assert(result.requestsBounded, 'attention requests must remain inside the bounded composer area');
      assert(result.statusVisible, 'retry and connection status must be visible');
      assert.deepEqual(result.palette, ['#cfd5da', '#79baff', '#c3cbd2'], 'transcript readability palette changed');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: resolve(__dirname, `../../.cache/remote-${viewport.width}.png`) });
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
