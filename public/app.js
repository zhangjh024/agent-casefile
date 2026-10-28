import {
  validateCasefile,
  replayCasefile,
  redactCasefile,
  privacyFindings,
  serializeCasefile,
} from '/lib/index.js';

// JSON-only, in-memory inspection. No code from a casefile is executed.
const $ = (id) => document.getElementById(id);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const state = {
  casefile: null,
  report: null,
  selected: 0,
  preview: null,
  revision: 0,
  load: 0,
};
const eventNames = {
  'model.request': 'Model request',
  'model.response': 'Model response',
  'tool.call': 'Tool call',
  'tool.result': 'Tool result',
  'run.end': 'Run ended',
};
const statusNames = {
  pass: 'All checks pass',
  fail: 'Expectation failed',
  inconclusive: 'Inconclusive evidence',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function setText(id, value) {
  $(id).textContent = String(value);
}
function formatTime(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms % 1000 ? 2 : 0)} s`;
}
function addMetadata(list, label, value, className) {
  const group = el('div', className);
  group.append(el('dt', '', label), el('dd', '', value));
  list.append(group);
}
function announce(message) {
  setText('notice', message);
  $('notice').hidden = false;
}
function clearError() {
  $('load-error').hidden = true;
}
function showError(error, diagnostics = []) {
  clearError();
  $('notice').hidden = true;
  setText('error-message', error instanceof Error ? error.message : String(error));
  $('error-details').replaceChildren();
  diagnostics
    .slice(0, 8)
    .forEach((item) =>
      $('error-details').append(el('li', '', `${item.path || '/'}: ${item.message}`)),
    );
  if (diagnostics.length > 8)
    $('error-details').append(
      el('li', '', `And ${diagnostics.length - 8} more validation problems.`),
    );
  $('load-error').hidden = false;
  if (!state.casefile) $('empty-state').hidden = false;
}
function setTab(name, focus = false) {
  for (const candidate of ['evidence', 'privacy']) {
    const active = candidate === name;
    const tab = $(`${candidate}-tab`);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.classList.toggle('active', active);
    $(`${candidate}-panel`).hidden = !active;
  }
  if (focus) $(`${name}-tab`).focus();
}
function invalidatePreview() {
  state.preview = null;
  $('download-redacted').disabled = true;
  $('preview-content').hidden = true;
  $('preview-placeholder').hidden = false;
  $('preview-json').textContent = '';
  $('redaction-error').hidden = true;
}
function drawTimeline() {
  $('timeline').replaceChildren();
  state.casefile.events.forEach((event, index) => {
    const item = el('li');
    const button = el('button', 'event-button');
    button.type = 'button';
    button.setAttribute('aria-current', String(index === state.selected));
    button.setAttribute(
      'aria-label',
      `${eventNames[event.kind]}, ${formatTime(event.atMs)}, ${event.id}`,
    );
    const category = event.kind.split('.')[0];
    button.append(
      el(
        'span',
        `event-marker ${category === 'run' ? 'end' : category}`,
        category === 'model' ? 'M' : category === 'tool' ? 'T' : '■',
      ),
    );
    const labels = el('span', 'event-labels');
    labels.append(
      el('span', 'event-type', eventNames[event.kind]),
      el('span', 'event-subtitle', event.name || event.callId || event.outcome || event.id),
      el('span', 'event-time', `+ ${formatTime(event.atMs)}`),
    );
    button.append(labels);
    button.addEventListener('click', () => selectEvent(index));
    item.append(button);
    $('timeline').append(item);
  });
  if (!state.casefile.events.length)
    $('timeline').append(el('li', 'section-copy', 'No recorded events.'));
}
function selectEvent(index) {
  state.selected = index;
  const event = state.casefile.events[index];
  for (const [i, button] of [...$('timeline').querySelectorAll('button')].entries())
    button.setAttribute('aria-current', String(i === index));
  $('event-metadata').replaceChildren();
  if (!event) {
    setText('event-title', 'No event selected');
    setText('event-data', 'No boundary data was recorded.');
    $('event-outcome').hidden = true;
    return;
  }
  setText('event-title', eventNames[event.kind]);
  addMetadata($('event-metadata'), 'Event ID', event.id);
  addMetadata($('event-metadata'), 'At', formatTime(event.atMs));
  if (event.callId) addMetadata($('event-metadata'), 'Call ID', event.callId);
  if (event.name) addMetadata($('event-metadata'), 'Tool', event.name);
  $('event-outcome').hidden = !event.outcome;
  if (event.outcome) {
    setText('event-outcome', event.outcome);
    $('event-outcome').className = `badge ${event.outcome === 'success' ? 'pass' : 'fail'}`;
  }
  setText('event-data', JSON.stringify(event.data, null, 2));
}
function drawAssertions() {
  const { report, casefile } = state;
  $('assertion-list').replaceChildren();
  setText(
    'assertion-summary',
    `${report.counts.pass} pass · ${report.counts.fail} fail · ${report.counts.inconclusive} inconclusive`,
  );
  report.assertions.forEach((result) => {
    const spec = casefile.assertions.find((item) => item.id === result.id);
    const row = el('div', 'assertion');
    const icon = el(
      'span',
      `assertion-icon ${result.status}`,
      result.status === 'pass' ? '✓' : result.status === 'fail' ? '×' : '?',
    );
    icon.setAttribute('aria-hidden', 'true');
    const content = el('div', 'assertion-content');
    content.append(
      el('p', 'assertion-title', spec?.description || result.id),
      el('p', 'assertion-message', result.message),
      el('p', 'assertion-meta', `${result.id} · ${result.kind}`),
    );
    row.append(icon, content, el('span', `assertion-status ${result.status}`, result.status));
    $('assertion-list').append(row);
  });
  if (!report.assertions.length)
    $('assertion-list').append(
      el(
        'p',
        'section-copy',
        'No assertions were recorded. Add explicit expectations before treating this as a regression case.',
      ),
    );
}
function drawContext(validation) {
  const { casefile, report } = state;
  const context = $('context-metadata');
  context.replaceChildren();
  addMetadata(context, 'Runtime', casefile.environment.runtime);
  if (casefile.environment.framework)
    addMetadata(
      context,
      'Framework',
      `${casefile.environment.framework.name} ${casefile.environment.framework.version}`,
    );
  if (casefile.environment.model)
    addMetadata(
      context,
      'Model',
      `${casefile.environment.model.provider} / ${casefile.environment.model.name}`,
    );
  addMetadata(
    context,
    'Recorded at',
    casefile.createdAt
      .replace('T', ' ')
      .replace(/\.000Z$/, ' UTC')
      .replace(/Z$/, ' UTC'),
  );
  addMetadata(
    context,
    'Provenance',
    casefile.provenance.kind === 'synthetic'
      ? 'Synthetic data, not a verified live-system capture.'
      : 'User-supplied recording. Provenance is a declaration, not independently verified.',
  );
  if (casefile.provenance.source)
    addMetadata(context, 'Source', casefile.provenance.source, 'context-wide');
  if (casefile.provenance.notes)
    addMetadata(context, 'Notes', casefile.provenance.notes, 'context-wide');
  const diagnostics = new Map();
  [...validation.diagnostics, ...report.diagnostics].forEach((item) =>
    diagnostics.set(`${item.code}:${item.path}:${item.message}`, item),
  );
  $('diagnostics').replaceChildren();
  for (const item of diagnostics.values()) {
    const node = el('li', '', item.message);
    if (item.path) node.append(el('span', 'mono small', ` (${item.path})`));
    $('diagnostics').append(node);
  }
  if (!diagnostics.size)
    $('diagnostics').append(
      el(
        'li',
        'good',
        'No structural or completeness warnings detected. This is not proof that every real-world boundary was captured.',
      ),
    );
  for (const missing of casefile.capture.missing)
    $('diagnostics').append(el('li', '', `Declared missing: ${missing}`));
}
function drawPrivacy() {
  let findings;
  try {
    findings = privacyFindings(state.casefile);
  } catch (error) {
    setText('privacy-count', '!');
    setText('findings-total', '—');
    $('privacy-findings').replaceChildren(
      el(
        'li',
        'small muted',
        error instanceof Error
          ? error.message
          : 'The privacy scan could not complete. Do not share this recording without a manual review.',
      ),
    );
    return;
  }
  setText('privacy-count', findings.length);
  setText('findings-total', findings.length);
  $('privacy-findings').replaceChildren();
  findings.forEach((finding) => {
    const item = el('li');
    item.append(
      el('code', 'finding-path', finding.pointer),
      el('span', 'finding-reason', finding.reason),
    );
    $('privacy-findings').append(item);
  });
  if (!findings.length)
    $('privacy-findings').append(
      el(
        'li',
        'small muted',
        'No common patterns detected. Private prompts, names, URLs, or business data may still be present.',
      ),
    );
}
function openCasefile(input, label, shouldAnnounce = true) {
  const validation = validateCasefile(input);
  if (!validation.valid) {
    showError(
      'This file is not a valid version 1.0 Agent Casefile. The previous casefile, if any, has not changed.',
      validation.diagnostics,
    );
    return false;
  }
  const candidate = validation.casefile || input;
  // Evaluate before replacing the view, so a failed load cannot mix two recordings.
  const report = replayCasefile(candidate);
  state.casefile = candidate;
  state.report = report;
  state.selected = 0;
  state.revision += 1;
  clearError();
  $('empty-state').hidden = true;
  $('case-workspace').hidden = false;
  $('custom-pointers').value = '';
  invalidatePreview();
  setText('case-title', candidate.title);
  setText(
    'case-description',
    candidate.description ||
      'No description supplied. Inspect the recorded boundaries and explicit assertions below.',
  );
  setText('case-id', candidate.id);
  setText(
    'provenance-badge',
    candidate.provenance.kind === 'synthetic' ? 'Synthetic example' : 'Recorded evidence',
  );
  $('provenance-badge').className = `badge ${candidate.provenance.kind}`;
  setText('overall-status', statusNames[report.status]);
  $('overall-status').className = `outcome ${report.status}`;
  setText('metric-events', candidate.events.length);
  setText('metric-assertions', candidate.assertions.length);
  const lastAt = candidate.events.reduce((maximum, event) => Math.max(maximum, event.atMs), 0);
  setText('metric-duration', candidate.events.length ? formatTime(lastAt) : '—');
  setText('metric-capture', candidate.capture.status);
  setText('evidence-count', candidate.events.length);
  drawTimeline();
  selectEvent(0);
  drawAssertions();
  drawContext(validation);
  drawPrivacy();
  setTab('evidence');
  document.title = `${candidate.title} — Agent Casefile`;
  if (shouldAnnounce)
    announce(
      `${label} loaded locally. ${statusNames[report.status]}. No model or tool was called.`,
    );
  return true;
}
async function loadURL(url, label, shouldAnnounce = true) {
  const request = ++state.load;
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok)
      throw new Error(
        `Could not load ${label.toLowerCase()} (HTTP ${response.status}). Choose a local JSON file instead.`,
      );
    const source = await response.text();
    if (source.length > MAX_FILE_BYTES)
      throw new Error('Casefile exceeds the 5 MiB browser inspection limit.');
    const input = JSON.parse(source);
    if (request !== state.load) return;
    openCasefile(input, label, shouldAnnounce);
  } catch (error) {
    if (request === state.load) showError(error);
  }
}

$('open-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const request = ++state.load;
  try {
    if (file.size > MAX_FILE_BYTES)
      throw new Error('Casefile exceeds the 5 MiB browser inspection limit.');
    const input = JSON.parse(await file.text());
    if (request !== state.load) return;
    if (openCasefile(input, 'Your casefile')) $('demo-select').value = '';
  } catch (error) {
    if (request === state.load)
      showError(
        error instanceof SyntaxError
          ? new Error(
              'This file could not be parsed as JSON. The previous casefile has not changed.',
            )
          : error,
      );
  } finally {
    event.target.value = '';
  }
});
$('demo-select').addEventListener('change', (event) => {
  const examples = {
    'tool-timeout': 'Tool timeout / stuck UI example',
    'tool-timeout-fixed': 'Corrected recording example',
  };
  const selected = event.target.value;
  if (Object.hasOwn(examples, selected))
    loadURL(`/examples/${selected}.casefile.json`, examples[selected]);
});
$('dismiss-error').addEventListener('click', clearError);
for (const name of ['evidence', 'privacy']) {
  $(`${name}-tab`).addEventListener('click', () => setTab(name));
  $(`${name}-tab`).addEventListener('keydown', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setTab(
        event.key === 'Home'
          ? 'evidence'
          : event.key === 'End'
            ? 'privacy'
            : name === 'evidence'
              ? 'privacy'
              : 'evidence',
        true,
      );
    }
  });
}
$('custom-pointers').addEventListener('input', invalidatePreview);
$('preview-redaction').addEventListener('click', () => {
  if (!state.casefile) return;
  invalidatePreview();
  try {
    const pointers = [
      ...new Set(
        $('custom-pointers')
          .value.split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    const result = redactCasefile(state.casefile, { pointers });
    const report = replayCasefile(result.casefile);
    state.preview = serializeCasefile(result.casefile);
    setText('preview-json', state.preview);
    const count = result.findings.length;
    setText(
      'preview-summary',
      `${count} redaction finding${count === 1 ? '' : 's'}. Preview checks: ${report.counts.pass} pass, ${report.counts.fail} fail, ${report.counts.inconclusive} inconclusive. Review this whole copy before sharing.`,
    );
    $('preview-content').hidden = false;
    $('preview-placeholder').hidden = true;
    $('download-redacted').disabled = false;
  } catch (error) {
    setText('redaction-error', error instanceof Error ? error.message : String(error));
    $('redaction-error').hidden = false;
  }
});
$('download-redacted').addEventListener('click', () => {
  if (!state.preview || !state.casefile) return;
  const blob = new Blob([state.preview], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = el('a');
  anchor.href = url;
  const safeId = state.casefile.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'casefile';
  anchor.download = `${safeId}.redacted.casefile.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce(
    'Redacted copy downloaded. Detection is best-effort: review the file before sharing it. Your original recording is unchanged.',
  );
});

loadURL('/casefile.json', 'Startup casefile', false);
