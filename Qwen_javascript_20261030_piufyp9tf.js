// ==UserScript==
// @name         Auto Typer — colar texto e digitar automaticamente
// @namespace    https://tampermonkey.net/
// @version      1.0.0
// @description  Cola um texto e digita automaticamente em campos da página, com atraso antes de iniciar.
// @author       você
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const SETTINGS_KEY = 'autotyper-settings-v1';

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveSettings(data) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch {}
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getDeepActiveElement() {
    let el = document.activeElement;
    const seen = new Set();

    while (el && !seen.has(el)) {
      seen.add(el);

      if (el.shadowRoot && el.shadowRoot.activeElement) {
        el = el.shadowRoot.activeElement;
        continue;
      }

      if (el.tagName && el.tagName.toUpperCase() === 'IFRAME') {
        try {
          const doc = el.contentDocument;
          if (doc && doc.activeElement) {
            el = doc.activeElement;
            continue;
          }
        } catch {}
        break;
      }

      break;
    }

    return el;
  }

  function isEditable(el) {
    if (!el || typeof el.tagName !== 'string') return false;
    if (el.disabled || el.readOnly) return false;

    const tag = el.tagName.toUpperCase();

    if (tag === 'TEXTAREA') return true;

    if (tag === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase();
      const textTypes = [
        'text',
        'search',
        'url',
        'email',
        'tel',
        'password',
        'number',
        'date',
        'month',
        'week',
        'time',
        'datetime-local'
      ];
      return textTypes.includes(type);
    }

    return Boolean(el.isContentEditable);
  }

  function isInputLike(el) {
    const tag = el && el.tagName ? el.tagName.toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA';
  }

  function setNativeValue(el, value) {
    try {
      const proto = Object.getPrototypeOf(el);
      const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
        return;
      }
    } catch {}

    el.value = value;
  }

  function dispatchInputEvent(el, data) {
    try {
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const event = new win.InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: data === '\n' ? 'insertParagraph' : 'insertText',
        data: data
      });
      el.dispatchEvent(event);
    } catch {
      try {
        const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
      } catch {}
    }
  }

  function dispatchChangeEvent(el) {
    try {
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
    } catch {}
  }

  function insertIntoInputFallback(el, ch) {
    const value = String(el.value != null ? el.value : '');
    let start = value.length;
    let end = value.length;

    try {
      start = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
      end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
    } catch {}

    const nextValue = value.slice(0, start) + ch + value.slice(end);
    setNativeValue(el, nextValue);

    try {
      const pos = start + ch.length;
      el.setSelectionRange(pos, pos);
    } catch {}

    dispatchInputEvent(el, ch);
  }

  function insertIntoContentEditableFallback(el, ch) {
    const doc = el.ownerDocument || document;

    try {
      const win = doc.defaultView || window;
      const selection = win.getSelection && win.getSelection();

      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();

        if (ch === '\n') {
          const br = doc.createElement('br');
          range.insertNode(br);
          range.setStartAfter(br);
        } else {
          const textNode = doc.createTextNode(ch);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
        }

        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        el.textContent += ch;
      }
    } catch {
      el.textContent += ch;
    }

    dispatchInputEvent(el, ch);
  }

  function insertCharacter(el, ch) {
    const doc = el.ownerDocument || document;

    try {
      el.focus();
    } catch {}

    let inserted = false;

    try {
      if (ch === '\n' && !isInputLike(el)) {
        inserted = doc.execCommand('insertParagraph');
      } else {
        inserted = doc.execCommand('insertText', false, ch);
      }
    } catch {}

    if (inserted) return;

    if (isInputLike(el)) {
      insertIntoInputFallback(el, ch);
    } else {
      insertIntoContentEditableFallback(el, ch);
    }
  }

  function init() {
    if (!document.body) return;
    if (document.getElementById('autotyper-host')) return;

    const host = document.createElement('div');
    host.id = 'autotyper-host';
    host.style.cssText =
      'position:fixed; top:20px; right:20px; z-index:2147483647; display:block; pointer-events:auto;';

    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>
        .panel {
          width: 320px;
          max-width: calc(100vw - 32px);
          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
          font-size: 13px;
          color: #111;
          background: #ffffff;
          border: 1px solid #ccc;
          border-radius: 12px;
          box-shadow: 0 10px 30px rgba(0,0,0,.25);
          overflow: hidden;
          user-select: none;
        }

        .panel textarea,
        .panel input,
        .panel button {
          font-family: inherit;
          font-size: 13px;
        }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          background: #f3f4f6;
          border-bottom: 1px solid #ddd;
          cursor: move;
        }

        .title {
          font-weight: 700;
        }

        .body {
          padding: 12px;
          display: grid;
          gap: 10px;
        }

        label {
          display: grid;
          gap: 4px;
          font-weight: 600;
        }

        textarea {
          width: 100%;
          box-sizing: border-box;
          resize: vertical;
          min-height: 90px;
          padding: 8px;
          border: 1px solid #bbb;
          border-radius: 8px;
        }

        .row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }

        input[type="number"] {
          width: 100%;
          box-sizing: border-box;
          padding: 7px 8px;
          border: 1px solid #bbb;
          border-radius: 8px;
        }

        .checkbox {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 500;
        }

        .actions {
          display: flex;
          gap: 8px;
        }

        button {
          border: 0;
          border-radius: 8px;
          padding: 9px 12px;
          cursor: pointer;
          background: #2563eb;
          color: #fff;
          font-weight: 700;
        }

        button.secondary {
          background: #e5e7eb;
          color: #111;
        }

        button.danger {
          background: #dc2626;
        }

        button:disabled {
          opacity: .55;
          cursor: not-allowed;
        }

        .status {
          min-height: 18px;
          color: #374151;
          line-height: 1.35;
        }

        .hidden {
          display: none !important;
        }
      </style>

      <div class="panel">
        <div class="header" id="dragHandle">
          <div class="title">Auto Typer</div>
          <button type="button" id="toggleBtn" class="secondary" title="Minimizar/expandir">—</button>
        </div>

        <div class="body" id="mainBody">
          <label>
            Texto para digitar
            <textarea id="textInput" placeholder="Cole ou digite o texto aqui..."></textarea>
          </label>

          <div class="row">
            <label>
              Atraso antes de iniciar (s)
              <input id="delayInput" type="number" min="0" step="1" value="5">
            </label>
            <label>
              Intervalo entre letras (ms)
              <input id="speedInput" type="number" min="0" step="10" value="60">
            </label>
          </div>

          <label class="checkbox">
            <input id="randomCheck" type="checkbox">
            Variação aleatória (mais humano)
          </label>

          <div class="actions">
            <button type="button" id="startBtn">Iniciar</button>
            <button type="button" id="stopBtn" class="danger" disabled>Parar</button>
            <button type="button" id="clearBtn" class="secondary">Limpar</button>
          </div>

          <div class="status" id="status">Pronto. Cole o texto, clique em Iniciar e depois clique no campo onde deseja digitar.</div>
        </div>
      </div>
    `;

    document.body.appendChild(host);

    const $ = (selector) => root.querySelector(selector);
    const dragHandle = $('#dragHandle');
    const textInput = $('#textInput');
    const delayInput = $('#delayInput');
    const speedInput = $('#speedInput');
    const randomCheck = $('#randomCheck');
    const startBtn = $('#startBtn');
    const stopBtn = $('#stopBtn');
    const clearBtn = $('#clearBtn');
    const statusEl = $('#status');
    const toggleBtn = $('#toggleBtn');
    const mainBody = $('#mainBody');

    let typing = false;
    let cancelRequested = false;

    const saved = loadSettings();

    if (saved.delay != null) delayInput.value = String(saved.delay);
    if (saved.speed != null) speedInput.value = String(saved.speed);
    if (saved.random != null) randomCheck.checked = Boolean(saved.random);

    if (saved.position && (saved.position.left || saved.position.top)) {
      const left = Math.max(
        0,
        Math.min(window.innerWidth - 60, parseInt(saved.position.left, 10) || 0)
      );
      const top = Math.max(
        0,
        Math.min(window.innerHeight - 30, parseInt(saved.position.top, 10) || 0)
      );

      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      host.style.right = 'auto';
    }

    if (saved.collapsed) {
      mainBody.classList.add('hidden');
      toggleBtn.textContent = '+';
    }

    function setStatus(text) {
      statusEl.textContent = text;
    }

    function persist() {
      saveSettings({
        delay: delayInput.value,
        speed: speedInput.value,
        random: randomCheck.checked,
        collapsed: mainBody.classList.contains('hidden'),
        position: {
          left: host.style.left || '',
          top: host.style.top || ''
        }
      });
    }

    toggleBtn.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    toggleBtn.addEventListener('click', () => {
      mainBody.classList.toggle('hidden');
      toggleBtn.textContent = mainBody.classList.contains('hidden') ? '+' : '—';
      persist();
    });

    clearBtn.addEventListener('click', () => {
      textInput.value = '';
      setStatus('Texto limpo.');
    });

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    dragHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;

      dragging = true;
      const rect = host.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      host.style.right = 'auto';
      event.preventDefault();
    });

    window.addEventListener('pointermove', (event) => {
      if (!dragging) return;

      const left = Math.max(
        0,
        Math.min(window.innerWidth - 60, event.clientX - offsetX)
      );
      const top = Math.max(
        0,
        Math.min(window.innerHeight - 30, event.clientY - offsetY)
      );

      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
    });

    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      persist();
    });

    function getWaitTime(baseMs) {
      if (!randomCheck.checked) return baseMs;

      if (baseMs <= 0) {
        return Math.random() < 0.25 ? 20 : 0;
      }

      const variance = Math.max(15, Math.round(baseMs * 0.45));
      const random = Math.floor(Math.random() * (variance * 2 + 1)) - variance;
      return Math.max(0, baseMs + random);
    }

    function finish(message) {
      typing = false;
      cancelRequested = false;
      startBtn.disabled = false;
      stopBtn.disabled = true;
      setStatus(message);
    }

    async function start() {
      if (typing) return;

      const rawText = textInput.value;
      if (!rawText) {
        setStatus('Cole ou digite um texto antes de iniciar.');
        return;
      }

      const text = rawText.replace(/\r\n/g, '\n');
      const delaySeconds = Math.max(0, parseInt(delayInput.value, 10) || 0);
      const intervalMs = Math.max(0, parseInt(speedInput.value, 10) || 0);

      typing = true;
      cancelRequested = false;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      persist();

      try {
        for (let i = delaySeconds; i > 0; i--) {
          if (cancelRequested) break;
          setStatus(`Clique no campo onde deseja digitar. Começa em ${i} segundo(s)...`);
          await sleep(1000);
        }

        if (cancelRequested) {
          finish('Cancelado.');
          return;
        }

        const target = getDeepActiveElement();

        if (!isEditable(target)) {
          finish('Não encontrei um campo editável. Clique em uma caixa de texto e tente novamente.');
          return;
        }

        setStatus('Digitando...');

        const chars = Array.from(text);

        for (let i = 0; i < chars.length; i++) {
          if (cancelRequested) break;

          if (target.isConnected === false) {
            finish('O campo selecionado foi removido da página.');
            return;
          }

          insertCharacter(target, chars[i]);

          if (i % 10 === 0 || i === chars.length - 1) {
            setStatus(`Digitando ${i + 1}/${chars.length}...`);
          }

          const wait = getWaitTime(intervalMs);
          if (wait > 0) await sleep(wait);
          else await sleep(0);
        }

        if (!cancelRequested) {
          dispatchChangeEvent(target);
          finish('Texto digitado.');
        } else {
          finish('Parado.');
        }
      } catch (error) {
        finish(`Erro: ${error && error.message ? error.message : String(error)}`);
      }
    }

    startBtn.addEventListener('click', start);

    stopBtn.addEventListener('click', () => {
      cancelRequested = true;
      stopBtn.disabled = true;
      setStatus('Parando...');
    });

    [delayInput, speedInput, randomCheck].forEach((el) => {
      el.addEventListener('change', persist);
    });
  }

  if (document.body) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();