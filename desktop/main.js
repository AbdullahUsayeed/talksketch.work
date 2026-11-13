const { app, BrowserWindow, session, shell, ipcMain, webContents, desktopCapturer } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
app.userAgentFallback = UA;

const MCP_PORT = 3333;
const captions = [];
let mainWindow;

function addCaption(line) {
  const text = String(line?.text ?? '').trim().slice(0, 1000);
  if (!text) return;
  captions.push({ speaker: String(line?.speaker ?? 'Participant').slice(0, 80), text, ts: Date.now() });
  if (captions.length > 2000) captions.splice(0, captions.length - 2000);
}

function transcriptText(seconds = 120) {
  const since = Date.now() - Math.max(5, seconds) * 1000;
  return captions
    .filter((line) => line.ts >= since)
    .map((line) => `[${new Date(line.ts).toISOString().slice(11, 19)}] ${line.speaker}: ${line.text}`)
    .join('\n');
}

function meetContents() {
  return webContents.getAllWebContents().filter((wc) => wc.getURL().includes('meet.google.com'));
}

async function meetExec(code) {
  const targets = meetContents();
  if (targets.length === 0) throw new Error('No Google Meet page is open.');
  return targets[0].executeJavaScript(code, true);
}

function buildSendChat(message) {
  const payload = JSON.stringify(message);
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const findButton = (re) => [...document.querySelectorAll('button')].find((b) => re.test((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')));
    let input = q('textarea[aria-label*="Send a message" i]') || q('div[contenteditable="true"][aria-label*="message" i]') || q('div[contenteditable="true"]');
    if (!input) {
      const chat = findButton(/chat with everyone|^chat$/i);
      if (chat) chat.click();
      await sleep(800);
      input = q('textarea[aria-label*="Send a message" i]') || q('div[contenteditable="true"][aria-label*="message" i]') || q('div[contenteditable="true"]');
    }
    if (!input) return { ok: false, reason: 'chat input not found' };
    input.focus();
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${payload});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('insertText', false, ${payload});
    }
    await sleep(200);
    const send = findButton(/^send/i) || findButton(/send message/i);
    if (send) send.click();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return { ok: true };
  })()`;
}

function buildReadChat() {
  return `(() => {
    const panel = document.querySelector('[role="log"]');
    if (panel) return panel.innerText.slice(-4000);
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => /chat/i.test(d.getAttribute('aria-label') || ''));
    return dialog ? dialog.innerText.slice(-4000) : '';
  })()`;
}

function speak(text) {
  const ps = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      'Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak([Console]::In.ReadToEnd())',
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  ps.stdin.end(text);
}

function serveDir(root, port) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.json': 'application/json',
  };

  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(root, pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  server.listen(port, '127.0.0.1');
}

function servePanel() {
  serveDir(path.join(__dirname, 'panel-dist'), 3344);
  serveDir(path.join(__dirname, 'renderer'), 3345);
}

async function startMcp() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { z } = await import('zod');

  const server = new McpServer({ name: 'talksketch', version: '0.1.0' });

  server.registerTool(
    'get_recent_captions',
    {
      description: 'Return the last N seconds of Google Meet captions with speaker labels.',
      inputSchema: { seconds: z.number().int().min(5).max(3600).default(120) },
    },
    async ({ seconds }) => ({
      content: [{ type: 'text', text: transcriptText(seconds) || 'No captions captured yet.' }],
    }),
  );

  server.registerTool(
    'send_meet_chat',
    {
      description: 'Send a message into the Google Meet chat.',
      inputSchema: { message: z.string().min(1).max(1000) },
    },
    async ({ message }) => {
      try {
        const result = await meetExec(buildSendChat(message));
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_meet_chat',
    { description: 'Read the visible Google Meet chat panel.', inputSchema: {} },
    async () => {
      try {
        const text = await meetExec(buildReadChat());
        return { content: [{ type: 'text', text: text || 'Chat is closed or empty.' }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'speak_in_meeting',
    {
      description:
        'Speak text through the system voice. To be heard in Meet, route output to VB-Cable and select it as the microphone.',
      inputSchema: { text: z.string().min(1).max(1000) },
    },
    async ({ text }) => {
      speak(text);
      return {
        content: [
          {
            type: 'text',
            text: 'Speaking locally. For the call: set the default playback to CABLE Input and the Meet microphone to CABLE Output.',
          },
        ],
      };
    },
  );

  server.registerResource(
    'live-transcript',
    'meet://transcript/live',
    { mimeType: 'text/plain', description: 'Rolling Google Meet captions with speaker labels.' },
    async (uri) => ({ contents: [{ uri: uri.href, text: transcriptText(3600) || 'No captions captured yet.' }] }),
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/mcp')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, mcp-protocol-version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
        return;
      }
    }
    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(MCP_PORT, '127.0.0.1', () => {
    console.log(`[mcp] http://127.0.0.1:${MCP_PORT}/mcp`);
  });
}

function allowMedia(ses) {
  const allowed = new Set(['media', 'audioCapture', 'videoCapture', 'notifications', 'clipboard-read']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  ses.setUserAgent(UA);
}

function allowSystemAudio(ses) {
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: sources[0], audio: 'loopback' });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0f1115',
    title: 'TalkSketch',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL('http://localhost:3345/index.html');

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.on('caption', (_event, line) => addCaption(line));

function whisperPaths() {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'whisper')
    : path.join(__dirname, 'whisper-runtime');
  return {
    root,
    cli: path.join(root, 'whisper-cli.exe'),
    model: path.join(root, 'models', 'ggml-base.en.bin'),
  };
}

function writeWav(file, pcm) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function parseWhisper(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !line.startsWith('whisper_') &&
        !line.startsWith('system_info') &&
        !line.startsWith('ggml_') &&
        !line.startsWith('load_') &&
        !line.startsWith('main:') &&
        !line.startsWith('error') &&
        !line.startsWith('warning'),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let sttQueue = Promise.resolve();

function enqueueStt(sender, payload) {
  sttQueue = sttQueue
    .then(() => runLocalStt(sender, payload))
    .catch((error) => console.error('[whisper]', error));
}

async function runLocalStt(sender, payload) {
  const { speaker, pcm } = payload ?? {};
  if (!pcm) return;
  const buffer = Buffer.from(pcm);
  if (buffer.length < 32000) return;

  const { root, cli, model } = whisperPaths();
  if (!fs.existsSync(cli) || !fs.existsSync(model)) {
    sender.send('transcript', { speaker, error: 'Local Whisper runtime is missing.' });
    return;
  }

  const tmp = path.join(app.getPath('temp'), `talksketch-${randomUUID()}.wav`);
  writeWav(tmp, buffer);

  await new Promise((resolve) => {
    const child = spawn(cli, ['-m', model, '-f', tmp, '-nt', '-l', 'en', '-t', '4'], {
      cwd: root,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (error) => {
      fs.unlink(tmp, () => undefined);
      sender.send('transcript', { speaker, error: error.message });
      resolve();
    });
    child.on('close', () => {
      fs.unlink(tmp, () => undefined);
      const text = parseWhisper(out);
      sender.send('transcript', {
        speaker,
        text,
        ...(text ? {} : { error: err.slice(-200) || 'No speech detected.' }),
      });
      resolve();
    });
  });
}

ipcMain.handle('local-stt', () => {
  const { cli, model } = whisperPaths();
  return fs.existsSync(cli) && fs.existsSync(model);
});

ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

ipcMain.on('audio-chunk', (event, payload) => enqueueStt(event.sender, payload));

app.whenReady().then(async () => {
  allowMedia(session.defaultSession);
  allowMedia(session.fromPartition('persist:meet'));
  allowSystemAudio(session.defaultSession);
  servePanel();
  createWindow();

  try {
    await startMcp();
  } catch (error) {
    console.error('[mcp] failed to start', error);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
